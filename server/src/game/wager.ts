/**
 * Wagers: $XPOKE-staked 3v3 battles.
 *
 * challenge → (accept within 24h) → both pay their unique amount within 15 min → battle runs →
 * winner receives 99% of what both sides sent, 1% is burned. A miss of the window cancels the
 * wager and refunds whoever paid.
 */
import { type DB, now } from '../db.ts'
import { teamBattle } from './battle.ts'
import { WAGER, PARTY_MAX } from './rules.ts'
import { fighterOf, getMon, getTrainer, lockedIds, monName, party, sp, trainerByHandle, type Mon } from './store.ts'
import type { Ctx } from './engine.ts'
import { addTrainerResult, recordBattle, battleDetail, fit, xLength } from './engine.ts'
import { roundAmount, showAmount, toWei, uniqueAmount } from '../pay/amounts.ts'
import { addLedger, BURN_TARGET } from '../pay/ledger.ts'
import { queuePulls } from '../pay/pull.ts'

export type Wager = {
  id: number
  challenger_id: string
  target_id: string
  amount: string
  status: 'pending_accept' | 'awaiting_payment' | 'complete' | 'cancelled'
  team_a: string | null
  team_b: string | null
  pay_a: string | null
  pay_b: string | null
  paid_a_tx: string | null
  paid_b_tx: string | null
  paid_a_from: string | null
  paid_b_from: string | null
  paid_a_amount: string | null
  paid_b_amount: string | null
  created_at: number
  accepted_at: number | null
  pay_deadline: number | null
  winner: number | null
  battle_id: number | null
  cancel_reason: string | null
  finished_at: number | null
  /** linked wallet of each side when the wager was accepted; null = pay the wallet that paid */
  payout_a: string | null
  payout_b: string | null
}

/** Where a side's money goes: the wallet linked at acceptance, else the wallet that paid. */
function payoutOf(w: Wager, side: 'a' | 'b'): string | null {
  return side === 'a' ? (w.payout_a ?? w.paid_a_from) : (w.payout_b ?? w.paid_b_from)
}


export const TOKEN = process.env.TOKEN_SYMBOL ?? 'XPOKE'

export function getWager(db: DB, id: number): Wager | null {
  return (db.prepare('select * from wagers where id = ?').get(id) as Wager | undefined) ?? null
}

export function activeWagerOf(db: DB, trainerId: string): Wager | null {
  return (
    (db
      .prepare("select * from wagers where status in ('pending_accept','awaiting_payment') and (challenger_id = ? or target_id = ?)")
      .get(trainerId, trainerId) as Wager | undefined) ?? null
  )
}

export function incomingWager(db: DB, trainerId: string): Wager | null {
  expireWagers(db)
  return (
    (db
      .prepare("select * from wagers where status = 'pending_accept' and target_id = ? order by created_at limit 1")
      .get(trainerId) as Wager | undefined) ?? null
  )
}

/** Exactly 3 party Pokémon, all wager-eligible and free of other locks. */
function teamProblem(db: DB, trainerId: string, who: string): { team: Mon[]; problem: string | null } {
  const team = party(db, trainerId)
  if (team.length !== PARTY_MAX)
    return { team, problem: `${who} need${who === 'you' ? '' : 's'} exactly 3 pokemon in the party to wager (has ${team.length})` }
  const legacy = team.find((m) => !m.wager_eligible)
  if (legacy) return { team, problem: `${sp(legacy).name} is a legacy pokemon and can't enter wagers` }
  const locks = lockedIds(db)
  const locked = team.find((m) => locks.has(m.id))
  if (locked) return { team, problem: `${sp(locked).name} is locked in another battle` }
  return { team, problem: null }
}

export function createWager(c: Ctx, targetHandle: string, amount: number): string {
  const { db, actor } = c
  expireWagers(db)
  if (!Number.isFinite(amount) || amount < WAGER.minAmount) return `the minimum wager is ${WAGER.minAmount} $${TOKEN}`
  if (amount > 1e12) return 'that amount is too large'
  if (targetHandle.toLowerCase() === actor.handle.toLowerCase()) return "you can't wager against yourself"
  const opp = trainerByHandle(db, targetHandle)
  if (!opp) return `that trainer hasn't started playing yet`
  if (activeWagerOf(db, actor.id)) return 'you already have an active wager. one at a time, finish or cancel it first'
  if (activeWagerOf(db, opp.id)) return `@${opp.handle} is already in an active wager`
  const mine = teamProblem(db, actor.id, 'you')
  if (mine.problem) return mine.problem
  const theirs = teamProblem(db, opp.id, `@${opp.handle}`)
  if (theirs.problem && !theirs.problem.includes('locked')) return theirs.problem
  const whole = toWei(amount.toFixed(6))
  db.prepare(
    "insert into wagers (challenger_id, target_id, amount, status, team_a, created_at) values (?,?,?,'pending_accept',?,?)",
  ).run(actor.id, opp.id, whole.toString(), JSON.stringify(mine.team.map((m) => m.id)), now())
  const host = c.site.replace(/^https?:\/\//, '')
  const tail = `@${opp.handle} reply "accept wager" to lock in your team of 3, then both pay at ${host}/me` +
    (actor.wallet && opp.wallet ? '' : `. link a wallet at ${host}/wallet to get paid there`)
  // the instructions must survive: drop detail from the team list before anything else
  const teams = [
    mine.team.map((m) => `${monName(m)} Lv.${m.level}`).join(', '),
    mine.team.map((m) => sp(m).name).join(', '),
    null,
  ]
  for (const team of teams) {
    const text = `@${opp.handle} @${actor.handle} wagers ${showAmount(whole)} $${TOKEN} on a 3v3!${team ? ` team: ${team}.` : ''} ${tail}`
    if (xLength(text) <= 280) return text
  }
  return fit(`@${opp.handle} @${actor.handle} wagers ${showAmount(whole)} $${TOKEN} on a 3v3! ${tail}`)
}

export function acceptWager(c: Ctx, w: Wager): string {
  const { db, actor } = c
  if (w.target_id !== actor.id || w.status !== 'pending_accept') return 'there is no wager waiting for you'
  const challenger = getTrainer(db, w.challenger_id)!
  // the challenger's team must still be theirs and in the party
  const teamA = (JSON.parse(w.team_a ?? '[]') as number[]).map((id) => getMon(db, id))
  if (teamA.some((m) => !m || m.trainer_id !== challenger.id || m.location !== 'party')) {
    cancelWager(db, w, "challenger's team changed")
    return `@${challenger.handle}'s team changed, so the wager was cancelled`
  }
  const mine = teamProblem(db, actor.id, 'you')
  if (mine.problem) return mine.problem
  const whole = BigInt(w.amount)
  const payA = uniqueAmount(db, whole, c.rand)
  // reserve A before drawing B so the two can never collide
  db.prepare('update wagers set pay_a = ? where id = ?').run(payA, w.id)
  const payB = uniqueAmount(db, whole, c.rand)
  const t = now()
  db.prepare(
    // ⚠ payout addresses are fixed here: changing the linked wallet afterwards never redirects this wager
    "update wagers set status = 'awaiting_payment', team_b = ?, pay_b = ?, accepted_at = ?, pay_deadline = ?, payout_a = ?, payout_b = ? where id = ?",
  ).run(JSON.stringify(mine.team.map((m) => m.id)), payB, t, t + WAGER.payWindow, challenger.wallet, actor.wallet, w.id)
  // sides with a linked wallet are charged from their wager allowance (if they set one) right away
  // a pull takes the exact stake (no unique tail: it is recognised by its own signature, not its amount), so
  // approving exactly what you wager is enough, and repeated wagers use exactly what was wagered
  queuePulls(db, w.id, [
    { side: 'a', owner: challenger.wallet, amount: w.amount },
    { side: 'b', owner: actor.wallet, amount: w.amount },
  ])
  const host = c.site.replace(/^https?:\/\//, '')
  const head = `@${challenger.handle} @${actor.handle} wager accepted! teams locked.`
  const none = [challenger, actor].filter((x) => !x.wallet).map((x) => `@${x.handle}`).join(' ')
  // longest first; the first that fits X wins. paying is the instruction that must never be lost
  const candidates = [
    `${head} a wager allowance pays automatically, otherwise pay your exact amount at ${host}/me within 15 min.${none ? ` ${none} link a wallet at ${host}/wallet to get paid there` : ' winnings go to your linked wallets'}`,
    `${head} allowance pays automatically, else pay at ${host}/me within 15 min.${none ? ` ${none} link a wallet at ${host}/wallet` : ''}`,
    `${head} pay at ${host}/me within 15 min (allowances pay automatically).${none ? ` link a wallet: ${host}/wallet` : ''}`,
  ]
  return candidates.find((x) => xLength(x) <= 280) ?? fit(candidates[candidates.length - 1]!)
}

function refundPaid(db: DB, w: Wager): void {
  if (w.paid_a_tx && w.paid_a_from && w.paid_a_amount)
    addLedger(db, { kind: 'refund', ref_kind: 'wager', ref_id: w.id, to_addr: payoutOf(w, 'a')!, amount: w.paid_a_amount, status: 'pending' })
  if (w.paid_b_tx && w.paid_b_from && w.paid_b_amount)
    addLedger(db, { kind: 'refund', ref_kind: 'wager', ref_id: w.id, to_addr: payoutOf(w, 'b')!, amount: w.paid_b_amount, status: 'pending' })
}

export function cancelWager(db: DB, w: Wager, reason: string): void {
  const r = db
    .prepare("update wagers set status = 'cancelled', cancel_reason = ?, finished_at = ? where id = ? and status in ('pending_accept','awaiting_payment')")
    .run(reason, now(), w.id)
  if (r.changes) refundPaid(db, getWager(db, w.id)!)
}

/** Cancel rules from the docs: always before any payment, after a payment only once the window closed. */
export function cancelWagerBy(db: DB, w: Wager, trainerId: string, reason: string): string {
  if (w.challenger_id !== trainerId && w.target_id !== trainerId) return 'that is not your wager'
  if (w.status === 'pending_accept') {
    cancelWager(db, w, reason)
    return 'wager cancelled. your team is unlocked'
  }
  if (w.status !== 'awaiting_payment') return 'that wager is already finished'
  const anyPaid = w.paid_a_tx || w.paid_b_tx
  if (anyPaid && now() < (w.pay_deadline ?? 0))
    return 'a payment has already been made. cancel opens once the 15 minute window passes, and anyone who paid is refunded automatically'
  cancelWager(db, w, reason)
  return anyPaid ? 'wager cancelled. the payment that came in is being refunded' : 'wager cancelled. your team is unlocked'
}

export function expireWagers(db: DB): Wager[] {
  const t = now()
  const expired: Wager[] = []
  for (const w of db
    .prepare("select * from wagers where status = 'pending_accept' and created_at <= ?")
    .all(t - WAGER.acceptWindow) as Wager[]) {
    cancelWager(db, w, 'not accepted within 24 hours')
    expired.push(w)
  }
  for (const w of db
    .prepare("select * from wagers where status = 'awaiting_payment' and pay_deadline <= ?")
    .all(t) as Wager[]) {
    cancelWager(db, w, 'payment window passed')
    expired.push(w)
  }
  return expired
}

/**
 * A payment landed for one side. When both have paid, the battle runs at once.
 * @returns a public line to post when the wager settled, else null
 */
export function recordWagerPayment(
  db: DB,
  w: Wager,
  side: 'a' | 'b',
  p: { tx: string; from: string; amount: string },
): string | null {
  db.prepare(`update wagers set paid_${side}_tx = ?, paid_${side}_from = ?, paid_${side}_amount = ? where id = ? and paid_${side}_tx is null`).run(
    p.tx,
    p.from,
    p.amount,
    w.id,
  )
  const fresh = getWager(db, w.id)!
  if (fresh.status === 'awaiting_payment' && fresh.paid_a_tx && fresh.paid_b_tx) return settleWager(db, fresh)
  return null
}

export function settleWager(db: DB, w: Wager, rand: () => number = Math.random): string {
  const a = getTrainer(db, w.challenger_id)!
  const b = getTrainer(db, w.target_id)!
  const teamA = (JSON.parse(w.team_a!) as number[]).map((id) => getMon(db, id)!)
  const teamB = (JSON.parse(w.team_b!) as number[]).map((id) => getMon(db, id)!)
  const fa = teamA.map((m) => fighterOf(m, `@${a.handle}'s ${sp(m).name}`))
  const fb = teamB.map((m) => fighterOf(m, `@${b.handle}'s ${sp(m).name}`))
  const res = teamBattle(fa, fb, rand)
  const winnerTrainer = res.winner === 0 ? a : b
  const loser = res.winner === 0 ? b : a
  const battleId = recordBattle(db, {
    kind: 'wager',
    a_trainer: a.id,
    a_pokemon: teamA[0]!.id,
    b_trainer: b.id,
    b_pokemon: teamB[0]!.id,
    winner: res.winner,
    detail: {
      wager: w.id,
      survivors: res.survivors,
      duels: res.duels.map((d) => ({ ai: d.a, bi: d.b, ...battleDetail(fa[d.a]!, fb[d.b]!, d.result) })),
    },
  })
  addTrainerResult(db, winnerTrainer.id, true)
  addTrainerResult(db, loser.id, false)
  const pot = BigInt(w.paid_a_amount!) + BigInt(w.paid_b_amount!)
  const burn = (pot * BigInt(WAGER.burnBps)) / 10_000n
  const payout = pot - burn
  const to = payoutOf(w, res.winner === 0 ? 'a' : 'b')!
  db.prepare("update wagers set status = 'complete', winner = ?, battle_id = ?, finished_at = ? where id = ?").run(
    res.winner,
    battleId,
    now(),
    w.id,
  )
  addLedger(db, { kind: 'payout', ref_kind: 'wager', ref_id: w.id, to_addr: to, amount: payout, status: 'pending' })
  addLedger(db, { kind: 'burn', ref_kind: 'wager', ref_id: w.id, to_addr: BURN_TARGET, amount: burn, status: 'pending' })
  const left = res.survivors[res.winner]
  return `wager #${w.id}: @${winnerTrainer.handle} beat @${loser.handle} 3v3 with ${left} pokemon standing and wins ${roundAmount(payout)} $${TOKEN}. ${roundAmount(burn)} $${TOKEN} burned forever`
}

export function wagerView(db: DB, w: Wager, viewerId?: string) {
  const a = getTrainer(db, w.challenger_id)
  const b = getTrainer(db, w.target_id)
  const team = (j: string | null) =>
    (JSON.parse(j ?? '[]') as number[]).map((id) => {
      const m = getMon(db, id)
      return m ? { id: m.id, name: sp(m).name, sprite: sp(m).form ?? sp(m).id, level: m.level, shiny: Boolean(m.shiny) } : null
    })
  const side = viewerId === w.challenger_id ? 'a' : viewerId === w.target_id ? 'b' : null
  return {
    id: w.id,
    status: w.status,
    amount: showAmount(w.amount),
    challenger: a ? { handle: a.handle, avatar: a.avatar } : null,
    target: b ? { handle: b.handle, avatar: b.avatar } : null,
    teamA: team(w.team_a),
    teamB: team(w.team_b),
    // ⚠ exact amounts only for the two trainers involved: with them anyone could pay a side and
    // redirect that side's payout to their own wallet
    payA: side && w.pay_a ? showAmount(w.pay_a) : null,
    payB: side && w.pay_b ? showAmount(w.pay_b) : null,
    payAWei: side ? w.pay_a : null,
    payBWei: side ? w.pay_b : null,
    paidA: Boolean(w.paid_a_tx),
    paidB: Boolean(w.paid_b_tx),
    paidATx: w.paid_a_tx,
    paidBTx: w.paid_b_tx,
    payDeadline: w.pay_deadline,
    winner: w.winner,
    battleId: w.battle_id,
    cancelReason: w.cancel_reason,
    createdAt: w.created_at,
    mySide: side,
    // where my winnings/refund go: fixed at acceptance (null before acceptance = my linked wallet at that time)
    myPayout: side === 'a' ? (w.payout_a ?? null) : side === 'b' ? (w.payout_b ?? null) : null,
    // my allowance pull for this wager, if one was queued: pending | signed | confirmed | skipped | failed (+ why)
    myAutoPay: side
      ? ((db.prepare('select status, error from pulls where wager_id = ? and side = ?').get(w.id, side) as { status: string; error: string | null } | undefined) ?? null)
      : null,
  }
}
