import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createPrivateKey, sign } from 'node:crypto'
import { Keypair } from '@solana/web3.js'
import bs58 from 'bs58'
import { openDb, type DB } from '../src/db.ts'
import { createChallenge, completeLink, unlink } from '../src/wallet.ts'
import { ensureTrainer, getTrainer } from '../src/game/store.ts'
import { run } from '../src/game/engine.ts'
import { getWager } from '../src/game/wager.ts'
import { handleTransfer } from '../src/pay/match.ts'
import { parseCommand } from '../src/game/parse.ts'

const fresh = (): DB => openDb(mkdtempSync(join(tmpdir(), 'xpw-')))
/** Signs like a wallet's solana:signMessage: ed25519 over the UTF-8 bytes. */
function walletSign(kp: Keypair, message: string): string {
  const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(kp.secretKey.slice(0, 32))])
  return bs58.encode(sign(null, Buffer.from(message, 'utf8'), createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })))
}
function link(db: DB, handle: string, kp: Keypair) {
  const t = ensureTrainer(db, { id: `h:${handle}`, handle })
  const c = createChallenge(db, t, kp.publicKey.toBase58())
  return completeLink(db, getTrainer(db, t.id)!, c.nonce, walletSign(kp, c.message))
}

test('a wallet links only with its own signature, once, and to one account', () => {
  const db = fresh()
  const ash = ensureTrainer(db, { id: 'h:ash', handle: 'ash' })
  const kp = Keypair.generate()
  const other = Keypair.generate()
  // signed by a different key
  const c1 = createChallenge(db, ash, kp.publicKey.toBase58())
  assert.throws(() => completeLink(db, ash, c1.nonce, walletSign(other, c1.message)), /does not match/)
  // a challenge is single use, even after a failure
  assert.throws(() => completeLink(db, ash, c1.nonce, walletSign(kp, c1.message)), /unknown/)
  // a signature over a different message
  const c2 = createChallenge(db, ash, kp.publicKey.toBase58())
  assert.throws(() => completeLink(db, ash, c2.nonce, walletSign(kp, c2.message + ' ')), /does not match/)
  // the right one
  const c3 = createChallenge(db, ash, kp.publicKey.toBase58())
  assert.equal(completeLink(db, ash, c3.nonce, walletSign(kp, c3.message)), kp.publicKey.toBase58())
  assert.equal(getTrainer(db, 'h:ash')!.wallet, kp.publicKey.toBase58())
  // someone else cannot use ash's challenge, and cannot link ash's wallet
  const gary = ensureTrainer(db, { id: 'h:gary', handle: 'gary' })
  const c4 = createChallenge(db, ash, kp.publicKey.toBase58())
  assert.throws(() => completeLink(db, gary, c4.nonce, walletSign(kp, c4.message)), /not yours/)
  const c5 = createChallenge(db, gary, kp.publicKey.toBase58())
  assert.throws(() => completeLink(db, gary, c5.nonce, walletSign(kp, c5.message)), /already linked/)
  assert.throws(() => createChallenge(db, ash, 'not-an-address'), /not a Solana/)
  unlink(db, getTrainer(db, 'h:ash')!)
  assert.equal(getTrainer(db, 'h:ash')!.wallet, null)
})

async function teams(db: DB, ...hs: string[]) {
  for (const h of hs) {
    const a = ensureTrainer(db, { id: `h:${h}`, handle: h })
    db.prepare('update trainers set free_balls = 50 where id = ?').run(a.id)
    let r = 0
    const rand = () => [0.01, 0.5, 0.9][r++ % 3]!
    while ((db.prepare("select count(*) n from pokemon where trainer_id = ? and location = 'party'").get(a.id) as { n: number }).n < 3)
      await run({ db, actor: getTrainer(db, a.id)!, site: 'https://xpoke.fun', rand }, { kind: 'catch', ball: 'poke' })
  }
}
const say = (db: DB, h: string, cmd: Parameters<typeof run>[1]) =>
  run({ db, actor: getTrainer(db, `h:${h}`) ?? ensureTrainer(db, { id: `h:${h}`, handle: h }), site: 'https://xpoke.fun' }, cmd)

test('winnings and refunds go to the wallet linked at acceptance, not the paying wallet; relinking later changes nothing', async () => {
  const db = fresh()
  await teams(db, 'ash', 'gary')
  const ashW = Keypair.generate()
  link(db, 'ash', ashW)
  const created = await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 100 })
  assert.match(created.reply, /accept wager/)
  assert.match(created.reply, /xpoke\.fun\/wallet/, 'gary has no wallet: told where to link')
  const acc = await say(db, 'gary', { kind: 'accept', wager: true })
  assert.match(acc.reply, /@gary link a wallet at xpoke\.fun\/wallet/)
  assert.ok(acc.reply.length <= 280)
  const w = getWager(db, 1)!
  assert.equal(w.payout_a, ashW.publicKey.toBase58())
  assert.equal(w.payout_b, null)
  // ash relinks to a new wallet after acceptance: this wager still pays the old one
  link(db, 'ash', Keypair.generate())
  handleTransfer(db, { txHash: 'p1', logIndex: 0, from: 'ExchangeHotWallet111', amount: w.pay_a!, block: 1 })
  handleTransfer(db, { txHash: 'p2', logIndex: 0, from: 'GaryPayer2222', amount: w.pay_b!, block: 2 })
  const done = getWager(db, 1)!
  const payout = db.prepare("select to_addr from ledger where kind = 'payout'").get() as { to_addr: string }
  assert.equal(payout.to_addr, done.winner === 0 ? ashW.publicKey.toBase58() : 'GaryPayer2222', 'linked wallet for ash, paying wallet for gary')
})

test('a cancelled wager refunds to the linked wallet', async () => {
  const db = fresh()
  await teams(db, 'ash', 'gary')
  const ashW = Keypair.generate()
  link(db, 'ash', ashW)
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 50 })
  await say(db, 'gary', { kind: 'accept', wager: true })
  const w = getWager(db, 1)!
  handleTransfer(db, { txHash: 'r1', logIndex: 0, from: 'ExchangeHotWallet111', amount: w.pay_a!, block: 1 })
  db.prepare('update wagers set pay_deadline = 0 where id = 1').run()
  await say(db, 'ash', { kind: 'cancel' })
  const refund = db.prepare("select to_addr, amount from ledger where kind = 'refund'").get() as { to_addr: string; amount: string }
  assert.equal(refund.to_addr, ashW.publicKey.toBase58())
  assert.equal(refund.amount, w.pay_a)
})

test('"wallet" on X tells you your linked wallet or how to link one', async () => {
  assert.deepEqual(parseCommand('@xpokefun wallet', 'xpokefun'), { kind: 'wallet' })
  assert.deepEqual(parseCommand('@xpokefun where do i get paid', 'xpokefun'), { kind: 'wallet' })
  const db = fresh()
  ensureTrainer(db, { id: 'h:ash', handle: 'ash' })
  assert.match((await say(db, 'ash', { kind: 'wallet' })).reply, /no wallet linked yet\. link your Solana wallet at xpoke\.fun\/wallet/)
  const kp = Keypair.generate()
  link(db, 'ash', kp)
  const r = (await say(db, 'ash', { kind: 'wallet' })).reply
  assert.match(r, new RegExp(kp.publicKey.toBase58().slice(0, 4)))
})

test('every wager reply fits X (links counted as 23), instructions never cut off', async () => {
  const { xLength } = await import('../src/game/engine.ts')
  const db = fresh()
  const A = 'abcdefghijklmno'
  const B = 'pqrstuvwxyzabcd'
  await teams(db, A, B)
  db.prepare("update pokemon set level = 150, shiny = 1, species_id = 740").run() // Crabominable, the longest names
  const made = (await say(db, A, { kind: 'wager', target: B, amount: 1000000 })).reply
  assert.ok(xLength(made) <= 280, `create: ${xLength(made)}`)
  assert.match(made, /accept wager/)
  assert.match(made, /xpoke\.fun\/wallet/)
  const acc = (await say(db, B, { kind: 'accept', wager: true })).reply
  assert.ok(xLength(acc) <= 280, `accept: ${xLength(acc)}`)
  assert.match(acc, /xpoke\.fun\/wallet/)
  assert.match(acc, /xpoke\.fun\/me/)
})

test('prize tournament: needs a linked wallet, pays the wallet linked at join, never more than the prize', async () => {
  const { createTournament } = await import('../src/game/tournament.ts')
  const { solvencyProblem } = await import('../src/pay/solana.ts')
  const db = fresh()
  createTournament(db, 'Cup', '500 $XPOKE', '500000000')
  const names = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8']
  for (const n of names) await teams(db, n)
  assert.match((await say(db, 't1', { kind: 'tournament_join' })).reply, /link yours at xpoke\.fun\/wallet/)
  const wallets = new Map<string, string>()
  for (const n of names) wallets.set(n, link(db, n, Keypair.generate()))
  for (const n of names.slice(0, 7)) assert.match((await say(db, n, { kind: 'tournament_join' })).reply, /registered/)
  // t8 relinks AFTER joining would not matter; it joins last and the bracket runs
  const out = await say(db, 't8', { kind: 'tournament_join' })
  assert.match(out.announce!.at(-1)!, /500 \$XPOKE is on its way to their wallet/)
  const t = db.prepare("select winner_id from tournaments where id = 1").get() as { winner_id: string }
  const row = db.prepare("select * from ledger where ref_kind = 'tournament'").get() as { to_addr: string; amount: string } & Record<string, unknown>
  assert.equal(row.to_addr, wallets.get(t.winner_id.slice(2)))
  assert.equal(row.amount, '500000000')
  assert.equal(solvencyProblem(db, row as never), null)
  db.prepare("update ledger set status = 'confirmed' where ref_kind = 'tournament'").run()
  db.prepare("insert into ledger (kind, ref_kind, ref_id, to_addr, amount, status, created_at, updated_at) values ('payout','tournament',1,'X','1','pending',0,0)").run()
  assert.match(solvencyProblem(db, db.prepare("select * from ledger where to_addr = 'X'").get() as never)!, /more than tournament/)
})

test('accepting a wager queues one exact pull per side with a linked wallet, none otherwise', async () => {
  const db = fresh()
  await teams(db, 'ash', 'gary')
  const w1 = link(db, 'ash', Keypair.generate())
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 100 })
  await say(db, 'gary', { kind: 'accept', wager: true })
  const w = getWager(db, 1)!
  const pulls = (db.prepare('select side, owner, amount, status from pulls').all() as object[]).map((r) => ({ ...r }))
  assert.deepEqual(pulls, [{ side: 'a', owner: w1, amount: w.amount, status: 'pending' }])
})

test('escrow reservation counts running wager payments and queued payouts', async () => {
  const { escrowReserved } = await import('../src/pay/solana.ts')
  const db = fresh()
  await teams(db, 'ash', 'gary')
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 100 })
  await say(db, 'gary', { kind: 'accept', wager: true })
  const w = getWager(db, 1)!
  handleTransfer(db, { txHash: 'e1', logIndex: 0, from: 'A1', amount: w.pay_a!, block: 1 })
  assert.equal(escrowReserved(db, -1), BigInt(w.pay_a!))
})

test('a pull is credited by its signature for the exact stake; a pull after a manual payment is refunded', async () => {
  const db = fresh()
  await teams(db, 'ash', 'gary')
  const aw = link(db, 'ash', Keypair.generate())
  const gw = link(db, 'gary', Keypair.generate())
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 100 })
  await say(db, 'gary', { kind: 'accept', wager: true })
  const w = getWager(db, 1)!
  db.prepare("update pulls set status = 'signed', sig = 'PULL_A' where side = 'a'").run()
  db.prepare("update pulls set status = 'signed', sig = 'PULL_B' where side = 'b'").run()
  // a transfer of the exact stake WITHOUT a pull signature is not a payment for anyone
  assert.equal(handleTransfer(db, { txHash: 'random', logIndex: 0, from: aw, amount: w.amount, block: 1 })!.kind, 'unmatched')
  // ash's pull lands: side a paid with exactly the stake
  assert.equal(handleTransfer(db, { txHash: 'PULL_A', logIndex: 0, from: aw, amount: w.amount, block: 2 })!.kind, 'wager')
  assert.equal(getWager(db, 1)!.paid_a_amount, w.amount)
  // gary paid by hand first; his pull landing afterwards goes back to his linked wallet
  handleTransfer(db, { txHash: 'manual', logIndex: 0, from: 'GaryHot', amount: w.pay_b!, block: 3 })
  assert.equal(getWager(db, 1)!.status, 'complete')
  assert.equal(handleTransfer(db, { txHash: 'PULL_B', logIndex: 0, from: gw, amount: w.amount, block: 4 })!.kind, 'refund')
  const refund = db.prepare("select to_addr, amount from ledger where kind = 'refund'").get() as { to_addr: string; amount: string }
  assert.deepEqual({ ...refund }, { to_addr: gw, amount: w.amount })
  // the pot is exactly what came in for the wager, so the payout + burn equal it
  const pot = BigInt(w.amount) + BigInt(w.pay_b!)
  const out = (db.prepare("select amount from ledger where ref_kind = 'wager' and kind in ('payout','burn')").all() as { amount: string }[]).reduce((a, r) => a + BigInt(r.amount), 0n)
  assert.equal(out, pot)
})
