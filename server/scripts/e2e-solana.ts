/**
 * Local end-to-end money test on solana-test-validator (never mainnet: SOLANA_RPC must be localhost).
 *
 *   solana-test-validator --rpc-port 8961 --faucet-port 8964 --dynamic-port-range 9200-9230 --reset
 *   SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/e2e-solana.ts
 *
 * A Token-2022 mint with 6 decimals (like pump.fun's), two trainers, a wager paid on chain (one side
 * through the same /api/pay/build transaction the browser wallet signs), watcher → settle → payout +
 * burn, then a late duplicate payment refunded. Asserts balances and supply.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, VersionedTransaction, sendAndConfirmTransaction, Transaction } from '@solana/web3.js'
import {
  TOKEN_2022_PROGRAM_ID,
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token'
import bs58 from 'bs58'
import { openDb } from '../src/db.ts'
import { loadConfig } from '../src/config.ts'
import { makeSolana, scanOnce, sendOnce, buildPayment } from '../src/pay/solana.ts'
import { ensureTrainer } from '../src/game/store.ts'
import { run } from '../src/game/engine.ts'
import { getWager } from '../src/game/wager.ts'

const RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8961'
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('local validator only')
const conn = new Connection(RPC, 'confirmed')
const P = TOKEN_2022_PROGRAM_ID

const pool = Keypair.generate()
const alice = Keypair.generate()
const gary = Keypair.generate()
const mintAuth = Keypair.generate()
for (const k of [pool, alice, gary, mintAuth]) {
  await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL), 'confirmed')
}
const mint = await createMint(conn, mintAuth, mintAuth.publicKey, null, 6, undefined, undefined, P)
for (const k of [alice, gary]) {
  const ata = await getOrCreateAssociatedTokenAccount(conn, mintAuth, mint, k.publicKey, false, 'confirmed', undefined, P)
  await mintTo(conn, mintAuth, mint, ata.address, mintAuth, 5_000_000_000n, [], undefined, P) // 5,000 tokens
}
// ⚠ the pool's token account is deliberately NOT created here: a fresh pool has none, and the first
// player's payment is what creates it. The watcher must see that payment.
const poolAtaAddr = getAssociatedTokenAddressSync(mint, pool.publicKey, false, P)
const poolAta = { address: poolAtaAddr }

const cfg = {
  ...loadConfig(),
  solanaRpc: RPC,
  rpcRps: 0,
  tokenMint: mint.toBase58(),
  poolSecret: bs58.encode(pool.secretKey),
  payoutsEnabled: true,
}
const s = makeSolana(cfg)
const db = openDb(mkdtempSync(join(tmpdir(), 'xpsol-')))

// first scan on a pool with no history: nothing to mark, everything from here on is ours
assert.deepEqual(await scanOnce(db, cfg, s), [])
assert.equal(s.poolAta, poolAta.address.toBase58())

for (const h of ['alice', 'gary']) {
  const actor = ensureTrainer(db, { id: `h:${h}`, handle: h })
  db.prepare('update trainers set free_balls = 50 where id = ?').run(actor.id)
  while ((db.prepare("select count(*) n from pokemon where trainer_id = ? and location = 'party'").get(actor.id) as { n: number }).n < 3)
    await run({ db, actor, site: 'x' }, { kind: 'catch', ball: 'poke' })
}
const say = (h: string, cmd: Parameters<typeof run>[1]) => run({ db, actor: ensureTrainer(db, { id: `h:${h}`, handle: h }), site: 'x' }, cmd)
console.log((await say('alice', { kind: 'wager', target: 'gary', amount: 1000 })).reply)
console.log((await say('gary', { kind: 'accept' })).reply)
const w = getWager(db, 1)!
console.log('amounts', w.pay_a, w.pay_b)

// alice pays through the exact transaction the website hands her wallet
const built = await buildPayment(s, alice.publicKey.toBase58(), BigInt(w.pay_a!))
const vtx = VersionedTransaction.deserialize(Buffer.from(built, 'base64'))
vtx.sign([alice])
const sigA = await conn.sendRawTransaction(vtx.serialize())
await conn.confirmTransaction(sigA, 'confirmed')

// gary pays by hand, a plain transferChecked
const pay = async (k: Keypair, amount: bigint) => {
  const tx = new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(k.publicKey, poolAta.address, pool.publicKey, mint, P),
    createTransferCheckedInstruction(getAssociatedTokenAddressSync(mint, k.publicKey, false, P), mint, poolAta.address, k.publicKey, amount, 6, [], P),
  )
  return sendAndConfirmTransaction(conn, tx, [k], { commitment: 'confirmed' })
}
await pay(gary, BigInt(w.pay_b!))

const announced = await scanOnce(db, cfg, s)
console.log('announced:', announced)
const done = getWager(db, 1)!
assert.equal(done.status, 'complete')
assert.equal(done.paid_a_from, alice.publicKey.toBase58(), 'payer read from the transaction')

const supplyBefore = (await getMint(conn, mint, 'confirmed', P)).supply
for (let i = 0; i < 20; i++) {
  await sendOnce(db, cfg, s)
  if (!(db.prepare("select 1 from ledger where status in ('pending','signed') and kind != 'payment'").get())) break
  await new Promise((r) => setTimeout(r, 500))
}
console.table(db.prepare("select kind, to_addr, amount, status, substr(tx_hash,1,16) tx, error from ledger where kind != 'payment'").all())
const pot = BigInt(w.pay_a!) + BigInt(w.pay_b!)
const winner = done.winner === 0 ? alice : gary
const winnerPaid = BigInt(done.winner === 0 ? w.pay_a! : w.pay_b!)
const winnerBal = (await getAccount(conn, getAssociatedTokenAddressSync(mint, winner.publicKey, false, P), 'confirmed', P)).amount
const poolBal = (await getAccount(conn, poolAta.address, 'confirmed', P)).amount
const supplyAfter = (await getMint(conn, mint, 'confirmed', P)).supply
assert.equal(poolBal, 0n, 'pool emptied')
assert.equal(supplyBefore - supplyAfter, pot / 100n, '1% burned: supply down')
assert.equal(winnerBal, 5_000_000_000n - winnerPaid + (pot - pot / 100n), 'winner got 99%')

// a late duplicate payment is refunded to whoever sent it
await pay(gary, BigInt(w.pay_b!))
await scanOnce(db, cfg, s)
for (let i = 0; i < 20; i++) {
  await sendOnce(db, cfg, s)
  if (!(db.prepare("select 1 from ledger where status in ('pending','signed') and kind != 'payment'").get())) break
  await new Promise((r) => setTimeout(r, 500))
}
const refund = db.prepare("select * from ledger where kind = 'refund'").get() as { to_addr: string; status: string }
assert.equal(refund.to_addr, gary.publicKey.toBase58())
assert.equal(refund.status, 'confirmed')
assert.equal((await getAccount(conn, poolAta.address, 'confirmed', P)).amount, 0n, 'pool empty again after refund')
assert.equal(await sendOnce(db, cfg, s), false, 'nothing left to send')
console.log('OK: Token-2022 wager paid, settled, 99% paid out, 1% burned, late payment refunded')

// ---- burst: a real order payment buried under 150 dust transfers, scanned one page (100) per tick
if (process.env.SCAN_PAGES === '1') {
  db.prepare("insert into orders (trainer_id, ball, qty, amount, status, created_at, expires_at) values ('h:gary','ultra',1,'2000000777','pending',?,?)").run(Date.now(), Date.now() + 1800_000)
  await pay(gary, 2000000777n)
  // dust from alice, 150 transfers (one signature each)
  for (let i = 0; i < 150; i++) await pay(alice, 1n)
  let ticks = 0
  for (; ticks < 10; ticks++) {
    await scanOnce(db, cfg, s)
    if ((db.prepare("select status from orders where amount = '2000000777'").get() as { status: string }).status === 'paid') break
  }
  const seen = (db.prepare('select count(*) as n from transfers').get() as { n: number }).n
  console.log('burst: order paid after', ticks + 1, 'ticks; transfers recorded so far', seen)
  assert.equal((db.prepare("select status from orders where amount = '2000000777'").get() as { status: string }).status, 'paid', 'buried payment found')
  for (let i = 0; i < 10 && db.prepare("select v from meta where k like 'sol_backfill:%'").get()?.v; i++) await scanOnce(db, cfg, s)
  const total = (db.prepare('select count(*) as n from transfers').get() as { n: number }).n
  assert.ok(total >= 150 + 4, `every transfer recorded (got ${total})`)
  console.log('OK: burst of 151 signatures fully drained across ticks, nothing skipped')
}
