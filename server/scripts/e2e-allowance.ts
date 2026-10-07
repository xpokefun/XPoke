/**
 * Wager allowances and tournament prizes, for real, on a local validator (⛔ localhost RPC only).
 *
 *   solana-test-validator --rpc-port 8961 --faucet-port 8964 --dynamic-port-range 9200-9230 --reset
 *   SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/e2e-allowance.ts
 *
 * 1. two players link wallets (real ed25519 signatures through the API) and approve an allowance with the
 *    exact transaction /api/me/wallet/allowance hands their wallet;
 * 2. a wager made and accepted with X commands only: XPoke pulls both stakes, the battle runs, the winner's
 *    LINKED wallet gets 99%, 1% is burned, allowances drop by exactly the stakes;
 * 3. one player revokes: the next wager skips their pull, they pay by hand, it still settles;
 * 4. a token-prize tournament: the prize waits while the pool is unfunded, then pays the champion's wallet.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createPrivateKey, sign } from 'node:crypto'
import assert from 'node:assert/strict'
import { Connection, Keypair, LAMPORTS_PER_SOL, SystemProgram, Transaction, VersionedTransaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID as P, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint, getAssociatedTokenAddressSync, createTransferCheckedInstruction } from '@solana/spl-token'
import bs58 from 'bs58'
import { DatabaseSync } from 'node:sqlite'

const RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8961'
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('local validator only')
const conn = new Connection(RPC, 'confirmed')
const PORT = 5395
const BASE = `http://127.0.0.1:${PORT}`
const t0 = Date.now()
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)
const U = 1_000_000n // one token in base units

// ---------------------------------------------------------------- chain
const funder = Keypair.generate()
const pool = Keypair.generate()
await conn.confirmTransaction(await conn.requestAirdrop(funder.publicKey, 100 * LAMPORTS_PER_SOL), 'confirmed')
const mint = await createMint(conn, funder, funder.publicKey, null, 6, undefined, undefined, P)
const players = Object.fromEntries(['alice', 'gary', ...Array.from({ length: 8 }, (_, i) => `cup${i}`)].map((h) => [h, Keypair.generate()]))
const sol = new Transaction()
for (const k of [pool, ...Object.values(players)]) sol.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: k.publicKey, lamports: LAMPORTS_PER_SOL / 10 }))
await sendAndConfirmTransaction(conn, sol, [funder], { commitment: 'confirmed' })
for (const h of ['alice', 'gary']) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, players[h]!.publicKey, false, 'confirmed', undefined, P)
  await mintTo(conn, funder, mint, ata.address, funder, 10_000n * U, [], undefined, P)
}
const funderAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, funder.publicKey, false, 'confirmed', undefined, P)
await mintTo(conn, funder, mint, funderAta.address, funder, 10_000n * U, [], undefined, P)
const poolAta = getAssociatedTokenAddressSync(mint, pool.publicKey, false, P)
const bal = async (owner: Keypair) => (await getAccount(conn, getAssociatedTokenAddressSync(mint, owner.publicKey, false, P), 'confirmed', P)).amount
const acct = (owner: Keypair) => getAccount(conn, getAssociatedTokenAddressSync(mint, owner.publicKey, false, P), 'confirmed', P)
log('chain ready')

// ---------------------------------------------------------------- server
const dir = mkdtempSync(join(tmpdir(), 'xp-allow-'))
writeFileSync(join(dir, 'mentions.json'), '[]')
const env = {
  ...process.env, PORT: String(PORT), DATA_DIR: dir, DEV_MODE: '1', LLM_ENABLED: '0', X_SOURCE: 'fixture', X_REPLY: 'none', X_HANDLE: 'xpokefun',
  TOKEN_MINT: mint.toBase58(), POOL_SECRET: bs58.encode(pool.secretKey), PAYOUTS_ENABLED: '1', SOLANA_RPC: RPC, RPC_RPS: '0', ADMIN_TOKEN: 'admin-test',
}
const server = spawn('node', ['node_modules/tsx/dist/cli.mjs', 'src/index.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let serverLog = ''
server.stdout.on('data', (b) => (serverLog += b))
server.stderr.on('data', (b) => (serverLog += b))
process.on('exit', () => server.kill())
for (let i = 0; i < 60; i++) {
  try {
    if ((await fetch(`${BASE}/api/config`)).ok) break
  } catch {}
  await new Promise((r) => setTimeout(r, 500))
}
const db = new DatabaseSync(join(dir, 'xpoke.db'))
log('server up')

// ---------------------------------------------------------------- helpers
const cookies: Record<string, string> = {}
async function api<T>(h: string, path: string, body?: unknown): Promise<T> {
  if (!cookies[h]) {
    const r = await fetch(`${BASE}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: h }) })
    cookies[h] = r.headers.get('set-cookie')!.split(';')[0]!
  }
  const r = await fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', headers: { cookie: cookies[h]!, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) })
  const j = (await r.json()) as T & { error?: string }
  if (!r.ok) throw new Error(`${h} ${path}: ${r.status} ${j.error}`)
  return j
}
const say = (h: string, text: string) =>
  fetch(`${BASE}/api/dev/mention`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: h, text }) }).then((r) => r.json() as Promise<{ reply: string }>)
function walletSign(kp: Keypair, message: string): string {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.slice(0, 32))])
  return bs58.encode(sign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })))
}
async function linkWallet(h: string) {
  const kp = players[h]!
  const c = await api<{ nonce: string; message: string }>(h, '/api/me/wallet/challenge', { address: kp.publicKey.toBase58() })
  await api(h, '/api/me/wallet/link', { nonce: c.nonce, signature: walletSign(kp, c.message) })
}
async function signAndSend(kp: Keypair, b64: string) {
  const tx = VersionedTransaction.deserialize(Buffer.from(b64, 'base64'))
  tx.sign([kp])
  const sig = await conn.sendRawTransaction(tx.serialize())
  await conn.confirmTransaction(sig, 'confirmed')
}
async function party3(h: string) {
  db.prepare("update trainers set free_balls = 99 where handle = ?").run(h)
  for (let i = 0; i < 80 && (db.prepare("select count(*) n from pokemon p join trainers t on t.id = p.trainer_id where t.handle = ? and p.location = 'party'").get(h) as { n: number }).n < 3; i++) await say(h, 'catch')
}
async function waitFor(what: string, cond: () => boolean | Promise<boolean>, ms = 120_000) {
  const s = Date.now()
  while (!(await cond())) {
    if (Date.now() - s > ms) throw new Error(`timed out: ${what}\n${serverLog.split('\n').filter((l) => /error|fail|skip/i.test(l)).slice(-5).join('\n')}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  return Date.now() - s
}

// ---------------------------------------------------------------- 1. link + approve
for (const h of ['alice', 'gary']) {
  await say(h, 'catch') // creates the trainer
  await linkWallet(h)
  const { tx } = await api<{ tx: string }>(h, '/api/me/wallet/allowance', { amount: '5000' })
  await signAndSend(players[h]!, tx)
  const b = await api<{ allowance: string }>(h, '/api/me/wallet/balance')
  assert.equal(b.allowance, '5,000')
  await party3(h)
}
assert.equal((await acct(players.alice!)).delegate?.toBase58(), pool.publicKey.toBase58())
log('alice and gary: wallets linked (signed), 5,000 allowance approved on chain, teams of 3')

// ---------------------------------------------------------------- 2. a wager on X only
const aliceBefore = await bal(players.alice!)
const garyBefore = await bal(players.gary!)
const supplyBefore = (await getMint(conn, mint, 'confirmed', P)).supply
assert.match((await say('alice', 'wager @gary 1000')).reply, /wagers 1,000/)
const accepted = (await say('gary', 'accept wager')).reply
assert.match(accepted, /allowance pays automatically/)
const t1 = Date.now()
const settledIn = await waitFor('wager 1 settled', () => (db.prepare("select status from wagers where id = 1").get() as { status: string }).status === 'complete')
await waitFor('wager 1 paid out', () => (db.prepare("select count(*) n from ledger where ref_kind = 'wager' and ref_id = 1 and kind in ('payout','burn') and status = 'confirmed'").get() as { n: number }).n === 2)
const w1 = db.prepare('select * from wagers where id = 1').get() as { winner: number; amount: string; paid_a_amount: string; paid_b_amount: string; paid_a_from: string; paid_b_from: string }
assert.equal(w1.paid_a_amount, w1.amount, 'pulled exactly the stake (no unique tail)')
assert.equal(w1.paid_b_amount, w1.amount)
assert.equal(w1.paid_a_from, players.alice!.publicKey.toBase58(), 'the pull is attributed to the owner, not the pool')
const pot = BigInt(w1.paid_a_amount) + BigInt(w1.paid_b_amount)
const [winner, loser, winBefore, loseBefore, winPaid, losePaid] =
  w1.winner === 0 ? [players.alice!, players.gary!, aliceBefore, garyBefore, BigInt(w1.paid_a_amount), BigInt(w1.paid_b_amount)] : [players.gary!, players.alice!, garyBefore, aliceBefore, BigInt(w1.paid_b_amount), BigInt(w1.paid_a_amount)]
assert.equal(await bal(winner), winBefore - winPaid + (pot - pot / 100n), 'winner: linked wallet got 99%')
assert.equal(await bal(loser), loseBefore - losePaid, 'loser: exactly the stake left')
assert.equal(supplyBefore - (await getMint(conn, mint, 'confirmed', P)).supply, pot / 100n, '1% burned')
assert.equal((await acct(players.alice!)).delegatedAmount, 4000n * U, 'allowance dropped by exactly the stake: 5,000 → 4,000')
log(`wager 1 on X only: both stakes pulled, settled ${(settledIn / 1000).toFixed(1)} s after "accept wager", 99% to the winner's linked wallet, 1% burned, allowances down by exactly the stakes (${((Date.now() - t1) / 1000).toFixed(1)} s total)`)

// ---------------------------------------------------------------- 3. gary revokes → pays by hand
const { tx: revoke } = await api<{ tx: string }>('gary', '/api/me/wallet/allowance', { amount: '0' })
await signAndSend(players.gary!, revoke)
assert.equal((await acct(players.gary!)).delegate, null)
db.exec('update pokemon set last_battle_at = null')
assert.match((await say('alice', 'wager @gary 200')).reply, /wagers 200/)
await say('gary', 'accept wager')
await waitFor('gary pull skipped', () => (db.prepare("select status from pulls where wager_id = 2 and side = 'b'").get() as { status: string } | undefined)?.status === 'skipped')
const garyPull = db.prepare("select error from pulls where wager_id = 2 and side = 'b'").get() as { error: string }
assert.match(garyPull.error, /allowance too small/)
await waitFor('alice pulled', () => (db.prepare("select paid_a_tx from wagers where id = 2").get() as { paid_a_tx: string | null }).paid_a_tx !== null)
const me = await api<{ trainer: { wager: { id: number; myAutoPay: { status: string } } } }>('gary', '/api/me')
assert.equal(me.trainer.wager.myAutoPay.status, 'skipped')
const { tx: manual } = await api<{ tx: string }>('gary', '/api/pay/build', { kind: 'wager', id: 2, payer: players.gary!.publicKey.toBase58() })
await signAndSend(players.gary!, manual)
await waitFor('wager 2 settled', () => (db.prepare("select status from wagers where id = 2").get() as { status: string }).status === 'complete')
log('wager 2: gary revoked → his pull was skipped ("allowance too small"), he paid by hand, it settled')

// ---------------------------------------------------------------- 3b. approving EXACTLY the stake is enough
for (const h of ['alice', 'gary']) {
  const { tx } = await api<{ tx: string }>(h, '/api/me/wallet/allowance', { amount: '300' })
  await signAndSend(players[h]!, tx)
}
db.exec('update pokemon set last_battle_at = null')
assert.match((await say('alice', 'wager @gary 300')).reply, /wagers 300/)
await say('gary', 'accept wager')
await waitFor('wager 3 settled', () => (db.prepare("select status from wagers where id = 3").get() as { status: string }).status === 'complete')
for (const h of ['alice', 'gary']) assert.equal((await acct(players[h]!)).delegatedAmount, 0n, `${h}: an exact 300 approval is used up exactly`)
const pulls3 = db.prepare("select status from pulls where wager_id = 3").all() as { status: string }[]
assert.deepEqual(pulls3.map((p) => p.status).sort(), ['confirmed', 'confirmed'])
log('wager 3: both approved EXACTLY 300 and wagered 300 → both pulled, allowances exactly 0')

// ---------------------------------------------------------------- 4. prize tournament
const cr = await fetch(`${BASE}/api/admin/tournament`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-admin-token': 'admin-test' }, body: JSON.stringify({ name: 'Test Cup', prizeAmount: '500' }) })
assert.equal(cr.status, 200)
const cups = Object.keys(players).filter((h) => h.startsWith('cup'))
for (const h of cups) {
  await say(h, 'catch')
  await party3(h)
  await linkWallet(h)
  const r = (await say(h, 'tournament join')).reply
  assert.match(r, /registered/)
}
await waitFor('tournament done', () => (db.prepare("select status from tournaments where id = 1").get() as { status: string }).status === 'done')
await waitFor('prize waits for funding', () => /tournament prize/.test((db.prepare("select error from ledger where ref_kind = 'tournament'").get() as { error: string | null } | undefined)?.error ?? ''))
log('tournament finished; the prize waits: the pool has not been funded for it')
// fund the prize: 500 tokens into the pool
await sendAndConfirmTransaction(conn, new Transaction().add(createTransferCheckedInstruction(funderAta.address, mint, poolAta, funder.publicKey, 500n * U, 6, [], P)), [funder], { commitment: 'confirmed' })
await waitFor('prize paid', () => (db.prepare("select status from ledger where ref_kind = 'tournament'").get() as { status: string }).status === 'confirmed')
const champ = (db.prepare("select t.handle from tournaments x join trainers t on t.id = x.winner_id where x.id = 1").get() as { handle: string }).handle
assert.equal(await bal(players[champ]!), 500n * U, 'the champion\'s linked wallet holds exactly the prize')
await waitFor('funding transfer scanned', () => Boolean(db.prepare("select 1 from transfers where amount = ?").get(String(500n * U))), 180_000)
const transfer = db.prepare("select matched_kind from transfers where amount = ?").get(String(500n * U)) as { matched_kind: string }
assert.equal(transfer.matched_kind, 'unmatched', 'the funding transfer is recorded, not mistaken for a payment')
log(`prize funded → 500 tokens paid to @${champ}'s linked wallet`)

const errs = serverLog.split('\n').filter((l) => /error|HELD|fail/i.test(l) && !/ExperimentalWarning|bindings/.test(l))
assert.deepEqual(errs, [], 'server log clean')
console.log('\nALLOWANCE + PRIZE E2E PASSED')
server.kill()
process.exit(0)
