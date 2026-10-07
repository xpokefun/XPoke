import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, type DB } from '../src/db.ts'
import { run } from '../src/game/engine.ts'
import { ensureTrainer, getTrainer, party, applyXp, getMon } from '../src/game/store.ts'
import { trainerLevel, xpLoss, growthStage } from '../src/game/rules.ts'
import { handleTransfer } from '../src/pay/match.ts'
import { getWager } from '../src/game/wager.ts'
import { createTournament } from '../src/game/tournament.ts'

function fresh(): DB {
  return openDb(mkdtempSync(join(tmpdir(), 'xpoke-')))
}
/** A deterministic rand that cycles through the given values. */
function seq(...v: number[]) {
  let i = 0
  return () => v[i++ % v.length]!
}
const SITE = 'https://xpoke.test'

async function say(db: DB, handle: string, cmd: Parameters<typeof run>[1], rand = Math.random) {
  const actor = ensureTrainer(db, { id: `h:${handle}`, handle })
  return (await run({ db, actor, site: SITE, rand }, cmd)).reply
}

async function giveParty(db: DB, handle: string, n = 3) {
  for (let i = 0; i < n; i++) await say(db, handle, { kind: 'catch', ball: 'poke' }, seq(0.01, 0.5, 0.9, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5))
}

test('trainer levels match the docs table', () => {
  const table: [number, number][] = [[0, 1], [2, 2], [4, 3], [7, 4], [12, 5], [20, 6], [35, 7], [60, 8], [100, 9], [200, 10], [199, 9]]
  for (const [wins, lv] of table) assert.equal(trainerLevel(wins), lv, `${wins} wins`)
})

test('xp protection and growth stages', () => {
  assert.equal(xpLoss(1, false), 0)
  assert.equal(xpLoss(2, true), 0)
  assert.equal(xpLoss(3, false), 10)
  assert.equal(xpLoss(4, true), 20)
  assert.equal(xpLoss(5, false), 25)
  assert.equal(xpLoss(5, true), 50)
  assert.deepEqual([0, 2, 3, 5, 6, 40].map(growthStage), ['Baby', 'Baby', 'Teen', 'Teen', 'Adult', 'Adult'])
})

test('xp never below 0 and level never decreases', async () => {
  const db = fresh()
  await giveParty(db, 'ash', 1)
  const m = party(db, 'h:ash')[0]!
  applyXp(db, m, 230)
  let after = getMon(db, m.id)!
  assert.equal(after.level, 3)
  assert.equal(after.xp, 30)
  applyXp(db, after, -50)
  after = getMon(db, m.id)!
  assert.equal(after.level, 3)
  assert.equal(after.xp, 0)
})

test('5 free balls, free stock used first, out of balls refuses', async () => {
  const db = fresh()
  for (let i = 0; i < 5; i++) await say(db, 'ash', { kind: 'catch', ball: 'poke' }, seq(0.99))
  assert.equal(getTrainer(db, 'h:ash')!.free_balls, 0)
  assert.match(await say(db, 'ash', { kind: 'catch', ball: 'poke' }), /out of pokeballs/)
})

test('party max 3, overflow goes to Box 1', async () => {
  const db = fresh()
  db.prepare("update trainers set free_balls = 10 where id = 'h:ash'").run()
  ensureTrainer(db, { id: 'h:ash', handle: 'ash' })
  db.prepare("update trainers set free_balls = 10 where id = 'h:ash'").run()
  for (let i = 0; i < 4; i++) await say(db, 'ash', { kind: 'catch', ball: 'poke' }, seq(0.01, 0.5, 0.9))
  assert.equal(party(db, 'h:ash').length, 3)
  const box = db.prepare("select count(*) as n from pokemon where trainer_id = 'h:ash' and location = 'box1'").get() as { n: number }
  assert.equal(box.n, 1)
})

test('master ball pity: guaranteed after 10 failed throws in a row', async () => {
  const db = fresh()
  ensureTrainer(db, { id: 'h:ash', handle: 'ash' })
  db.prepare("update trainers set master_balls = 1, fail_streak = 10 where id = 'h:ash'").run()
  const r = await say(db, 'ash', { kind: 'catch', ball: 'master' }, seq(0.999))
  assert.match(r, /gotcha/)
  assert.equal(getTrainer(db, 'h:ash')!.fail_streak, 0)
})

test('release needs confirm', async () => {
  const db = fresh()
  await giveParty(db, 'ash', 1)
  const name = (await say(db, 'ash', { kind: 'check' })).match(/1\. (?:shiny )?([A-Za-z.'♀♂ -]+?) Lv/)![1]!
  assert.match(await say(db, 'ash', { kind: 'release', pick: { index: 0 }, confirm: false }), /confirm/)
  assert.equal(party(db, 'h:ash').length, 1)
  assert.match(await say(db, 'ash', { kind: 'release', pick: { index: 0 }, confirm: true }), new RegExp(`bye bye ${name}`))
  assert.equal(party(db, 'h:ash').length, 0)
})

test('wager: unique amounts, 99% payout, 1% burn, late payment refunded', async () => {
  const db = fresh()
  await giveParty(db, 'ash')
  await giveParty(db, 'gary')
  assert.match(await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 1000 }), /wagers 1,000/)
  // team is locked while the wager is pending
  assert.match(await say(db, 'ash', { kind: 'release', pick: { index: 0 }, confirm: true }), /locked/)
  assert.match(await say(db, 'gary', { kind: 'accept' }), /wager accepted/)
  const w = getWager(db, 1)!
  assert.equal(w.status, 'awaiting_payment')
  assert.notEqual(w.pay_a, w.pay_b)
  assert.ok(BigInt(w.pay_a!) > 1000n * 10n ** 6n && BigInt(w.pay_a!) < 1001n * 10n ** 6n)
  // wrong amount does not count
  assert.equal(handleTransfer(db, { txHash: '0x01', logIndex: 0, from: '0xaaa', amount: (1000n * 10n ** 6n).toString(), block: 1 })!.kind, 'unmatched')
  handleTransfer(db, { txHash: '0x02', logIndex: 0, from: '0xaaa', amount: w.pay_a!, block: 2 })
  // the same log twice is ignored
  assert.equal(handleTransfer(db, { txHash: '0x02', logIndex: 0, from: '0xaaa', amount: w.pay_a!, block: 2 }), null)
  const r = handleTransfer(db, { txHash: '0x03', logIndex: 0, from: '0xbbb', amount: w.pay_b!, block: 3 })!
  assert.equal(r.kind, 'wager')
  assert.match(r.announce!, /burned/)
  const done = getWager(db, 1)!
  assert.equal(done.status, 'complete')
  const pot = BigInt(w.pay_a!) + BigInt(w.pay_b!)
  const rows = db.prepare("select kind, to_addr, amount from ledger where kind in ('payout','burn') order by id").all() as { kind: string; to_addr: string; amount: string }[]
  const payout = BigInt(rows.find((x) => x.kind === 'payout')!.amount)
  const burn = BigInt(rows.find((x) => x.kind === 'burn')!.amount)
  assert.equal(payout + burn, pot)
  assert.equal(burn, pot / 100n)
  assert.equal(rows.find((x) => x.kind === 'payout')!.to_addr, done.winner === 0 ? '0xaaa' : '0xbbb')
  // paying again after it finished is refunded to the sender
  assert.equal(handleTransfer(db, { txHash: '0x04', logIndex: 0, from: '0xccc', amount: w.pay_b!, block: 4 })!.kind, 'refund')
  assert.ok(db.prepare("select 1 from ledger where kind = 'refund' and to_addr = '0xccc'").get())
  // a trainer win was counted
  const wins = getTrainer(db, 'h:ash')!.wins + getTrainer(db, 'h:gary')!.wins
  assert.equal(wins, 1)
})

test('wager: cancel blocked after a payment until the window passes, then refunds', async () => {
  const db = fresh()
  await giveParty(db, 'ash')
  await giveParty(db, 'gary')
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 50 })
  await say(db, 'gary', { kind: 'accept' })
  const w = getWager(db, 1)!
  handleTransfer(db, { txHash: '0x10', logIndex: 0, from: '0xaaa', amount: w.pay_a!, block: 1 })
  assert.match(await say(db, 'ash', { kind: 'cancel' }), /15 minute window/)
  db.prepare('update wagers set pay_deadline = 0 where id = 1').run()
  assert.match(await say(db, 'ash', { kind: 'cancel' }), /refunded/)
  const refund = db.prepare("select * from ledger where kind = 'refund'").get() as { to_addr: string; amount: string }
  assert.equal(refund.to_addr, '0xaaa')
  assert.equal(refund.amount, w.pay_a)
})

test('wager needs exactly 3 party pokemon and one wager at a time', async () => {
  const db = fresh()
  await giveParty(db, 'ash', 2)
  await giveParty(db, 'gary')
  assert.match(await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 10 }), /exactly 3/)
  await giveParty(db, 'ash', 1)
  assert.match(await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 0.5 }), /minimum/)
  assert.match(await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 10 }), /wagers 10/)
  assert.match(await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 10 }), /already have an active wager/)
})

test('shop order credits balls on the exact amount', async () => {
  const db = fresh()
  ensureTrainer(db, { id: 'h:ash', handle: 'ash' })
  db.prepare("insert into orders (trainer_id, ball, qty, amount, status, created_at, expires_at) values ('h:ash','ultra',3,'6000000123','pending',0,0)").run()
  assert.equal(handleTransfer(db, { txHash: '0x20', logIndex: 0, from: '0xaaa', amount: '6000000123', block: 1 })!.kind, 'order')
  assert.equal(getTrainer(db, 'h:ash')!.ultra_balls, 3)
  // and the whole payment is queued for burning, guarded by the order's own payment
  const { solvencyProblem } = await import('../src/pay/solana.ts')
  const burn = db.prepare("select * from ledger where kind = 'burn' and ref_kind = 'order'").get() as { amount: string } & Record<string, unknown>
  assert.equal(burn.amount, '6000000123')
  assert.equal(solvencyProblem(db, burn as never), null)
  db.prepare("update ledger set status = 'confirmed' where kind = 'burn'").run()
  db.prepare("insert into ledger (kind, ref_kind, ref_id, to_addr, amount, status, created_at, updated_at) values ('burn','order',1,'burn','1','pending',0,0)").run()
  assert.match(solvencyProblem(db, db.prepare("select * from ledger where amount = '1'").get() as never)!, /more than order/)
  db.prepare("insert into ledger (kind, ref_kind, ref_id, to_addr, amount, status, created_at, updated_at) values ('payout','order',1,'Thief','5','pending',0,0)").run()
  assert.match(solvencyProblem(db, db.prepare("select * from ledger where to_addr = 'Thief'").get() as never)!, /only burns/)
})

test('pvp: challenge locks, accept battles, both get xp result', async () => {
  const db = fresh()
  await giveParty(db, 'ash', 1)
  await giveParty(db, 'gary', 1)
  assert.match(await say(db, 'ash', { kind: 'challenge', target: 'gary' }), /challenged/)
  assert.match(await say(db, 'ash', { kind: 'release', pick: { index: 0 }, confirm: true }), /locked/)
  assert.match(await say(db, 'gary', { kind: 'accept' }), /pvp!/)
  assert.equal(getTrainer(db, 'h:ash')!.wins + getTrainer(db, 'h:gary')!.wins, 1)
  assert.match(await say(db, 'gary', { kind: 'accept' }), /no pending/)
})

test('gym bot when nobody is within 5 levels, medal once', async () => {
  const db = fresh()
  await giveParty(db, 'ash', 1)
  db.prepare("update pokemon set level = 60 where trainer_id = 'h:ash'").run()
  const r = await say(db, 'ash', { kind: 'battle' })
  assert.match(r, /gym battle! .*Cheren|Cheren's Rattata/)
  assert.match(r, /medal/)
  db.prepare("update pokemon set last_battle_at = null").run()
  const r2 = await say(db, 'ash', { kind: 'battle' })
  assert.match(r2, /Skyla/)
  assert.match(await say(db, 'ash', { kind: 'battle' }), /resting/)
})

test('tournament runs at 8 and seeds by wins', async () => {
  const db = fresh()
  createTournament(db, 'Cup', '1 $XPOKE')
  const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8']
  for (const n of names) await giveParty(db, n, 1)
  db.prepare("update trainers set wins = 50 where id = 'h:a8'").run()
  for (const n of names.slice(0, 7)) assert.match(await say(db, n, { kind: 'tournament_join' }), /registered/)
  const actor = ensureTrainer(db, { id: 'h:a8', handle: 'a8' })
  const out = await run({ db, actor, site: SITE }, { kind: 'tournament_join' })
  assert.match(out.reply, /8\/8/)
  assert.equal(out.announce!.length, 3)
  const seed1 = db.prepare("select seed from tournament_entries where trainer_id = 'h:a8'").get() as { seed: number }
  assert.equal(seed1.seed, 1)
  assert.match(await say(db, 'a1', { kind: 'tournament_join' }), /no tournament is open/)
})

test('trade: offer from party, accepted on the site swaps owners', async () => {
  const { resolveTrade } = await import('../src/game/trade.ts')
  const db = fresh()
  await giveParty(db, 'ash', 1)
  await giveParty(db, 'gary', 1)
  const mine = party(db, 'h:ash')[0]!
  const theirs = party(db, 'h:gary')[0]!
  const { species } = await import('../src/game/data.ts')
  const r = await say(db, 'ash', { kind: 'trade', target: 'gary', offer: species(mine.species_id).name, want: species(theirs.species_id).name })
  assert.match(r, /trade offer/)
  assert.equal(resolveTrade(db, 1, 'h:ash', true).ok, false) // only the receiver accepts
  assert.equal(resolveTrade(db, 1, 'h:gary', true).ok, true)
  assert.equal(getMon(db, mine.id)!.trainer_id, 'h:gary')
  assert.equal(getMon(db, theirs.id)!.trainer_id, 'h:ash')
})

test('a wager-locked team cannot be evolved, battled or sent into pvp', async () => {
  const db = fresh()
  await giveParty(db, 'ash')
  await giveParty(db, 'gary')
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 10 })
  await say(db, 'gary', { kind: 'accept' })
  db.prepare("update pokemon set level = 99 where trainer_id = 'h:ash'").run()
  assert.match(await say(db, 'ash', { kind: 'evolve', pick: { index: 0 } }), /pending wager/)
  assert.match(await say(db, 'ash', { kind: 'battle', pick: { index: 0 } }), /locked in a pending wager/)
  assert.match(await say(db, 'gary', { kind: 'challenge', target: 'ash' }), /pending wager/)
})

test('"accept" takes the friendly challenge, not an unsolicited wager', async () => {
  const db = fresh()
  await giveParty(db, 'ash')
  await giveParty(db, 'gary')
  await giveParty(db, 'rocket')
  await say(db, 'ash', { kind: 'challenge', target: 'gary' })
  await say(db, 'rocket', { kind: 'wager', target: 'gary', amount: 5 })
  assert.match(await say(db, 'gary', { kind: 'accept' }), /pvp!/)
  assert.equal(getWager(db, 1)!.status, 'pending_accept', 'the wager was not accepted by a plain accept')
  // with both pending, a plain decline refuses the challenge and leaves the wager for an explicit answer
  db.prepare('update pokemon set last_battle_at = null').run()
  assert.match(await say(db, 'ash', { kind: 'challenge', target: 'gary' }), /challenged/)
  assert.match(await say(db, 'gary', { kind: 'decline' }), /declined 1 challenge. a wager is still waiting/)
  assert.equal(getWager(db, 1)!.status, 'pending_accept')
  assert.match(await say(db, 'gary', { kind: 'decline', wager: true }), /declined the wager/)
  assert.equal(getWager(db, 1)!.status, 'cancelled')
})

test('a pokemon in a pending trade is locked, and the trade itself still completes', async () => {
  const { resolveTrade } = await import('../src/game/trade.ts')
  const { species } = await import('../src/game/data.ts')
  const db = fresh()
  await giveParty(db, 'ash', 1)
  await giveParty(db, 'gary', 1)
  const mine = party(db, 'h:ash')[0]!
  await say(db, 'ash', { kind: 'trade', target: 'gary', offer: species(mine.species_id).name })
  assert.match(await say(db, 'ash', { kind: 'release', pick: { index: 0 }, confirm: true }), /pending trade/)
  db.prepare("update pokemon set level = 99 where id = ?").run(mine.id)
  assert.match(await say(db, 'ash', { kind: 'evolve', pick: { index: 0 } }), /pending trade/)
  assert.equal(resolveTrade(db, 1, 'h:gary', true).ok, true)
})

test('non-players are never @-mentioned', async () => {
  const db = fresh()
  await giveParty(db, 'ash')
  for (const r of [
    await say(db, 'ash', { kind: 'challenge', target: 'elonmusk' }),
    await say(db, 'ash', { kind: 'wager', target: 'elonmusk', amount: 10 }),
    await say(db, 'ash', { kind: 'trade', target: 'elonmusk', offer: 'Pikachu' }),
  ])
    assert.doesNotMatch(r, /@elonmusk/)
})

test('solvency guard: nothing leaves for a wager beyond what was paid in', async () => {
  const { solvencyProblem } = await import('../src/pay/solana.ts')
  const db = fresh()
  await giveParty(db, 'ash')
  await giveParty(db, 'gary')
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 1000 })
  await say(db, 'gary', { kind: 'accept' })
  const w = getWager(db, 1)!
  handleTransfer(db, { txHash: 's1', logIndex: 0, from: 'A1', amount: w.pay_a!, block: 1 })
  handleTransfer(db, { txHash: 's2', logIndex: 0, from: 'B1', amount: w.pay_b!, block: 2 })
  const rows = db.prepare("select * from ledger where kind in ('payout','burn') order by id").all() as never[]
  for (const r of rows) assert.equal(solvencyProblem(db, r), null)
  // a forged extra payout for the same wager is refused once the real ones are out
  db.prepare("update ledger set status = 'confirmed' where kind in ('payout','burn')").run()
  db.prepare("insert into ledger (kind, ref_kind, ref_id, to_addr, amount, status, created_at, updated_at) values ('payout','wager',1,'X','1','pending',0,0)").run()
  const forged = db.prepare("select * from ledger where to_addr = 'X'").get() as never
  assert.match(solvencyProblem(db, forged)!, /only .* was paid in/)
})

test('a duplicate wager payment never raises the wager\'s paid-in ceiling', async () => {
  const { solvencyProblem } = await import('../src/pay/solana.ts')
  const db = fresh()
  await giveParty(db, 'ash')
  await giveParty(db, 'gary')
  await say(db, 'ash', { kind: 'wager', target: 'gary', amount: 100 })
  await say(db, 'gary', { kind: 'accept' })
  const w = getWager(db, 1)!
  handleTransfer(db, { txHash: 'd1', logIndex: 0, from: 'A1', amount: w.pay_a!, block: 1 })
  handleTransfer(db, { txHash: 'd2', logIndex: 0, from: 'ZZ', amount: w.pay_a!, block: 2 }) // stranger pays side A again
  handleTransfer(db, { txHash: 'd3', logIndex: 0, from: 'B1', amount: w.pay_b!, block: 3 })
  const paidIn = (db.prepare("select coalesce(sum(amount),0) s from ledger where kind = 'payment' and ref_kind = 'wager' and ref_id = 1").get() as { s: number }).s
  assert.equal(BigInt(paidIn), BigInt(w.pay_a!) + BigInt(w.pay_b!), 'only the two funding payments count')
  const refund = db.prepare("select * from ledger where kind = 'refund'").get() as { to_addr: string; amount: string } & Record<string, unknown>
  assert.equal(refund.to_addr, 'ZZ')
  assert.equal(solvencyProblem(db, refund as never), null, 'the stranger is refunded in full')
  db.prepare("update ledger set status = 'confirmed' where kind in ('payout','burn','refund')").run()
  db.prepare("insert into ledger (kind, ref_kind, ref_id, to_addr, amount, status, created_at, updated_at) values ('payout','wager',1,'X','1','pending',0,0)").run()
  assert.match(solvencyProblem(db, db.prepare("select * from ledger where to_addr = 'X'").get() as never)!, /only .* was paid in/)
})
