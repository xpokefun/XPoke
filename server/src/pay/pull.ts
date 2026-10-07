/**
 * Wager allowances: a player approves XPoke (the pool wallet) as a delegate on their linked wallet's
 * $XPOKE account, up to an amount they choose. When a wager they are in is accepted, XPoke moves exactly
 * that side's unique payment amount from their account into the pool. The payment watcher then sees it as
 * that side's payment and everything else (matching, battle, payout, burn, refunds) runs unchanged.
 *
 * Rules, enforced here:
 * - a pull exists only for a side of a wager its trainer made or accepted on X (created in acceptWager);
 * - it takes exactly the wager's stake, once (one row per wager side; signed before sending), and the watcher
 *   recognises it by its signature (pulls.sig), not by a unique amount;
 * - only from the trainer's linked wallet at acceptance (signed proof of ownership);
 * - only while the wager is awaiting payment, that side is unpaid, and the window has time left;
 * - if the allowance, balance or approval is not there, the side is left to pay by hand as before.
 */
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, createTransferCheckedInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'
import { type DB, now } from '../db.ts'
import type { Config } from '../config.ts'
import { MIN_SOL_LAMPORTS, RpcError, resolveToken, type Sol } from './solana.ts'
import { TOKEN_DECIMALS } from './amounts.ts'

type Pull = {
  id: number
  wager_id: number
  side: 'a' | 'b'
  owner: string
  amount: string
  status: string
  raw_tx: string | null
  sig: string | null
  last_valid: number | null
}

type TokenAcct = {
  value: { data: { parsed: { info: { delegate?: string; delegatedAmount?: { amount: string }; tokenAmount: { amount: string }; state: string } } } } | null
}

/** What an owner's $XPOKE account allows XPoke to take right now. */
export async function allowanceOf(s: Sol, owner: string): Promise<{ account: string; exists: boolean; balance: bigint; allowance: bigint; frozen: boolean }> {
  await resolveToken(s)
  const account = getAssociatedTokenAddressSync(new PublicKey(s.mint), new PublicKey(owner), true, s.tokenProgram!).toBase58()
  const r = await s.rpc.call<TokenAcct>('getAccountInfo', [account, { encoding: 'jsonParsed', commitment: 'confirmed' }])
  if (!r.value) return { account, exists: false, balance: 0n, allowance: 0n, frozen: false }
  const info = r.value.data.parsed.info
  const ours = info.delegate === s.pool
  return {
    account,
    exists: true,
    balance: BigInt(info.tokenAmount.amount),
    allowance: ours ? BigInt(info.delegatedAmount?.amount ?? '0') : 0n,
    frozen: info.state === 'frozen',
  }
}

function sideOpen(db: DB, p: Pull): { ok: boolean; why?: string } {
  const w = db.prepare('select status, pay_deadline, paid_a_tx, paid_b_tx, amount from wagers where id = ?').get(p.wager_id) as
    | { status: string; pay_deadline: number; paid_a_tx: string | null; paid_b_tx: string | null; amount: string }
    | undefined
  if (!w || w.status !== 'awaiting_payment') return { ok: false, why: 'wager no longer awaiting payment' }
  if ((p.side === 'a' ? w.paid_a_tx : w.paid_b_tx) !== null) return { ok: false, why: 'side already paid' }
  if (w.amount !== p.amount) return { ok: false, why: 'amount changed' }
  if (w.pay_deadline - now() < 30_000) return { ok: false, why: 'too close to the payment deadline' }
  return { ok: true }
}

function mark(db: DB, p: Pull, status: string, error: string | null, extra: Partial<Pick<Pull, 'raw_tx' | 'sig' | 'last_valid'>> = {}) {
  db.prepare('update pulls set status = ?, error = ?, raw_tx = ?, sig = ?, last_valid = ?, updated_at = ? where id = ?').run(
    status,
    error,
    extra.raw_tx ?? (status === 'pending' ? null : p.raw_tx),
    extra.sig ?? (status === 'pending' ? null : p.sig),
    extra.last_valid ?? (status === 'pending' ? null : p.last_valid),
    now(),
    p.id,
  )
}

/** One step of the pull queue. @returns true if it did something (call again soon). */
export async function pullOnce(db: DB, cfg: Config, s: Sol): Promise<boolean> {
  if (!s.keypair || !s.mint) return false
  await resolveToken(s)

  // 1) one already signed: landed, failed, in flight, or expired
  const signed = db.prepare("select * from pulls where status = 'signed' order by id limit 1").get() as Pull | undefined
  if (signed) {
    const st = await s.rpc.call<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [[signed.sig], { searchTransactionHistory: true }])
    const v = st.value[0]
    if (v && v.confirmationStatus !== 'processed') {
      mark(db, signed, v.err ? 'failed' : 'confirmed', v.err ? JSON.stringify(v.err).slice(0, 200) : null)
      return true
    }
    const height = await s.rpc.call<number>('getBlockHeight', [{ commitment: 'finalized' }])
    if (!v && signed.last_valid !== null && height > signed.last_valid + 150) {
      // expired, can never land: try again only if the side still needs it
      const open = sideOpen(db, signed)
      mark(db, signed, open.ok ? 'pending' : 'skipped', open.ok ? 'expired, retrying' : `expired; ${open.why}`)
      return true
    }
    await s.rpc.call('sendTransaction', [signed.raw_tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => {})
    return false
  }

  // 2) the next pending one
  const p = db.prepare("select * from pulls where status = 'pending' order by id limit 1").get() as Pull | undefined
  if (!p) return false
  const open = sideOpen(db, p)
  if (!open.ok) {
    mark(db, p, 'skipped', open.why!)
    return true
  }
  // the pool pays the fee: without SOL every pull would be refused and players pushed to manual payment.
  // Wait instead (the window check above skips the pull if it runs out), and health shows it.
  const lamports = await s.rpc.call<{ value: number }>('getBalance', [s.pool, { commitment: 'confirmed' }])
  if (lamports.value < MIN_SOL_LAMPORTS) {
    db.prepare('update pulls set error = ?, updated_at = ? where id = ?').run('pool wallet needs SOL for fees, waiting', now(), p.id)
    return false
  }
  const amount = BigInt(p.amount)
  const a = await allowanceOf(s, p.owner)
  const short = !a.exists ? 'no $XPOKE account in the linked wallet' : a.frozen ? 'token account frozen' : a.allowance < amount ? 'allowance too small (approve more on /wallet)' : a.balance < amount ? 'not enough $XPOKE in the linked wallet' : null
  if (short) {
    mark(db, p, 'skipped', `${short}: pay by hand`)
    return true
  }
  const mint = new PublicKey(s.mint)
  const { value } = await s.rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const msg = new TransactionMessage({
    payerKey: s.keypair.publicKey,
    recentBlockhash: value.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityMicroLamports }),
      // the pool's own token account, in case go-live did not create it (idempotent: free if it exists)
      createAssociatedTokenAccountIdempotentInstruction(s.keypair.publicKey, new PublicKey(s.poolAta), s.keypair.publicKey, mint, s.tokenProgram!),
      // the pool signs as the account's DELEGATE: it can only move what the owner approved
      createTransferCheckedInstruction(new PublicKey(a.account), mint, new PublicKey(s.poolAta), s.keypair.publicKey, amount, TOKEN_DECIMALS, [], s.tokenProgram!),
    ],
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([s.keypair])
  const raw = Buffer.from(tx.serialize()).toString('base64')
  const sig = bs58.encode(tx.signatures[0]!)
  // stored before it is sent: a restart only ever resends these exact bytes
  mark(db, p, 'signed', null, { raw_tx: raw, sig, last_valid: value.lastValidBlockHeight })
  try {
    await s.rpc.call('sendTransaction', [raw, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0 }])
  } catch (e) {
    if (!(e instanceof RpcError)) return false // may have gone through: the signed branch finds out
    db.prepare("update pulls set status = 'skipped', error = ?, updated_at = ? where id = ?").run(`refused: ${(e as Error).message}`.slice(0, 200) + ': pay by hand', now(), p.id)
  }
  return true
}

/** Queue the pulls for a freshly accepted wager: one per side whose trainer has a linked wallet. */
export function queuePulls(db: DB, wagerId: number, sides: { side: 'a' | 'b'; owner: string | null; amount: string }[]): void {
  for (const x of sides) {
    if (!x.owner) continue
    db.prepare("insert or ignore into pulls (wager_id, side, owner, amount, status, created_at, updated_at) values (?,?,?,?,'pending',?,?)").run(
      wagerId,
      x.side,
      x.owner,
      x.amount,
      now(),
      now(),
    )
  }
}

export function sigToString(sig: Uint8Array): string {
  return bs58.encode(sig)
}
