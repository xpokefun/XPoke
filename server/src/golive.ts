/**
 * Launch day, one command: point XPoke at the $XPOKE mint and switch the shop and wagers on.
 *
 *   From the Mac:   deploy/go-ca.sh <MINT>            (or --dry first, or --no-payouts)
 *   On the box:     npm run golive -- <MINT> [--dry] [--no-payouts]
 *
 * Checks, in order, and refuses on any failure:
 *   1. the address is a real mint owned by the Token or Token-2022 program, with 6 decimals
 *   2. the RPC answers the history call the payment watcher needs (getSignaturesForAddress)
 *   3. the pool wallet has enough SOL for fees and token-account rent
 * Then (not with --dry): creates the pool's token account if missing (≈0.002 SOL, paid by the pool),
 * writes TOKEN_MINT (+ PAYOUTS_ENABLED) into .env, restarts xpoke, and waits until the shop reports open.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token'
import { loadConfig } from './config.ts'
import { OFFICIAL_RPC, Rpc, parseSecret, key } from './pay/solana.ts'
import { openDb, setMeta } from './db.ts'
import { TOKEN_DECIMALS } from './pay/amounts.ts'

const args = process.argv.slice(2)
const mint = args.find((a) => !a.startsWith('--')) ?? ''
const dry = args.includes('--dry')
const payouts = !args.includes('--no-payouts')
const cfg = loadConfig()

/** What has been done so far, so a failure says exactly what state things are in. */
const done: string[] = []
function fail(msg: string): never {
  console.error(`\n  ✖ ${msg}`)
  console.error(done.length ? `  already done: ${done.join('; ')}. Fix the cause and run go-ca again (it is safe to repeat).\n` : '  nothing was changed.\n')
  process.exit(1)
}
function ok(msg: string) {
  console.log(`  ✓ ${msg}`)
}

let mintKey: PublicKey
try {
  mintKey = new PublicKey(mint)
  if (mintKey.toBase58() !== mint) throw new Error()
} catch {
  fail(`"${mint}" is not a Solana address. usage: npm run golive -- <MINT> [--dry] [--no-payouts]`)
}
if (!cfg.poolSecret) fail('POOL_SECRET is not set in .env')
if (!cfg.solanaRpc) fail('SOLANA_RPC is not set in .env')
const pool = parseSecret(cfg.poolSecret)
const rpc = new Rpc(cfg.solanaRpc || OFFICIAL_RPC, 0)
console.log(`\n  XPoke go-live${dry ? ' (DRY RUN: nothing will be changed)' : ''}\n  mint ${mint}\n  pool ${pool.publicKey.toBase58()}\n`)

// 1. the mint
const info = await rpc.call<{ value: { owner: string } | null }>('getAccountInfo', [mint, { encoding: 'base64', commitment: 'confirmed' }])
if (!info.value) fail('no account at that address (wrong address, or the token is not created yet)')
const program =
  info.value.owner === TOKEN_2022_PROGRAM_ID.toBase58() ? TOKEN_2022_PROGRAM_ID : info.value.owner === TOKEN_PROGRAM_ID.toBase58() ? TOKEN_PROGRAM_ID : null
if (!program) fail(`that account is owned by ${info.value.owner}, not a token program: it is not a token mint`)
const supply = await rpc.call<{ value: { decimals: number; uiAmountString: string } }>('getTokenSupply', [mint, { commitment: 'confirmed' }])
if (supply.value.decimals !== TOKEN_DECIMALS) fail(`the mint has ${supply.value.decimals} decimals, XPoke is set for ${TOKEN_DECIMALS}`)
ok(`token mint, ${program === TOKEN_2022_PROGRAM_ID ? 'Token-2022' : 'SPL Token'}, ${supply.value.decimals} decimals, supply ${supply.value.uiAmountString}`)

// 1b. the mint's powers and extensions: anything that lets someone else move, freeze or tax the pool's
// tokens, or that breaks plain transfers, makes the escrow unsafe. pump.fun mints carry only metadata.
{
  const parsed = await rpc.call<{ value: { data: { parsed: { info: { freezeAuthority: string | null; mintAuthority: string | null; extensions?: { extension: string; state?: Record<string, unknown> }[] } } } } }>(
    'getAccountInfo',
    [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }],
  )
  const inf = parsed.value.data.parsed.info
  const exts = (inf.extensions ?? []).map((e) => e.extension)
  const SAFE = new Set(['metadataPointer', 'tokenMetadata', 'groupPointer', 'groupMemberPointer', 'tokenGroup', 'tokenGroupMember', 'mintCloseAuthority'])
  const bad = exts.filter((e) => !SAFE.has(e))
  if (bad.length)
    fail(
      `the mint has ${bad.join(', ')}: ` +
        'a transfer fee would make payments arrive short, a transfer hook breaks payouts, a permanent delegate could drain the pool, a default frozen state locks it. ' +
        'XPoke will not run its escrow on this token',
    )
  if (inf.freezeAuthority && !args.includes('--allow-freeze'))
    fail(`the mint has a freeze authority (${inf.freezeAuthority}): it could freeze the pool. pass --allow-freeze only if you trust it`)
  ok(`no transfer fee, hook, delegate or freeze power${exts.length ? ` (extensions: ${exts.join(', ')})` : ''}; mint authority ${inf.mintAuthority ? inf.mintAuthority : 'revoked'}`)
}

// 1c. nothing from an earlier setup is still waiting to be paid out (it would go out in THIS token)
{
  const db = openDb(cfg.dataDir)
  const waiting = (db.prepare("select count(*) as n from ledger where kind != 'payment' and status in ('pending','signed','held','failed')").get() as { n: number }).n
  const prev = (db.prepare("select v from meta where k = 'mint'").get() as { v: string } | undefined)?.v
  db.close()
  if (waiting && prev && prev !== mint) fail(`${waiting} payout(s) from the previous mint ${prev} are still queued: settle or clear them first`)
}

// 2. the RPC can read history (the payment watcher depends on it)
const poolAta = getAssociatedTokenAddressSync(mintKey, pool.publicKey, true, program)
await rpc.call('getSignaturesForAddress', [pool.publicKey.toBase58(), { limit: 1 }]).catch((e) => fail(`the RPC refuses history lookups: ${(e as Error).message}`))
ok('RPC answers history lookups')

// 3. pool SOL
const lamports = (await rpc.call<{ value: number }>('getBalance', [pool.publicKey.toBase58(), { commitment: 'confirmed' }])).value
if (lamports < 10_000_000) fail(`the pool has ${lamports / 1e9} SOL; it needs at least 0.01 (fees + token-account rent)`)
ok(`pool holds ${lamports / 1e9} SOL`)

const ataInfo = await rpc.call<{ value: unknown | null }>('getAccountInfo', [poolAta.toBase58(), { encoding: 'base64', commitment: 'confirmed' }])
console.log(`  · pool token account ${poolAta.toBase58()} ${ataInfo.value ? 'exists' : 'will be created'}`)
console.log(`  · wager payouts will be ${payouts ? 'ON' : 'OFF (--no-payouts)'}`)

if (dry) {
  console.log('\n  dry run complete: everything checks out. Run again without --dry to go live.\n')
  process.exit(0)
}

// create the pool token account up front, so the very first player does not pay its rent
if (!ataInfo.value) {
  const { value } = await rpc.call<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }])
  const msg = new TransactionMessage({
    payerKey: pool.publicKey,
    recentBlockhash: value.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: cfg.priorityMicroLamports }),
      createAssociatedTokenAccountIdempotentInstruction(pool.publicKey, poolAta, pool.publicKey, mintKey, program),
    ],
  }).compileToV0Message()
  const tx = new VersionedTransaction(msg)
  tx.sign([pool])
  let sig: string
  try {
    sig = await rpc.call<string>('sendTransaction', [Buffer.from(tx.serialize()).toString('base64'), { encoding: 'base64', preflightCommitment: 'confirmed' }])
  } catch (e) {
    fail(`the RPC refused the token-account transaction: ${(e as Error).message}`)
  }
  let landed = false
  for (let i = 0; i < 60 && !landed; i++) {
    const st = await rpc.call<{ value: ({ confirmationStatus: string; err: unknown } | null)[] }>('getSignatureStatuses', [[sig], { searchTransactionHistory: true }])
    const v = st.value[0]
    if (v?.err) fail(`creating the pool token account failed: ${JSON.stringify(v.err)}`)
    if (v && v.confirmationStatus !== 'processed') landed = true
    else await new Promise((r) => setTimeout(r, 1000))
  }
  if (!landed) fail(`the token-account transaction ${sig} did not confirm within 60 s (dropped?): run go-ca again, it is safe to repeat`)
  ok(`pool token account created (${sig.slice(0, 16)}…)`)
  done.push('pool token account created')
}

// The payment watcher's starting point: the token account's newest transaction right now (normally the
// creation above). Everything after it is a player's payment and is processed, however soon after the
// restart it lands; nothing before it (the account's own creation) is mistaken for one.
{
  const newest = await rpc.call<{ signature: string }[]>('getSignaturesForAddress', [poolAta.toBase58(), { limit: 1, commitment: 'confirmed' }])
  const db = openDb(cfg.dataDir)
  const at = { poolAta: poolAta.toBase58() }
  if (newest[0]) setMeta(db, key(at, 'last_sig'), newest[0].signature)
  setMeta(db, key(at, 'started'), '1')
  setMeta(db, 'mint', mint)
  db.close()
  ok(`payment watcher starts after ${newest[0] ? newest[0].signature.slice(0, 12) + '…' : 'the (empty) account history'}`)
  done.push('payment watcher start point recorded')
}

// .env: rewrite the two lines, keep everything else exactly as it is
const ENV_FILE = process.env.GOLIVE_ENV_FILE ?? '.env'
const RESTART = process.env.GOLIVE_RESTART_CMD ?? 'systemctl restart xpoke'
const lines = readFileSync(ENV_FILE, 'utf8').split('\n').filter((l) => !/^(TOKEN_MINT|PAYOUTS_ENABLED)=/.test(l))
while (lines.length && lines[lines.length - 1] === '') lines.pop()
lines.push(`TOKEN_MINT=${mint}`, `PAYOUTS_ENABLED=${payouts ? 1 : 0}`, '')
writeFileSync(ENV_FILE, lines.join('\n'), { mode: 0o600 })
ok('.env updated')
done.push(`.env has TOKEN_MINT=${mint} and PAYOUTS_ENABLED=${payouts ? 1 : 0}`)

const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(TOKEN_MINT|PAYOUTS_ENABLED)$/.test(k)))
execSync(RESTART, { stdio: 'inherit', env: cleanEnv })
done.push('xpoke restarted')
for (let i = 0; i < 30; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  try {
    const shop = (await (await fetch(`http://127.0.0.1:${cfg.port}/api/shop`)).json()) as { enabled: boolean; token: string }
    if (shop.enabled && shop.token === mint) {
      const st = (await (await fetch(`http://127.0.0.1:${cfg.port}/api/agent/status`)).json()) as { chain: Record<string, unknown> }
      ok(`xpoke restarted: shop OPEN, payouts ${st.chain.payouts ? 'ON' : 'OFF'}, pool token account ${String(st.chain.poolTokenAccount).slice(0, 8)}…`)
      console.log('\n  🟢 live. The CA pill on xpoke.fun now shows the mint.\n')
      process.exit(0)
    }
  } catch {
    /* still starting */
  }
}
fail('xpoke did not report the shop open within 30 s: check `journalctl -u xpoke -n 50`')
