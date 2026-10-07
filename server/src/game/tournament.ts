/**
 * Tournaments: 8-player single elimination. First 8 to join are seeded 1–8 by trainer wins,
 * 1v8 2v7 3v6 4v5, then semis and a final. Each match uses the trainer's strongest-level party Pokémon.
 */
import { type DB, now } from '../db.ts'
import { addLedger } from '../pay/ledger.ts'
import { roundAmount } from '../pay/amounts.ts'
import { TOKEN } from './wager.ts'
import { duel } from './battle.ts'
import { TOURNAMENT_SIZE } from './rules.ts'
import { fighterOf, getTrainer, party, sp, type Mon } from './store.ts'
import { addTrainerResult, battleDetail, recordBattle, type Ctx, type Outcome } from './engine.ts'

export type Tournament = {
  id: number
  name: string
  prize: string | null
  status: 'open' | 'done' | 'cancelled'
  created_at: number
  finished_at: number | null
  winner_id: string | null
  bracket: string | null
  prize_amount: string | null
}

export function openTournament(db: DB): Tournament | null {
  return (db.prepare("select * from tournaments where status = 'open' order by id desc limit 1").get() as Tournament | undefined) ?? null
}

/**
 * @param prizeAmount token prize in base units, paid automatically to the champion's linked wallet
 *        (the operator sends it to the pool first). null = a text-only prize.
 */
export function createTournament(db: DB, name: string, prize: string | null, prizeAmount: string | null = null): Tournament {
  if (openTournament(db)) throw new Error('a tournament is already open')
  if (prizeAmount !== null && !(BigInt(prizeAmount) > 0n)) throw new Error('prize amount must be positive')
  const r = db
    .prepare("insert into tournaments (name, prize, status, created_at, prize_amount) values (?, ?, 'open', ?, ?)")
    .run(name, prize, now(), prizeAmount)
  return db.prepare('select * from tournaments where id = ?').get(Number(r.lastInsertRowid)) as Tournament
}

export function entries(db: DB, tid: number): { trainer_id: string; joined_at: number; seed: number | null }[] {
  return db.prepare('select * from tournament_entries where tournament_id = ? order by joined_at').all(tid) as never
}

function strongest(db: DB, trainerId: string): Mon | null {
  const p = party(db, trainerId)
  return [...p].sort((a, b) => b.level - a.level || sp(b).bst - sp(a).bst)[0] ?? null
}

export function joinTournament(c: Ctx): Outcome {
  const { db, actor } = c
  const t = openTournament(db)
  if (!t) return { reply: 'no tournament is open right now. follow along for the next one' }
  if (!party(db, actor.id).length) return { reply: 'you need at least one pokemon in your party to join' }
  const list = entries(db, t.id)
  if (list.some((e) => e.trainer_id === actor.id)) return { reply: `you're already registered. ${list.length}/8 spots filled` }
  if (list.length >= TOURNAMENT_SIZE) return { reply: 'the tournament is full' }
  const host = c.site.replace(/^https?:\/\//, '')
  // a token prize is paid to a wallet, so a prized tournament needs one, fixed now (a later change or a
  // stolen session can never redirect the prize)
  if (t.prize_amount && !actor.wallet)
    return { reply: `this tournament pays its prize to a linked wallet. link yours at ${host}/wallet (one free signature), then say "tournament join" again` }
  db.prepare('insert into tournament_entries (tournament_id, trainer_id, joined_at, wallet) values (?,?,?,?)').run(t.id, actor.id, now(), actor.wallet)
  const n = list.length + 1
  if (n < TOURNAMENT_SIZE)
    return { reply: `@${actor.handle} registered for the tournament. ${n}/8 spots filled. bracket at ${host}/tournament` }
  const announce = runTournament(db, t.id, c.rand)
  return { reply: `@${actor.handle} registered, that's 8/8! the tournament is running now. bracket at ${host}/tournament`, announce }
}

type Match = {
  round: 'Quarterfinal' | 'Semifinal' | 'Final'
  a: string
  b: string
  aMon: { name: string; level: number; sprite: number } | null
  bMon: { name: string; level: number; sprite: number } | null
  winner: string
  battleId: number | null
}

export function runTournament(db: DB, tid: number, rand: () => number = Math.random): string[] {
  const t = db.prepare('select * from tournaments where id = ?').get(tid) as Tournament
  const list = entries(db, tid)
    .slice(0, TOURNAMENT_SIZE)
    .map((e) => ({ ...e, wins: getTrainer(db, e.trainer_id)!.wins }))
    .sort((a, b) => b.wins - a.wins || a.joined_at - b.joined_at)
  list.forEach((e, i) => db.prepare('update tournament_entries set seed = ? where tournament_id = ? and trainer_id = ?').run(i + 1, tid, e.trainer_id))
  const seeds = list.map((e) => e.trainer_id)
  // 1v8, 4v5 | 2v7, 3v6 so seeds 1 and 2 can only meet in the final
  const order = [0, 7, 3, 4, 1, 6, 2, 5]
  let alive = order.map((i) => seeds[i]!)
  const matches: Match[] = []
  const rounds: Match['round'][] = ['Quarterfinal', 'Semifinal', 'Final']
  for (const round of rounds) {
    const next: string[] = []
    for (let i = 0; i < alive.length; i += 2) {
      const a = alive[i]!
      const b = alive[i + 1]!
      const ma = strongest(db, a)
      const mb = strongest(db, b)
      let winner: string
      let battleId: number | null = null
      if (!ma || !mb) {
        winner = ma ? a : b // a trainer with no party forfeits
      } else {
        const ta = getTrainer(db, a)!
        const tb = getTrainer(db, b)!
        const fa = fighterOf(ma, `@${ta.handle}'s ${sp(ma).name}`)
        const fb = fighterOf(mb, `@${tb.handle}'s ${sp(mb).name}`)
        const r = duel(fa, fb, rand)
        winner = r.winner === 0 ? a : b
        battleId = recordBattle(db, {
          kind: 'tournament',
          a_trainer: a,
          a_pokemon: ma.id,
          b_trainer: b,
          b_pokemon: mb.id,
          winner: r.winner,
          detail: { tournament: tid, round, ...battleDetail(fa, fb, r) },
        })
        addTrainerResult(db, winner, true)
        addTrainerResult(db, winner === a ? b : a, false)
      }
      const view = (m: Mon | null) => (m ? { name: sp(m).name, level: m.level, sprite: sp(m).form ?? sp(m).id } : null)
      matches.push({ round, a, b, aMon: view(ma), bMon: view(mb), winner, battleId })
      next.push(winner)
    }
    alive = next
  }
  const champion = alive[0]!
  db.prepare("update tournaments set status = 'done', finished_at = ?, winner_id = ?, bracket = ? where id = ?").run(
    now(),
    champion,
    JSON.stringify({ seeds, matches }),
    tid,
  )
  const h = (id: string) => `@${getTrainer(db, id)!.handle}`
  const final = matches[matches.length - 1]!
  let paid = ''
  if (t.prize_amount) {
    const entry = db.prepare('select wallet from tournament_entries where tournament_id = ? and trainer_id = ?').get(tid, champion) as { wallet: string | null }
    if (entry.wallet) {
      addLedger(db, { kind: 'payout', ref_kind: 'tournament', ref_id: tid, to_addr: entry.wallet, amount: t.prize_amount, status: 'pending' })
      paid = ` ${roundAmount(t.prize_amount)} $${TOKEN} is on its way to their wallet`
    }
  }
  const lines = [
    `${t.name} quarterfinals: ${matches.filter((m) => m.round === 'Quarterfinal').map((m) => `${h(m.winner)} beat ${h(m.winner === m.a ? m.b : m.a)}`).join(' · ')}`,
    `${t.name} semifinals: ${matches.filter((m) => m.round === 'Semifinal').map((m) => `${h(m.winner)} beat ${h(m.winner === m.a ? m.b : m.a)}`).join(' · ')}`,
    `${h(champion)} wins ${t.name}, beating ${h(final.winner === final.a ? final.b : final.a)} in the final!${paid || (t.prize ? ` prize: ${t.prize}` : '')}`,
  ]
  return lines
}
