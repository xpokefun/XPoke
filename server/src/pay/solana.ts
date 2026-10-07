/**
 * Solana: watching the pool's $XPOKE token account for payments, and sending payouts, refunds and burns.
 *
 * ⚠ Reads go through raw JSON-RPC, not web3.js's parsers: @solana/web3.js 1.x cannot read version-1
 *   transactions (≈13% of mainnet traffic), and a transfer we cannot read must stop the cursor loudly,
 *   never be skipped. getTransaction asks for a version above any that exists.
 * ⚠ Every RPC call is paced (RPC_RPS): providers limit bursts, not averages.
 * ⚠ publicnode refuses getSignaturesForAddress; use a keyed RPC (Helius etc.) or the official endpoint.
 * ⚠ Every outgoing transaction is signed and stored BEFORE it is sent. A stored one is resent byte-identical
 *   until it lands or its blockhash expires; only after expiry (when it can never land) is it rebuilt.
 * ⚠ The 1% is a real SPL burn: total supply goes down.
 */
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createBurnCheckedInstruction,
  createTransferCheckedInstruction,
  createApproveCheckedInstruction,
  createRevokeInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { type DB, getMeta, now, setMeta } from '../db.ts'
import type { Config } from '../config.ts'
import { handleTransfer } from './match.ts'
import { TOKEN_DECIMALS } from './amounts.ts'

export const EXPLORER = 'https://solscan.io'
export const OFFICIAL_RPC = 'https://api.mainnet-beta.solana.com'
export const MIN_SOL_LAMPORTS = 5_000_000 // 0.005 SOL: keep enough for fees and a recipient's token account rent

/* ------------------------------------------------------------------ paced raw RPC */

/** The RPC answered and refused. Distinct from a network failure, where the request may have gone through. */
export class RpcError extends Error {}

export class Rpc {
  private next = 0
  constructor(
    readonly url: string,
    private readonly rps: number,
  ) {}

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (this.rps > 0) {
      const gap = 1000 / this.rps
      const wait = Math.max(0, this.next - Date.now())
      this.next = Math.max(Date.now(), this.next) + gap
      if (wait) await new Promise((r) => setTimeout(r, wait))
    }
    for (let attempt = 0; ; attempt++) {
      // ⚠ a stalled connection must not hang the chain heartbeat (node's fetch would wait ~5 min)
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      })
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
        continue
      }
      if (!res.ok) throw new Error(`${method}: rpc ${res.status}`)
      const body = (await res.json()) as { result?: T; error?: { message: string } }
      if (body.error) throw new RpcError(`${method}: ${body.error.message}`)
      return body.result as T
    }
  }
}

/* ------------------------------------------------------------------ setup */

export function parseSecret(s: string): Keypair {
  const t = s.trim()
  const bytes = t.startsWith('[') ? Uint8Array.from(JSON.parse(t) as number[]) : bs58.decode(t)
  return Keypair.fromSecretKey(bytes)
}

export function makeSolana(cfg: Config) {
  const rpc = new Rpc(cfg.solanaRpc || OFFICIAL_RPC, cfg.rpcRps)
  const keypair = cfg.poolSecret ? parseSecret(cfg.poolSecret) : null
  const pool = keypair?.publicKey.toBase58() ?? cfg.poolAddress ?? ''
  return { rpc, keypair, pool, mint: cfg.tokenMint, tokenProgram: null as PublicKey | null, poolAta: '' }
}

export type Sol = ReturnType<typeof makeSolana>

export type ChainStatus = {
  enabled: boolean
  pool: string
  poolTokenAccount: string
  token: string
  lastScanAt: number | null
  lastSignature: string | null
  lastError: string | null
  payouts: boolean
}

export const chainStatus: ChainStatus = {
  enabled: false,
  pool: '',
  poolTokenAccount: '',
  token: '',
  lastScanAt: null,
  lastSignature: null,
  lastError: null,
  payouts: false,
}

/** Which token program owns the mint (pump.fun's create_v2 mints are Token-2022), and the pool's ATA. */
export async function resolveToken(s: Sol): Promise<void> {
  if (s.tokenProgram || !s.mint || !s.pool) return
  const info = await s.rpc.call<{ value: { owner: string } | null }>('getAccountInfo', [s.mint, { encoding: 'base64', commitment: 'confirmed' }])
  if (!info.value) throw new Error(`mint ${s.mint} not found`)
  const owner = info.value.owner
  if (owner === TOKEN_2022_PROGRAM_ID.toBase58()) s.tokenProgram = TOKEN_2022_PROGRAM_ID
  else if (owner === TOKEN_PROGRAM_ID.toBase58()) s.tokenProgram = TOKEN_PROGRAM_ID
  else throw new Error(`mint ${s.mint} is owned by ${owner}, not a token program`)
  s.poolAta = getAssociatedTokenAddressSync(new PublicKey(s.mint), new PublicKey(s.pool), true, s.tokenProgram).toBase58()
  chainStatus.poolTokenAccount = s.poolAta
  const supply = await s.rpc.call<{ value: { decimals: number } }>('getTokenSupply', [s.mint, { commitment: 'confirmed' }])
  if (supply.value.decimals !== TOKEN_DECIMALS)
    throw new Error(`mint has ${supply.value.decimals} decimals but TOKEN_DECIMALS is ${TOKEN_DECIMALS}: every amount would be wrong, refusing`)
}

/* ------------------------------------------------------------------ reading payments */

type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
type ParsedTx = {
  slot: number
  meta: { err: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[] } | null
  transaction: { message: { accountKeys: ({ pubkey: string; signer?: boolean } | string)[] } }
}

/**
 * What one transaction paid into the pool's token account, and who paid it.
 * The payer is the owner whose balance of the mint went down the most.
 */
export function incomingOf(tx: ParsedTx, mint: string, poolAta: string, pool = ''): { amount: bigint; from: string } | null {
  if (!tx.meta || tx.meta.err) return null
  const keys = tx.transaction.message.accountKeys.map((k) => (typeof k === 'string' ? k : k.pubkey))
  const bal = (list: TokenBalance[] | undefined, idx: number) =>
    BigInt(list?.find((b) => b.accountIndex === idx && b.mint === mint)?.uiTokenAmount.amount ?? '0')
  const poolIdx = keys.indexOf(poolAta)
  if (poolIdx < 0) return null
  const delta = bal(tx.meta.postTokenBalances, poolIdx) - bal(tx.meta.preTokenBalances, poolIdx)
  if (delta <= 0n) return null
  let from = ''
  let biggest = 0n
  const idxs = new Set([...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])].filter((b) => b.mint === mint).map((b) => b.accountIndex))
  for (const i of idxs) {
    if (i === poolIdx) continue
    const drop = bal(tx.meta.preTokenBalances, i) - bal(tx.meta.postTokenBalances, i)
    const owner = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])].find((b) => b.accountIndex === i)?.owner
    if (drop > biggest && owner) {
      biggest = drop
      from = owner
    }
  }
  // the payout goes back to `from`, so it must be a wallet that can act: the owner that paid if it signed
  // (a swap pays from a vault PDA that never signs), else the fee payer, who always signs
  const signers = new Set(tx.transaction.message.accountKeys.filter((k) => typeof k !== 'string' && k.signer).map((k) => (k as { pubkey: string }).pubkey))
  // ⚠ an allowance pull is signed by the POOL (as the token account's delegate), not by its owner: there the
  // owner whose tokens moved is the payer, which is exactly whose wager side it pays
  const pulledByUs = pool && keys[0] === pool
  const payer = from && (pulledByUs || signers.size === 0 || signers.has(from)) ? from : keys[0]!
  return { amount: delta, from: payer }
}

async function readTx(s: Sol, signature: string): Promise<ParsedTx | null> {
  // ask for a version above any that exists: the RPC answers with what the transaction really is
  return s.rpc.call<ParsedTx | null>('getTransaction', [signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 5, commitment: 'confirmed' }])
}

function record(db: DB, s: Sol, signature: string, tx: ParsedTx): string | null {
  const got = incomingOf(tx, s.mint, s.poolAta, s.pool)
  if (!got || got.from === s.pool) return null
  const r = handleTransfer(db, { txHash: signature, logIndex: 0, from: got.from, amount: got.amount.toString(), block: tx.slot })
  return r?.announce ?? null
}

/**
 * Reads every new signature on the pool's token account, oldest first, and hands each payment to the matcher.
 * The cursor only moves past a signature once it has been read; one that cannot be read stops the scan.
 */
type SigRow = { signature: string; err: unknown; blockTime?: number | null }

/** Scanner state is kept per pool token account, so a different mint never reuses a stale cursor. */
export function key(s: { poolAta: string }, name: 'last_sig' | 'started' | 'backfill'): string {
  return `sol_${name}:${s.poolAta}`
}

/** When this process started (seconds). A first scan never skips a transaction younger than this. */
const STARTED_AT = Math.floor(Date.now() / 1000)

/** One page walk of the pool token account's history, newest first, bounded by `until` and `before`. */
async function fetchSigs(s: Sol, until: string | null, before: string | null, maxPages: number): Promise<{ sigs: SigRow[]; more: boolean }> {
  const sigs: SigRow[] = []
  let cursor = before
  for (let page = 0; page < maxPages; page++) {
    const batch = await s.rpc.call<SigRow[]>('getSignaturesForAddress', [
      s.poolAta,
      { limit: 100, commitment: 'confirmed', ...(until ? { until } : {}), ...(cursor ? { before: cursor } : {}) },
    ])
    sigs.push(...batch)
    if (batch.length < 100) return { sigs, more: false }
    cursor = batch[batch.length - 1]!.signature
  }
  return { sigs, more: true }
}

/** Reads and records a list of signatures, oldest first. Stops (throws) at one that is not readable yet. */
async function processSigs(db: DB, s: Sol, sigs: SigRow[], onDone: (sig: string) => void): Promise<string[]> {
  const announce: string[] = []
  for (const { signature, err } of [...sigs].reverse()) {
    if (!err) {
      const tx = await readTx(s, signature)
      if (!tx) throw new Error(`transaction ${signature} not readable yet`) // retry next tick from here
      const line = record(db, s, signature, tx)
      if (line) announce.push(line)
    }
    onDone(signature)
    chainStatus.lastSignature = signature
  }
  return announce
}

/** Pages of 100 signatures per tick. SCAN_PAGES=1 in tests exercises the backfill path. */
const PAGES_PER_TICK = Math.max(1, Number(process.env.SCAN_PAGES ?? 10))

/**
 * Reads every new signature on the pool's token account and hands each payment to the matcher.
 *
 * - Nothing is skipped: the cursor (`sol_last_sig`) only moves past a signature once it has been read.
 * - A burst bigger than one tick can page (1,000 signatures, e.g. dust spam right after a real payment)
 *   is not lost: the newest page is processed, the cursor moves, and the gap below it is remembered as a
 *   backfill `{before, until}` that later ticks drain page by page.
 * - A first start marks the newest existing signature as history (payments before XPoke are not ours),
 *   unless there is no history at all (a fresh pool with no token account yet): then everything that
 *   arrives from now on is ours, including the very first payment, which is what creates the account.
 */
let scanning: Promise<string[]> | null = null

/** One scan at a time: concurrent callers (background loop, many "Check Payment" clicks) share it. */
export function scanOnce(db: DB, cfg: Config, s: Sol): Promise<string[]> {
  if (!scanning) scanning = scanOnceInner(db, cfg, s).finally(() => (scanning = null))
  return scanning
}

async function scanOnceInner(db: DB, cfg: Config, s: Sol): Promise<string[]> {
  if (!s.mint || !s.pool) return []
  await resolveToken(s)
  const announce: string[] = []

  // 1) drain a remembered gap first
  const backfill = getMeta(db, key(s, 'backfill'))
  if (backfill) {
    const gap = JSON.parse(backfill) as { before: string; until: string | null }
    const { sigs, more } = await fetchSigs(s, gap.until, gap.before, PAGES_PER_TICK)
    let oldest = gap.before
    announce.push(...(await processSigs(db, s, sigs, (sig) => (oldest = sig))))
    if (more) setMeta(db, key(s, 'backfill'), JSON.stringify({ before: oldest, until: gap.until }))
    else setMeta(db, key(s, 'backfill'), '')
  }

  // 2) everything newer than the cursor
  const until = getMeta(db, key(s, 'last_sig')) || null
  const fetched = await fetchSigs(s, until, null, PAGES_PER_TICK)
  const sigs = fetched.sigs
  const more = fetched.more
  if (!until) {
    const started = getMeta(db, key(s, 'started')) === '1'
    if (!sigs.length) {
      // fresh pool: from here on every signature is ours
      setMeta(db, key(s, 'started'), '1')
      chainStatus.lastScanAt = now()
      return announce
    }
    if (!started && !cfg.scanFromStart) {
      // ⚠ only history from BEFORE this server started is skipped. A payment that lands between go-live
      // and the first scan is younger than that and is processed like any other (go-live normally sets the
      // cursor itself, this is the backstop).
      const cutoff = STARTED_AT - 120
      const recent = sigs.filter((x) => (x.blockTime ?? 0) >= cutoff)
      const old = sigs.find((x) => (x.blockTime ?? 0) < cutoff)
      setMeta(db, key(s, 'started'), '1')
      if (!recent.length) {
        setMeta(db, key(s, 'last_sig'), sigs[0]!.signature)
        chainStatus.lastScanAt = now()
        return announce
      }
      // continue below with just the recent ones, oldest first, cursor set to the newest
      sigs.length = 0
      sigs.push(...recent)
      void old
    }
  }
  if (sigs.length) {
    if (more) {
      // the newest pages are in hand; the rest of the burst sits between the old cursor and the oldest fetched
      setMeta(db, key(s, 'backfill'), JSON.stringify({ before: sigs[sigs.length - 1]!.signature, until }))
    }
    // the cursor may only move to the newest fetched signature once everything fetched is processed
    const newest = sigs[0]!.signature
    let processedAll = false
    try {
      announce.push(...(await processSigs(db, s, sigs, () => {})))
      processedAll = true
    } finally {
      if (processedAll) setMeta(db, key(s, 'last_sig'), newest)
      else if (!more) {
        // partially processed (one tx not readable yet): remember the whole batch as a gap and retry
        setMeta(db, key(s, 'backfill'), JSON.stringify({ before: sigs[sigs.length - 1]!.signature, until }))
        setMeta(db, key(s, 'last_sig'), newest)
      }
    }
  }
  chainStatus.lastScanAt = now()
  chainStatus.lastError = null
  return announce
}

/** Reads one signature directly, for the "Check Payment" / "confirm" buttons. */
export async function checkTx(db: DB, _cfg: Config, s: Sol, signature: string): Promise<string[]> {
  await resolveToken(s)
  const tx = await readTx(s, signature)
  if (!tx) throw new Error('that transaction is not confirmed yet, try again in a few seconds')
  const line = record(db, s, signature, tx)
  return line ? [line] : []
}

/* ------------------------------------------------------------------ building a payment for the browser wallet */

/**
 * An unsigned transaction paying `amount` base units from `payer`'s token account into the pool.
 * The wallet signs and sends it; the server never holds the payer's key.
 */
export async function buildPayment(s: Sol, payer: string, amount: bigint): Promise<string> {
  await resolveToken(s)
  const payerKey = new PublicKey(payer)
  const mint = new PublicKey(s.mint)
  const program = s.tokenProgram!
  const source = getAssociatedTokenAddressSync(mint, payerKey, true, program)
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(payerKey, new PublicKey(s.poolAta), new PublicKey(s.pool), mint, program),
    createTransferCheckedInstruction(source, mint, new PublicKey(s.poolAta), payerKey, amount, TOKEN_DECIMALS, [], program),
  ]
  // ⚠ 'finalized': a player's wallet (or its RPC) may simulate at finalized, where a newer blockhash is unknown
  const { value } = await s.rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'finalized' }])
  const msg = new TransactionMessage({ payerKey, recentBlockhash: value.blockhash, instructions: ixs }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

/**
 * Approve (or revoke, amount 0) the pool as delegate on the owner's $XPOKE account: the wager allowance.
 * Built for the owner's wallet to sign; fee paid by the owner. Creates the account if it does not exist.
 */
export async function buildAllowance(s: Sol, owner: string, amount: bigint): Promise<string> {
  await resolveToken(s)
  const ownerKey = new PublicKey(owner)
  const mint = new PublicKey(s.mint)
  const program = s.tokenProgram!
  const account = getAssociatedTokenAddressSync(mint, ownerKey, true, program)
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 50_000 }),
    createAssociatedTokenAccountIdempotentInstruction(ownerKey, account, ownerKey, mint, program),
    amount === 0n
      ? createRevokeInstruction(account, ownerKey, [], program)
      : createApproveCheckedInstruction(account, mint, new PublicKey(s.pool), ownerKey, amount, TOKEN_DECIMALS, [], program),
  ]
  // ⚠ 'finalized': a player's wallet (or its RPC) may simulate at finalized, where a newer blockhash is unknown
  const { value } = await s.rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'finalized' }])
  const msg = new TransactionMessage({ payerKey: ownerKey, recentBlockhash: value.blockhash, instructions: ixs }).compileToV0Message()
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64')
}

/* ------------------------------------------------------------------ sending payouts, refunds, burns */

type LedgerRow = {
  id: number
  kind: string
  ref_kind: string
  ref_id: number
  to_addr: string
  amount: string
  status: string
  tx_hash: string | null
  raw_tx: string | null
  nonce: number | null // last valid block height of the signed transaction
  tries: number | null
}

/**
 * ⛔ The solvency rule, checked before every send: what leaves the pool for one wager (payout + burn +
 * refunds) can never exceed what that wager's players actually paid in, and a refund of a stray transfer
 * can never exceed that transfer. A bug anywhere upstream can at worst park a row as 'held'; it cannot
 * pay out tokens nobody paid in.
 */
export function solvencyProblem(db: DB, row: { kind: string; ref_kind: string; ref_id: number; amount: string; id: number }): string | null {
  const amount = BigInt(row.amount)
  if (row.ref_kind === 'wager') {
    const paidIn = (db.prepare("select amount from ledger where kind = 'payment' and ref_kind = 'wager' and ref_id = ?").all(row.ref_id) as { amount: string }[])
      .reduce((a, r) => a + BigInt(r.amount), 0n)
    const out = (db
      .prepare("select amount from ledger where kind != 'payment' and ref_kind = 'wager' and ref_id = ? and status in ('signed','confirmed') and id != ?")
      .all(row.ref_id, row.id) as { amount: string }[]).reduce((a, r) => a + BigInt(r.amount), 0n)
    if (out + amount > paidIn) return `would pay ${out + amount} out of wager #${row.ref_id} but only ${paidIn} was paid in`
    return null
  }
  if (row.ref_kind === 'transfer') {
    const t = db.prepare('select amount from transfers where rowid = ?').get(row.ref_id) as { amount: string } | undefined
    if (!t) return `refund for unknown transfer row ${row.ref_id}`
    const out = (db
      .prepare("select amount from ledger where kind = 'refund' and ref_kind = 'transfer' and ref_id = ? and status in ('signed','confirmed') and id != ?")
      .all(row.ref_id, row.id) as { amount: string }[]).reduce((a, r) => a + BigInt(r.amount), 0n)
    if (out + amount > BigInt(t.amount)) return `refund would exceed transfer row ${row.ref_id}`
    return null
  }
  if (row.ref_kind === 'order') {
    // a shop burn: never more than that order actually paid in
    const paidIn = (db.prepare("select amount from ledger where kind = 'payment' and ref_kind = 'order' and ref_id = ?").all(row.ref_id) as { amount: string }[])
      .reduce((a, r) => a + BigInt(r.amount), 0n)
    const out = (db
      .prepare("select amount from ledger where kind != 'payment' and ref_kind = 'order' and ref_id = ? and status in ('signed','confirmed') and id != ?")
      .all(row.ref_id, row.id) as { amount: string }[]).reduce((a, r) => a + BigInt(r.amount), 0n)
    if (row.kind !== 'burn') return `order #${row.ref_id}: only burns leave the pool for shop orders`
    if (out + amount > paidIn) return `would burn more than order #${row.ref_id} paid`
    return null
  }
  if (row.ref_kind === 'tournament') {
    const t = db.prepare('select prize_amount, status from tournaments where id = ?').get(row.ref_id) as { prize_amount: string | null; status: string } | undefined
    if (!t?.prize_amount || t.status !== 'done') return `tournament #${row.ref_id} has no finished token prize`
    const out = (db
      .prepare("select amount from ledger where ref_kind = 'tournament' and ref_id = ? and status in ('signed','confirmed') and id != ?")
      .all(row.ref_id, row.id) as { amount: string }[]).reduce((a, r) => a + BigInt(r.amount), 0n)
    if (out + amount > BigInt(t.prize_amount)) return `would pay more than tournament #${row.ref_id}'s prize`
    return null
  }
  return `no payout rule for ${row.ref_kind}`
}

/**
 * Tokens in the pool that belong to someone else right now: payments for wagers still running, and every
 * payout/refund/burn queued or in flight. A prize may only be paid from what is left after these, so a
 * tournament can never be paid with a running wager's escrow.
 */
export function escrowReserved(db: DB, exceptLedgerId: number): bigint {
  let sum = 0n
  for (const w of db.prepare("select paid_a_amount, paid_b_amount from wagers where status = 'awaiting_payment'").all() as {
    paid_a_amount: string | null
    paid_b_amount: string | null
  }[])
    sum += BigInt(w.paid_a_amount ?? 0) + BigInt(w.paid_b_amount ?? 0)
  for (const r of db
    .prepare("select amount from ledger where kind != 'payment' and status in ('pending','signed') and id != ?")
    .all(exceptLedgerId) as { amount: string }[])
    sum += BigInt(r.amount)
  return sum
}

export async function sendOnce(db: DB, cfg: Config, s: Sol): Promise<boolean> {
  chainStatus.payouts = Boolean(cfg.payoutsEnabled && s.keypair) && getMeta(db, 'payouts_paused') !== '1'
  if (!cfg.payoutsEnabled || !s.keypair || !s.mint) return false
  // the operator's pause switch: `npm run admin -- pause-payouts` (resume-payouts)
  if (getMeta(db, 'payouts_paused') === '1') return false
  await resolveToken(s)

  // 1) a signed one first: landed, failed, still in flight, or expired
  const signed = db.prepare("select * from ledger where status = 'signed' order by id limit 1").get() as LedgerRow | undefined
  if (signed) {
    const st = await s.rpc.call<{ value: ({ err: unknown; confirmationStatus: string } | null)[] }>('getSignatureStatuses', [
      [signed.tx_hash],
      { searchTransactionHistory: true },
    ])
    const v = st.value[0]
    if (v && (v.confirmationStatus === 'confirmed' || v.confirmationStatus === 'finalized')) {
      db.prepare('update ledger set status = ?, error = ?, updated_at = ? where id = ?').run(
        v.err ? 'failed' : 'confirmed',
        v.err ? JSON.stringify(v.err).slice(0, 200) : null,
        now(),
        signed.id,
      )
      return true
    }
    // ⚠ finalized height and a wide margin: behind a load balancer one node can report a height past the
    // blockhash's life while another has not yet indexed the landed transaction. Rebuilding then would pay twice.
    const height = await s.rpc.call<number>('getBlockHeight', [{ commitment: 'finalized' }])
    if (!v && signed.nonce !== null && height > signed.nonce + 150) {
      // its blockhash expired, so it can never land: safe to build a new one
      db.prepare("update ledger set status = 'pending', raw_tx = null, tx_hash = null, nonce = null, error = 'expired, rebuilding', updated_at = ? where id = ?").run(now(), signed.id)
      return true
    }
    await s.rpc.call('sendTransaction', [signed.raw_tx, { encoding: 'base64', skipPreflight: true, maxRetries: 0 }]).catch(() => {})
    return false
  }

  // 2) the next queued one
  const row = db.prepare("select * from ledger where status = 'pending' and kind in ('payout','refund','burn') order by ref_kind = 'tournament', id limit 1").get() as LedgerRow | undefined
  if (!row) return false
  const amount = BigInt(row.amount)
  if (amount <= 0n) {
    db.prepare("update ledger set status = 'confirmed', updated_at = ? where id = ?").run(now(), row.id)
    return true
  }
  const insolvent = solvencyProblem(db, row)
  if (insolvent) {
    db.prepare("update ledger set status = 'held', error = ?, updated_at = ? where id = ?").run(insolvent.slice(0, 200), now(), row.id)
    console.error(`[payout] HELD ledger #${row.id}: ${insolvent}`)
    return true
  }
  const poolBal = await s.rpc.call<{ value: { amount: string } }>('getTokenAccountBalance', [s.poolAta, { commitment: 'confirmed' }]).catch(() => ({ value: { amount: '0' } }))
  // a prize is paid only from what is left after everyone else's escrow; wager rows carry their own funding
  const needed = row.ref_kind === 'tournament' ? amount + escrowReserved(db, row.id) : amount
  if (BigInt(poolBal.value.amount) < needed) {
    const why = row.ref_kind === 'tournament' ? 'the pool needs the tournament prize sent to it first, waiting' : 'pool token balance too low, waiting'
    db.prepare('update ledger set error = ?, updated_at = ? where id = ?').run(why, now(), row.id)
    return false
  }
  const lamports = await s.rpc.call<{ value: number }>('getBalance', [s.pool, { commitment: 'confirmed' }])
  if (lamports.value < MIN_SOL_LAMPORTS) {
    db.prepare('update ledger set error = ?, updated_at = ? where id = ?').run('pool wallet needs SOL for fees, waiting', now(), row.id)
    return false
  }

  const owner = s.keypair.publicKey
  const mint = new PublicKey(s.mint)
  const program = s.tokenProgram!
  const poolAta = new PublicKey(s.poolAta)
  const ixs: TransactionInstruction[] = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityMicroLamports }),
  ]
  if (row.kind === 'burn') {
    ixs.push(createBurnCheckedInstruction(poolAta, mint, owner, amount, TOKEN_DECIMALS, [], program))
  } else {
    // a row that cannot be built must not block the queue behind it: mark it and move on
    let to: PublicKey
    try {
      // off-curve owners (multisig vaults such as Squads) are legitimate payers and get their ATA like anyone
      to = new PublicKey(row.to_addr)
    } catch (e) {
      db.prepare("update ledger set status = 'failed', error = ?, updated_at = ? where id = ?").run(
        `cannot pay ${row.to_addr}: ${(e as Error).message}`.slice(0, 200),
        now(),
        row.id,
      )
      return true
    }
    const toAta = getAssociatedTokenAddressSync(mint, to, true, program)
    ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, toAta, to, mint, program))
    ixs.push(createTransferCheckedInstruction(poolAta, mint, toAta, owner, amount, TOKEN_DECIMALS, [], program))
  }
  const { value } = await s.rpc.call<{ value: { blockhash: string; lastValidBlockHeight: number } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: value.blockhash, instructions: ixs }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([s.keypair])
  const raw = Buffer.from(tx.serialize()).toString('base64')
  const sig = bs58.encode(tx.signatures[0]!)
  // stored before it is sent: from here a restart only ever resends these exact bytes
  db.prepare("update ledger set status = 'signed', raw_tx = ?, tx_hash = ?, nonce = ?, error = null, updated_at = ? where id = ? and status = 'pending'").run(
    raw,
    sig,
    value.lastValidBlockHeight,
    now(),
    row.id,
  )
  try {
    await s.rpc.call('sendTransaction', [raw, { encoding: 'base64', preflightCommitment: 'confirmed', maxRetries: 0 }])
  } catch (e) {
    // a network error may still have delivered it: stay 'signed' and let step 1 find out
    if (!(e instanceof RpcError)) return false
    // the RPC refused it in preflight, so it was never forwarded: put it back with the reason, and after
    // three refusals park it as failed so the rows behind it still go out (the operator sees it on /stats)
    const tries = (row.tries ?? 0) + 1
    db.prepare("update ledger set status = ?, raw_tx = null, tx_hash = null, nonce = null, error = ?, tries = ?, updated_at = ? where id = ?").run(
      tries >= 3 ? 'failed' : 'pending',
      (e as Error).message.slice(0, 200),
      tries,
      now(),
      row.id,
    )
    return false
  }
  return true
}

export async function poolBalances(s: Sol): Promise<{ token: string | null; supply: string | null }> {
  if (!s.mint || !s.pool) return { token: null, supply: null }
  await resolveToken(s)
  const [bal, supply] = await Promise.all([
    s.rpc.call<{ value: { amount: string } }>('getTokenAccountBalance', [s.poolAta, { commitment: 'confirmed' }]).catch(() => ({ value: { amount: '0' } })),
    s.rpc.call<{ value: { amount: string } }>('getTokenSupply', [s.mint, { commitment: 'confirmed' }]),
  ])
  return { token: bal.value.amount, supply: supply.value.amount }
}

export function isSignature(s: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(s)
}

export function isAddress(s: string): boolean {
  try {
    return new PublicKey(s).toBase58() === s
  } catch {
    return false
  }
}
