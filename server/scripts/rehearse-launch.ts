/**
 * Launch dress rehearsal, entirely local (⛔ refuses any RPC that is not localhost).
 *
 *   solana-test-validator --rpc-port 8961 --faucet-port 8964 --dynamic-port-range 9200-9230 --reset
 *   SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/rehearse-launch.ts
 *
 * Starts the REAL server (src/index.ts) on :5399 against a fresh Token-2022 6-decimal mint, then:
 *   1. go-live checks (golive --dry) against that mint
 *   2. a launch rush: 600 mentions from 200 trainers dropped into the X source at once
 *   3. 20 ball purchases paid on chain through /api/pay/build (the website wallet path)
 *   4. 10 wagers, both sides paid on chain, settled, paid out, 1% burned
 *   5. 3,000 requests at 100 concurrent on the public pages
 * and checks balances, supply, the solvency of every wager, and /api/health at the end.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction, SystemProgram, Transaction, sendAndConfirmTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID as P, createMint, getOrCreateAssociatedTokenAccount, mintTo, getMint, getAccount, getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'
import { DatabaseSync } from 'node:sqlite'

const RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8961'
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('local validator only')
const conn = new Connection(RPC, 'confirmed')
const PORT = 5399
const BASE = `http://127.0.0.1:${PORT}`
const t0 = Date.now()
const log = (s: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`)

// ---------------------------------------------------------------- chain setup
const funder = Keypair.generate()
const pool = Keypair.generate()
await conn.confirmTransaction(await conn.requestAirdrop(funder.publicKey, 500 * LAMPORTS_PER_SOL), 'confirmed')
const mint = await createMint(conn, funder, funder.publicKey, null, 6, undefined, undefined, P)
const wallets = Array.from({ length: 40 }, () => Keypair.generate())
// SOL for fees, in batches of 10 transfers per transaction
const targets = [pool, ...wallets]
for (let i = 0; i < targets.length; i += 10) {
  const tx = new Transaction()
  for (const k of targets.slice(i, i + 10)) tx.add(SystemProgram.transfer({ fromPubkey: funder.publicKey, toPubkey: k.publicKey, lamports: LAMPORTS_PER_SOL / 10 }))
  await sendAndConfirmTransaction(conn, tx, [funder], { commitment: 'confirmed' })
}
for (const k of wallets) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, funder, mint, k.publicKey, false, 'confirmed', undefined, P)
  await mintTo(conn, funder, mint, ata.address, funder, 50_000_000_000n, [], undefined, P) // 50,000 tokens each
}
log(`chain ready: mint ${mint.toBase58().slice(0, 8)}…, pool funded, 40 player wallets with 50,000 tokens`)

// ---------------------------------------------------------------- the real server
const dataDir = mkdtempSync(join(tmpdir(), 'xp-rehearse-'))
const env = {
  ...process.env,
  PORT: String(PORT),
  DATA_DIR: dataDir,
  DEV_MODE: '1',
  LLM_ENABLED: '0',
  X_SOURCE: 'fixture',
  POLL_FIXTURE: '1',
  POLL_SECONDS: '15',
  POLL_IDLE_SECONDS: '15',
  X_REPLY: 'none',
  DRY_RUN: '1',
  X_HANDLE: 'xpokefun',
  TOKEN_MINT: mint.toBase58(),
  POOL_SECRET: bs58.encode(pool.secretKey),
  PAYOUTS_ENABLED: '1',
  SOLANA_RPC: RPC,
  RPC_RPS: '0',
  CONFIRMATIONS: '0',
  WEB_DIST: '../web/dist',
}
log('go-live checks (--dry):')
execFileSync('node', ['node_modules/tsx/dist/cli.mjs', 'src/golive.ts', mint.toBase58(), '--dry'], { env, stdio: 'inherit' })

writeFileSync(join(dataDir, 'mentions.json'), '[]')
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
log('server up on :5399')
const db = new DatabaseSync(join(dataDir, 'xpoke.db'))

// ---------------------------------------------------------------- 2. the launch rush through the X source
const mentions = []
let id = 1
for (let round = 0; round < 3; round++)
  for (let u = 0; u < 200; u++)
    mentions.push({ id: String(10_000 + id++), text: `@xpokefun ${['catch', 'catch', 'check', 'battle', 'feed pizza'][(u + round) % 5]}`, authorHandle: `p${u}`, authorId: `h:p${u}`, createdAt: new Date(Date.now() - 60_000 + id).toISOString() })
const rushStart = Date.now()
writeFileSync(join(dataDir, 'mentions.json'), JSON.stringify(mentions))
for (;;) {
  const n = (db.prepare("select count(*) n from mentions where processed_at is not null and status != 'running'").get() as { n: number }).n
  if (n >= mentions.length) break
  if (Date.now() - rushStart > 180_000) throw new Error(`rush stalled at ${n}/${mentions.length}`)
  await new Promise((r) => setTimeout(r, 500))
}
const rushMs = Date.now() - rushStart
const byStatus = db.prepare('select status, count(*) n from mentions group by status').all()
const trainers = (db.prepare('select count(*) n from trainers').get() as { n: number }).n
log(`rush: ${mentions.length} mentions from 200 trainers processed in ${(rushMs / 1000).toFixed(1)} s (incl. waiting for the 15 s poll) · ${JSON.stringify(byStatus)} · ${trainers} trainers`)
assert.equal((db.prepare("select count(*) n from mentions where status = 'failed'").get() as { n: number }).n, 0, 'no command failed')

// ---------------------------------------------------------------- helpers: a logged-in browser per wallet
async function login(handle: string): Promise<string> {
  const r = await fetch(`${BASE}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle }) })
  return r.headers.get('set-cookie')!.split(';')[0]!
}
async function api<T>(cookie: string, path: string, body?: unknown): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const j = (await r.json()) as T & { error?: string }
  if (!r.ok) throw new Error(`${path}: ${r.status} ${j.error}`)
  return j
}
async function payBuilt(wallet: Keypair, cookie: string, kind: 'order' | 'wager', id: number): Promise<string> {
  const { tx } = await api<{ tx: string }>(cookie, '/api/pay/build', { kind, id, payer: wallet.publicKey.toBase58() })
  const vtx = VersionedTransaction.deserialize(Buffer.from(tx, 'base64'))
  vtx.sign([wallet])
  const sig = await conn.sendRawTransaction(vtx.serialize())
  await conn.confirmTransaction(sig, 'confirmed')
  return sig
}
async function waitFor(what: string, cond: () => boolean, ms = 120_000) {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 500))
  }
  return Date.now() - start
}

// ---------------------------------------------------------------- 3. shop: 20 purchases through the website wallet path
const supplyBeforeShop = (await getMint(conn, mint, 'confirmed', P)).supply
const shopStart = Date.now()
await Promise.all(
  wallets.slice(0, 20).map(async (w, i) => {
    const cookie = await login(`buyer${i}`)
    const order = await api<{ id: number }>(cookie, '/api/shop/order', { ball: i % 2 ? 'master' : 'ultra', qty: 1 + (i % 3) })
    await payBuilt(w, cookie, 'order', order.id)
  }),
)
const paidAfter = await waitFor('20 orders credited', () => (db.prepare("select count(*) n from orders where status = 'paid'").get() as { n: number }).n >= 20)
const balls = db.prepare("select sum(ultra_balls) u, sum(master_balls) m from trainers where handle like 'buyer%'").get() as { u: number; m: number }
log(`shop: 20 purchases paid on chain, all credited ${(paidAfter / 1000).toFixed(1)} s after the last payment (total ${((Date.now() - shopStart) / 1000).toFixed(1)} s) · balls ${JSON.stringify(balls)}`)
assert.equal(balls.u + balls.m, Array.from({ length: 20 }, (_, i) => 1 + (i % 3)).reduce((a, b) => a + b), 'every ball bought was credited')

// ---------------------------------------------------------------- 4. ten wagers paid on chain
const wagerStart = Date.now()
const pairs = Array.from({ length: 10 }, (_, i) => ({ a: `p${i * 2}`, b: `p${i * 2 + 1}`, wa: wallets[20 + i * 2]!, wb: wallets[21 + i * 2]! }))
// both trainers need exactly 3 party pokemon: top them up the quick way
db.exec("update trainers set free_balls = 50")
for (const p of pairs)
  for (const h of [p.a, p.b])
    for (let k = 0; k < 60 && (db.prepare("select count(*) n from pokemon where trainer_id = ? and location = 'party'").get(`h:${h}`) as { n: number }).n < 3; k++)
      await fetch(`${BASE}/api/dev/mention`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: h, text: 'catch' }) })
db.exec("update pokemon set last_battle_at = null")
const supplyBefore = (await getMint(conn, mint, 'confirmed', P)).supply
await Promise.all(
  pairs.map(async (p, i) => {
    const say = (h: string, text: string) =>
      fetch(`${BASE}/api/dev/mention`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: h, text }) }).then((r) => r.json() as Promise<{ reply: string }>)
    const made = await say(p.a, `wager @${p.b} ${100 * (i + 1)}`)
    assert.match(made.reply, /wagers/, `${p.a}: ${made.reply}`)
    const acc = await say(p.b, 'accept wager')
    assert.match(acc.reply, /accepted/, `${p.b}: ${acc.reply}`)
    const [ca, cb] = [await login(p.a), await login(p.b)]
    const me = await api<{ trainer: { wager: { id: number } } }>(ca, '/api/me')
    await Promise.all([payBuilt(p.wa, ca, 'wager', me.trainer.wager.id), payBuilt(p.wb, cb, 'wager', me.trainer.wager.id)])
  }),
)
const settled = await waitFor('10 wagers settled', () => (db.prepare("select count(*) n from wagers where status = 'complete'").get() as { n: number }).n >= 10)
const paidOut = await waitFor(
  'all payouts and burns confirmed',
  () => (db.prepare("select count(*) n from ledger where ref_kind = 'wager' and kind in ('payout','burn') and status = 'confirmed'").get() as { n: number }).n >= 20,
  240_000,
)
log(`wagers: 10 settled ${(settled / 1000).toFixed(1)} s after the last payment, all 20 payouts+burns confirmed ${(paidOut / 1000).toFixed(1)} s later (total ${((Date.now() - wagerStart) / 1000).toFixed(1)} s)`)

// solvency of every wager, and the burn on chain
let burned = 0n
for (const w of db.prepare("select * from wagers where status = 'complete'").all() as { id: number; paid_a_amount: string; paid_b_amount: string }[]) {
  const pot = BigInt(w.paid_a_amount) + BigInt(w.paid_b_amount)
  const out = (db.prepare("select amount from ledger where ref_kind = 'wager' and ref_id = ? and kind in ('payout','burn')").all(w.id) as { amount: string }[]).reduce((a, r) => a + BigInt(r.amount), 0n)
  assert.equal(out, pot, `wager #${w.id}: out == pot`)
  burned += pot / 100n
}
const shopIncome = (db.prepare("select amount from orders where status = 'paid'").all() as { amount: string }[]).reduce((a, r) => a + BigInt(r.amount), 0n)
await waitFor('shop burns confirmed', () => (db.prepare("select count(*) n from ledger where kind = 'burn' and ref_kind = 'order' and status = 'confirmed'").get() as { n: number }).n >= 20)
const supplyAfter = (await getMint(conn, mint, 'confirmed', P)).supply
assert.equal(supplyBeforeShop - supplyAfter, burned + shopIncome, 'supply dropped by exactly the wager burns + every ball purchase')
const poolTokens = (await getAccount(conn, getAssociatedTokenAddressSync(mint, pool.publicKey, false, P), 'confirmed', P)).amount
assert.equal(poolTokens, 0n, 'the pool ends empty: wager money paid out, shop income burned')
log(`money: supply down by exactly the 1% wager burns + all ${shopIncome / 1_000_000n} shop tokens, pool empty, every wager pot fully accounted`)

// ---------------------------------------------------------------- 5. public page load
const paths = ['/api/leaderboard', '/api/agent/activity?limit=30', '/api/pvp/recent', '/api/pvp/pending', '/api/gym', '/api/pokedex', '/api/trainers', '/api/stats', '/api/agent/status', '/', '/pokedex']
const lat: number[] = []
let errors = 0
const loadStart = Date.now()
let next = 0
await Promise.all(
  Array.from({ length: 100 }, async () => {
    while (next < 3000) {
      const p = paths[next++ % paths.length]!
      const s = Date.now()
      const r = await fetch(`${BASE}${p}`).catch(() => null)
      if (!r || !r.ok) errors++
      else await r.arrayBuffer()
      lat.push(Date.now() - s)
    }
  }),
)
lat.sort((a, b) => a - b)
log(`load: 3,000 requests at 100 concurrent in ${((Date.now() - loadStart) / 1000).toFixed(1)} s · p50 ${lat[1500]} ms · p95 ${lat[2850]} ms · max ${lat[2999]} ms · errors ${errors}`)
assert.equal(errors, 0)

// ---------------------------------------------------------------- health
const health = (await (await fetch(`${BASE}/api/health`)).json()) as { ok: boolean; problems: string[] }
log(`health: ${health.ok ? 'OK' : health.problems.join(' | ')}`)
assert.ok(health.ok)
const errLines = serverLog.split('\n').filter((l) => /error|failed|HELD/i.test(l) && !/ExperimentalWarning|bindings/.test(l))
log(`server log: ${errLines.length ? errLines.slice(0, 5).join(' / ') : 'no errors'}`)
console.log('\nREHEARSAL PASSED')
server.kill()
process.exit(0)
