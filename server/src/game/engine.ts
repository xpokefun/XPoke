/**
 * The game. Every command a trainer can send, applied to the database, answered in words.
 *
 * Replies are lower-case and short, like the rest of the agent's voice. They must fit one post, so
 * every reply goes through `fit()` before it leaves.
 */
import { type DB, now, tx } from '../db.ts'
import { CATCHABLE, FORMS, rollWildSpecies, speciesByName, titleType, type Species } from './data.ts'
import { duel, type Fighter, GYM_HP_MULT, GYM_POWER_MULT } from './battle.ts'
import type { Command, Pick } from './commands.ts'
import { adventure, DEFAULT_FOODS, feedReaction } from './flavor.ts'
import {
  BALLS,
  BOXES,
  COOLDOWN,
  GYMS,
  MASTER_PITY,
  MATCH_LEVEL_RANGE,
  PARTY_MAX,
  XP,
  growthStage,
  trainerLevel,
  xpLoss,
  type Ball,
  type Gym,
} from './rules.ts'
import {
  allMons,
  applyXp,
  arrivalLocation,
  cooldownLeft,
  evolutionInfo,
  fighterOf,
  findMon,
  fmtDuration,
  getMon,
  getTrainer,
  lockLabel,
  lockOf,
  monName,
  monsAt,
  moveMon,
  nextSlot,
  party,
  refreshFreeBalls,
  sp,
  trainerByHandle,
  type Mon,
  type Trainer,
} from './store.ts'
import { acceptWager, cancelWagerBy, createWager, incomingWager } from './wager.ts'
import { createTrade } from './trade.ts'
import { joinTournament } from './tournament.ts'

export type Ctx = {
  db: DB
  actor: Trainer
  site: string
  rand?: () => number
  /** Optional free-form answerer for `chat` (the LLM). */
  chat?: (text: string, actor: Trainer) => Promise<string>
}

export type Outcome = {
  reply: string
  /** Standalone posts the agent should publish (tournament results). */
  announce?: string[]
}

const TWEET_LIMIT = 280
/** Length as X counts it: every link (with or without http, e.g. "xpoke.fun/me") counts as 23. */
export function xLength(text: string): number {
  return Array.from(text.replace(/https?:\/\/\S+|\b[\w-]+(?:\.[\w-]+)*\.(?:fun|com|io|xyz|app|net|org|gg|me|so)\b[^\s,;]*/gi, 'x'.repeat(23))).length
}

export function fit(text: string, limit = TWEET_LIMIT): string {
  if (xLength(text) <= limit) return text
  const chars = Array.from(text)
  return chars.slice(0, limit - 1).join('') + '…'
}

function siteHost(site: string): string {
  return site.replace(/^https?:\/\//, '')
}

export async function run(ctx: Ctx, cmd: Command): Promise<Outcome> {
  const rand = ctx.rand ?? Math.random
  const { db } = ctx
  const actor = refreshFreeBalls(db, getTrainer(db, ctx.actor.id) ?? ctx.actor)
  const c: Ctx = { ...ctx, actor, rand }
  switch (cmd.kind) {
    case 'catch':
      return { reply: tx(db, () => doCatch(c, cmd.ball)) }
    case 'check':
      return { reply: doCheck(c, cmd.pick) }
    case 'feed':
      return { reply: tx(db, () => doFeed(c, cmd.pick, cmd.food)) }
    case 'battle':
      return { reply: tx(db, () => doBattle(c, cmd.pick)) }
    case 'evolve':
      return { reply: tx(db, () => doEvolve(c, cmd.pick)) }
    case 'swap':
      return { reply: tx(db, () => doSwap(c, cmd.box, cmd.party)) }
    case 'release':
      return { reply: tx(db, () => doRelease(c, cmd.pick, cmd.confirm)) }
    case 'challenge':
      return { reply: tx(db, () => doChallenge(c, cmd.target, cmd.pick)) }
    case 'accept':
      return { reply: tx(db, () => doAccept(c, cmd.pick, Boolean(cmd.wager))) }
    case 'decline':
      return { reply: tx(db, () => doDecline(c, Boolean(cmd.wager))) }
    case 'cancel':
      return { reply: tx(db, () => doCancel(c)) }
    case 'wager':
      return { reply: tx(db, () => createWager(c, cmd.target, cmd.amount)) }
    case 'trade':
      return { reply: tx(db, () => createTrade(c, cmd.target, cmd.offer, cmd.want)) }
    case 'tournament_join':
      return tx(db, () => joinTournament(c))
    case 'activity':
      return { reply: tx(db, () => doActivity(c, cmd.pick)) }
    case 'help':
      return { reply: helpText(c.site) }
    case 'wallet': {
      const host = c.site.replace(/^https?:\/\//, '')
      return {
        reply: actor.wallet
          ? `your linked wallet is ${actor.wallet.slice(0, 4)}…${actor.wallet.slice(-4)}. wager winnings and refunds go there. change it at ${host}/wallet`
          : `no wallet linked yet. link your Solana wallet at ${host}/wallet (one free signature) so wager winnings and refunds go straight to it`,
      }
    }
    case 'chat': {
      if (c.chat) {
        try {
          return { reply: fit(await c.chat(cmd.text, actor)) }
        } catch {
          /* fall through to help */
        }
      }
      return { reply: `i didn't catch that. ${helpText(c.site)}` }
    }
    case 'none':
      return { reply: '' }
  }
}

export function helpText(site: string): string {
  return fit(
    'say: catch · check · feed · battle · evolve · walk · swap [box] for [party] · release [name] confirm · ' +
      'challenge @trainer · accept/decline/cancel · wager @trainer 1000 · trade @trainer [yours] for [theirs] · ' +
      `tournament join · wallet. full guide: ${site}/docs`,
  )
}

/* ------------------------------------------------------------------ helpers */

function noPokemon(): string {
  return "you don't have any pokemon yet. reply \"catch\" to throw your first pokeball"
}

/** Resolves a party Pokémon from a pick; with no pick, the first party Pokémon. */
function pickParty(c: Ctx, pick: Pick | undefined): { mon: Mon | null; error: string | null } {
  const mons = party(c.db, c.actor.id)
  if (!mons.length) {
    const any = allMons(c.db, c.actor.id)
    return { mon: null, error: any.length ? 'your party is empty. say "swap [name]" to bring one out of your box' : noPokemon() }
  }
  if (!pick) return { mon: mons[0]!, error: null }
  const m = findMon(mons, pick)
  if (m) return { mon: m, error: null }
  if (pick.name) {
    const boxed = findMon(allMons(c.db, c.actor.id), pick)
    if (boxed) return { mon: null, error: `${sp(boxed).name} is in your ${boxLabel(boxed.location)}. say "swap ${sp(boxed).name.toLowerCase()}" to bring it into your party` }
    return { mon: null, error: `you don't have a ${pick.name} in your party` }
  }
  return { mon: null, error: `you only have ${mons.length} pokemon in your party` }
}

function boxLabel(loc: string): string {
  return loc === 'box1' ? 'Box 1' : loc === 'box2' ? 'Box 2' : 'party'
}

function levelLine(name: string, r: { level: number; leveledUp: number }): string {
  return r.leveledUp ? ` ${name} grew to Lv.${r.level}!` : ''
}

function evolveHint(m: Mon): string {
  const fresh = m
  const e = evolutionInfo(fresh)
  return e.ready && e.to ? ` ready to evolve into ${e.to.name}, say "evolve ${sp(fresh).name.toLowerCase()}"` : ''
}

export function recordBattle(
  db: DB,
  b: {
    kind: string
    a_trainer: string
    a_pokemon: number | null
    b_trainer: string | null
    b_pokemon: number | null
    gym?: number | null
    winner: 0 | 1
    xp_a?: number | null
    xp_b?: number | null
    detail: unknown
  },
): number {
  const r = db
    .prepare(
      'insert into battles (kind, a_trainer, a_pokemon, b_trainer, b_pokemon, gym, winner, xp_a, xp_b, detail, at) values (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      b.kind,
      b.a_trainer,
      b.a_pokemon,
      b.b_trainer,
      b.b_pokemon,
      b.gym ?? null,
      b.winner,
      b.xp_a ?? null,
      b.xp_b ?? null,
      JSON.stringify(b.detail),
      now(),
    )
  return Number(r.lastInsertRowid)
}

export function addTrainerResult(db: DB, trainerId: string, won: boolean): void {
  db.prepare(`update trainers set ${won ? 'wins = wins + 1' : 'losses = losses + 1'} where id = ?`).run(trainerId)
}

function addMonResult(db: DB, monId: number, won: boolean): void {
  db.prepare(`update pokemon set ${won ? 'wins = wins + 1' : 'losses = losses + 1'} where id = ?`).run(monId)
}

function rollIv(rand: () => number): number {
  return Math.floor(rand() * 16)
}

export function givePokemon(db: DB, trainerId: string, s: Species, shiny: boolean, rand: () => number): Mon {
  const loc = arrivalLocation(db, trainerId)
  const r = db
    .prepare(
      'insert into pokemon (trainer_id, species_id, shiny, iv_hp, iv_atk, iv_def, iv_spe, location, slot, caught_at) values (?,?,?,?,?,?,?,?,?,?)',
    )
    .run(trainerId, s.id, shiny ? 1 : 0, rollIv(rand), rollIv(rand), rollIv(rand), rollIv(rand), loc, nextSlot(db, trainerId, loc), now())
  return getMon(db, Number(r.lastInsertRowid))!
}

/* ------------------------------------------------------------------ catch */

function ballStock(t: Trainer, ball: Ball): number {
  if (ball === 'poke') return t.free_balls + t.bought_pokeballs
  return ball === 'ultra' ? t.ultra_balls : t.master_balls
}

function spendBall(db: DB, t: Trainer, ball: Ball): void {
  if (ball === 'poke') {
    // free daily stock first
    if (t.free_balls > 0) db.prepare('update trainers set free_balls = free_balls - 1 where id = ?').run(t.id)
    else db.prepare('update trainers set bought_pokeballs = bought_pokeballs - 1 where id = ?').run(t.id)
  } else {
    db.prepare(`update trainers set ${ball}_balls = ${ball}_balls - 1 where id = ?`).run(t.id)
  }
}

function doCatch(c: Ctx, ball: Ball): string {
  const { db, actor } = c
  const rand = c.rand!
  const b = BALLS[ball]
  if (ballStock(actor, ball) <= 0) {
    if (ball === 'poke') return `you're out of pokeballs for today. 5 free ones arrive at midnight UTC, or grab ultra/master balls at ${siteHost(c.site)}/shop`
    return `you don't have any ${b.label}s. buy them at ${siteHost(c.site)}/shop`
  }
  spendBall(db, actor, ball)
  const after = getTrainer(db, actor.id)!
  const left = ballStock(after, ball)
  const leftLine = ` (${left} ${b.label}${left === 1 ? '' : 's'} left)`

  const pity = ball === 'master' && actor.fail_streak >= MASTER_PITY
  const success = pity || rand() < b.catchRate
  if (!success) {
    db.prepare('update trainers set fail_streak = fail_streak + 1 where id = ?').run(actor.id)
    return `oh no, the pokemon broke free! try again${leftLine}`
  }
  db.prepare('update trainers set fail_streak = 0 where id = ?').run(actor.id)
  const s = rollWildSpecies(rand)
  const shiny = rand() < b.shinyRate
  const mon = givePokemon(db, actor.id, s, shiny, rand)
  const where = mon.location === 'party' ? '' : ' your party is full so they went to Box 1.'
  const t = s.types.map(titleType).join('/')
  return fit(
    `gotcha${shiny ? ' you caught a shiny one!' : '! you caught'} ${s.name} the ${t} type.${where} feed them, check on them or battle anytime${leftLine}`,
  )
}

/* ------------------------------------------------------------------ check */

function monLine(m: Mon): string {
  const s = sp(m)
  const stats = `hp ${s.hp} atk ${Math.max(s.atk, s.spa)} def ${Math.round((s.def + s.spd) / 2)} spe ${s.spe}`
  return `${monName(m)} Lv.${m.level} (${m.xp}/100xp) ${growthStage(m.feeds)} · ${stats} · ${m.wins}W ${m.losses}L`
}

function doCheck(c: Ctx, pick: Pick | undefined): string {
  const { db, actor } = c
  const mons = allMons(db, actor.id)
  if (!mons.length) return noPokemon()
  if (pick) {
    const p = party(db, actor.id)
    const m = findMon(p, pick) ?? (pick.name ? findMon(mons, pick) : null)
    if (!m) return pick.name ? `you don't have a ${pick.name}` : `you only have ${p.length} pokemon in your party`
    const cd = cooldownLeft(m.last_battle_at, COOLDOWN.battle)
    const fd = cooldownLeft(m.last_fed_at, COOLDOWN.feed)
    return fit(
      `${monLine(m)} · ivs ${m.iv_hp}/${m.iv_atk}/${m.iv_def}/${m.iv_spe}` +
        ` · ${cd ? `resting ${fmtDuration(cd)}` : 'ready to battle'}` +
        ` · ${fd ? `full, next feed in ${fmtDuration(fd)}` : 'hungry'}` +
        `${m.location !== 'party' ? ` · in ${boxLabel(m.location)}` : ''}.${evolveHint(m)}`,
    )
  }
  const p = party(db, actor.id)
  const boxed = mons.length - p.length
  const lines = p.map((m, i) => `${i + 1}. ${monName(m)} Lv.${m.level} ${m.xp}/100xp ${m.wins}W${evolutionInfo(m).ready ? ' (can evolve)' : ''}`)
  return fit(
    `trainer Lv.${trainerLevel(actor.wins)} · ${actor.wins}W. party: ${lines.join(' · ') || 'empty'}${boxed ? ` · +${boxed} in boxes` : ''}. ` +
      `balls: ${actor.free_balls + actor.bought_pokeballs} poke, ${actor.ultra_balls} ultra, ${actor.master_balls} master`,
  )
}

/* ------------------------------------------------------------------ feed */

function doFeed(c: Ctx, pick: Pick | undefined, food: string | undefined): string {
  const { db } = c
  const { mon, error } = pickParty(c, pick)
  if (!mon) return error!
  const left = cooldownLeft(mon.last_fed_at, COOLDOWN.feed)
  if (left) return `${sp(mon).name} is still full. next feed in ${fmtDuration(left)}`
  const f = (food?.trim() || DEFAULT_FOODS[Math.floor(c.rand!() * DEFAULT_FOODS.length)]!).slice(0, 40)
  const feeds = mon.feeds + 1
  db.prepare('update pokemon set feeds = ?, last_fed_at = ?, last_food = ? where id = ?').run(feeds, now(), f, mon.id)
  const before = growthStage(mon.feeds)
  const after = growthStage(feeds)
  const grew = before !== after ? ` ${sp(mon).name} grew into a ${after}!` : ''
  return fit(`${feedReaction(sp(mon).name, f, c.rand)}. fed ${feeds} time${feeds === 1 ? '' : 's'} (${after}).${grew}`)
}

/* ------------------------------------------------------------------ battle */

export function gymFighter(g: Gym): Fighter {
  const s = speciesByName(g.species) ?? (FORMS as Record<string, Species>)[g.species]!
  return {
    label: `${g.leader}'s ${s.name}`,
    species: s,
    level: g.level,
    ivs: { hp: 10, atk: 10, def: 10, spe: 10 },
    powerMult: GYM_POWER_MULT,
    hpMult: GYM_HP_MULT,
  }
}

function medalsOf(db: DB, trainerId: string): Set<number> {
  return new Set((db.prepare('select gym from medals where trainer_id = ?').all(trainerId) as { gym: number }[]).map((r) => r.gym))
}

/** The next gym without a medal; once all are won, the one nearest in level. */
function pickGym(db: DB, trainerId: string, level: number): Gym {
  const have = medalsOf(db, trainerId)
  const next = GYMS.find((g) => !have.has(g.n))
  if (next) return next
  return [...GYMS].sort((a, b) => Math.abs(a.level - level) - Math.abs(b.level - level))[0]!
}

function doBattle(c: Ctx, pick: Pick | undefined): string {
  const { db, actor } = c
  const rand = c.rand!
  let mon: Mon | null
  if (pick) {
    const r = pickParty(c, pick)
    if (!r.mon) return r.error!
    mon = r.mon
  } else {
    const p = party(db, actor.id)
    if (!p.length) return pickParty(c, undefined).error!
    // no pick: first party Pokémon that is rested
    mon = p.find((m) => !cooldownLeft(m.last_battle_at, COOLDOWN.battle)) ?? p[0]!
  }
  const lockB = lockOf(db, mon.id)
  if (lockB === 'wager') return `${sp(mon).name} is locked in a pending wager and can't battle until it resolves`
  const left = cooldownLeft(mon.last_battle_at, COOLDOWN.battle)
  if (left) {
    const ready = party(db, actor.id).find((m) => !cooldownLeft(m.last_battle_at, COOLDOWN.battle))
    return `${sp(mon).name} is resting for ${fmtDuration(left)}.${ready ? ` ${sp(ready).name} is ready, say "battle ${sp(ready).name.toLowerCase()}"` : ''}`
  }

  const opponents = db
    .prepare(
      "select p.* from pokemon p join trainers t on t.id = p.trainer_id where p.location = 'party' and p.trainer_id != ? and p.level between ? and ?",
    )
    .all(actor.id, mon.level - MATCH_LEVEL_RANGE, mon.level + MATCH_LEVEL_RANGE) as Mon[]
  db.prepare('update pokemon set last_battle_at = ? where id = ?').run(now(), mon.id)

  if (opponents.length) {
    const opp = opponents[Math.floor(rand() * opponents.length)]!
    const oppTrainer = getTrainer(db, opp.trainer_id)!
    const r = duel(fighterOf(mon), fighterOf(opp), rand)
    const won = r.winner === 0
    const delta = won ? XP.winPlayer : -xpLoss(mon.level, false)
    const lv = applyXp(db, mon, delta)
    addMonResult(db, mon.id, won)
    addTrainerResult(db, actor.id, won)
    recordBattle(db, {
      kind: 'random',
      a_trainer: actor.id,
      a_pokemon: mon.id,
      b_trainer: opp.trainer_id,
      b_pokemon: opp.id,
      winner: r.winner,
      xp_a: delta,
      detail: battleDetail(fighterOf(mon), fighterOf(opp), r),
    })
    const fresh = getMon(db, mon.id)!
    const head = won
      ? `${sp(mon).name} Lv.${mon.level} beat @${oppTrainer.handle}'s ${monName(opp)} Lv.${opp.level}`
      : `@${oppTrainer.handle}'s ${monName(opp)} Lv.${opp.level} beat your ${sp(mon).name} Lv.${mon.level}`
    return fit(
      `${head} in ${r.rounds} round${r.rounds === 1 ? '' : 's'} (${hpLine(r)}). ${xpText(delta)} (${fresh.xp}/100).${levelLine(sp(mon).name, lv)}${evolveHint(fresh)}`,
    )
  }

  const gym = pickGym(db, actor.id, mon.level)
  const gf = gymFighter(gym)
  const r = duel(fighterOf(mon), gf, rand)
  const won = r.winner === 0
  const delta = won ? XP.winGym : -xpLoss(mon.level, true)
  const lv = applyXp(db, mon, delta)
  addMonResult(db, mon.id, won)
  addTrainerResult(db, actor.id, won)
  let medal = ''
  if (won) {
    const ins = db.prepare('insert or ignore into medals (trainer_id, gym, earned_at) values (?,?,?)').run(actor.id, gym.n, now())
    if (ins.changes) medal = ` you earned the ${gym.leader} medal (${gym.n}/13)!`
  }
  recordBattle(db, {
    kind: 'gym',
    a_trainer: actor.id,
    a_pokemon: mon.id,
    b_trainer: null,
    b_pokemon: null,
    gym: gym.n,
    winner: r.winner,
    xp_a: delta,
    detail: battleDetail(fighterOf(mon), gf, r),
  })
  const fresh = getMon(db, mon.id)!
  const head = won
    ? `gym battle! ${sp(mon).name} Lv.${mon.level} beat ${gym.leader}'s ${gf.species.name} Lv.${gym.level}`
    : `gym battle! ${gym.leader}'s ${gf.species.name} Lv.${gym.level} beat your ${sp(mon).name} Lv.${mon.level}`
  return fit(`${head} (${hpLine(r)}). ${xpText(delta)} (${fresh.xp}/100).${medal}${levelLine(sp(mon).name, lv)}${evolveHint(fresh)}`)
}

function xpText(delta: number): string {
  return delta > 0 ? `+${delta} xp` : delta < 0 ? `${delta} xp` : 'no xp lost'
}

function hpLine(r: { hpLeft: [number, number]; maxHp: [number, number]; winner: 0 | 1 }): string {
  const i = r.winner
  return `${Math.round((100 * r.hpLeft[i]) / r.maxHp[i])}% hp left`
}

export function battleDetail(a: Fighter, b: Fighter, r: ReturnType<typeof duel>) {
  return {
    a: { name: a.label, species: a.species.name, sprite: a.species.form ?? a.species.id, level: a.level, maxHp: r.maxHp[0] },
    b: { name: b.label, species: b.species.name, sprite: b.species.form ?? b.species.id, level: b.level, maxHp: r.maxHp[1] },
    rounds: r.rounds,
    decidedBy: r.decidedBy,
    hits: r.hits,
    hpLeft: r.hpLeft,
  }
}

/* ------------------------------------------------------------------ evolve */

function doEvolve(c: Ctx, pick: Pick | undefined): string {
  const { db } = c
  let mon: Mon | null
  if (pick) {
    const r = pickParty(c, pick)
    if (!r.mon) return r.error!
    mon = r.mon
  } else {
    const p = party(db, c.actor.id)
    if (!p.length) return pickParty(c, undefined).error!
    mon = p.find((m) => evolutionInfo(m).ready) ?? p[0]!
  }
  const lockE = lockOf(db, mon.id)
  if (lockE) return `${sp(mon).name} is in a ${lockLabel(lockE)}: the other trainer agreed to it as it is, so it can't change until that resolves`
  const e = evolutionInfo(mon)
  if (!e.to) return `${sp(mon).name} is fully evolved already`
  if (!e.ready) return `${sp(mon).name} needs Lv.${e.level} to evolve into ${e.to.name} (now Lv.${mon.level}). battle to level up`
  const from = sp(mon).name
  db.prepare('update pokemon set species_id = ? where id = ?').run(e.to.id, mon.id)
  return fit(`what? ${from} is evolving... congratulations! your ${from} evolved into ${mon.shiny ? 'a shiny ' : ''}${e.to.name}!`)
}

/* ------------------------------------------------------------------ swap / release */

function doSwap(c: Ctx, boxName: string, partyName: string | undefined): string {
  const { db, actor } = c
  const boxed = BOXES.flatMap((b) => monsAt(db, actor.id, b))
  const incoming = findMon(boxed, { name: boxName })
  if (!incoming) {
    const inParty = findMon(party(db, actor.id), { name: boxName })
    if (inParty && !partyName) return `${sp(inParty).name} is already in your party`
    return `you don't have a ${boxName} in your boxes`
  }
  const p = party(db, actor.id)
  if (!partyName) {
    if (p.length >= PARTY_MAX)
      return `your party is full. say "swap ${sp(incoming).name.toLowerCase()} for ${sp(p[0]!).name.toLowerCase()}" to swap them`
    moveMon(db, incoming, 'party')
    return `${monName(incoming)} joined your party!`
  }
  const outgoing = findMon(p, { name: partyName })
  if (!outgoing) return `you don't have a ${partyName} in your party`
  const lock = lockOf(db, outgoing.id)
  if (lock) return `${sp(outgoing).name} is locked by a ${lockLabel(lock)} and can't be swapped yet`
  const box = incoming.location
  db.prepare('update pokemon set location = ?, slot = ? where id = ?').run('party', outgoing.slot, incoming.id)
  db.prepare('update pokemon set location = ?, slot = ? where id = ?').run(box, incoming.slot, outgoing.id)
  return `${monName(incoming)} joined your party and ${monName(outgoing)} went to ${boxLabel(box)}`
}

function doRelease(c: Ctx, pick: Pick | undefined, confirm: boolean): string {
  const { db, actor } = c
  if (!pick) return 'say which one: "release pikachu confirm"'
  const mons = allMons(db, actor.id)
  const m = pick.index !== undefined ? findMon(party(db, actor.id), pick) : findMon(mons, pick)
  if (!m) return `you don't have that pokemon`
  const label = sp(m).name.toLowerCase()
  if (!confirm) return `releasing is permanent. to be sure, say "release ${label} confirm"`
  const lock = lockOf(db, m.id)
  if (lock) return `${sp(m).name} is locked by a ${lockLabel(lock)} and can't be released yet`
  const pendingTrade = db
    .prepare("select id from trades where status = 'pending' and (offer_pokemon = ? or want_pokemon = ?)")
    .get(m.id, m.id)
  if (pendingTrade) return `${sp(m).name} is part of a pending trade. cancel it first`
  db.prepare("update pokemon set location = 'released', released_at = ? where id = ?").run(now(), m.id)
  return `bye bye ${monName(m)}! released Lv.${m.level} back into the wild. your trainer wins stay with you`
}

/* ------------------------------------------------------------------ activity */

function doActivity(c: Ctx, pick: Pick | undefined): string {
  const { db, actor } = c
  const rand = c.rand!
  let mon: Mon | null
  if (pick) {
    const r = pickParty(c, pick)
    if (!r.mon) return r.error!
    mon = r.mon
  } else {
    const p = party(db, actor.id)
    if (!p.length) return pickParty(c, undefined).error!
    mon = p.find((m) => !cooldownLeft(m.last_activity_at, COOLDOWN.activity)) ?? p[0]!
  }
  const left = cooldownLeft(mon.last_activity_at, COOLDOWN.activity)
  if (left) return `${sp(mon).name} is still tired from the last adventure. ready in ${fmtDuration(left)}`
  const friends = db
    .prepare("select * from pokemon where location = 'party' and trainer_id != ? order by random() limit 1")
    .all(actor.id) as Mon[]
  const friend = friends[0]
  const friendLabel = friend
    ? `@${getTrainer(db, friend.trainer_id)!.handle}'s ${monName(friend)}`
    : `a wild ${CATCHABLE[Math.floor(rand() * CATCHABLE.length)]!.name}`
  const story = adventure(sp(mon).name, friendLabel, rand)
  db.prepare('update pokemon set last_activity_at = ?, last_activity = ? where id = ?').run(now(), story, mon.id)
  return fit(`${story}. back in 2 hours for the next one`)
}

/* ------------------------------------------------------------------ pvp */

function doChallenge(c: Ctx, target: string, pick: Pick | undefined): string {
  const { db, actor } = c
  if (target.toLowerCase() === actor.handle.toLowerCase()) return "you can't challenge yourself"
  const opp = trainerByHandle(db, target)
  if (!opp) return `that trainer hasn't started playing yet. they can reply "catch" to get their first pokemon`
  if (!party(db, opp.id).length) return `@${opp.handle} has no pokemon in their party`
  const r = pickParty(c, pick)
  if (!r.mon) return r.error!
  const mon = r.mon
  const left = cooldownLeft(mon.last_battle_at, COOLDOWN.battle)
  if (left) return `${sp(mon).name} is resting for ${fmtDuration(left)}. pick another with "challenge @${opp.handle} with [name]"`
  const lock = lockOf(db, mon.id)
  if (lock) return `${sp(mon).name} is already in a ${lockLabel(lock)}`
  const existing = db
    .prepare("select id from challenges where status = 'pending' and expires_at > ? and challenger_id = ? and target_id = ?")
    .get(now(), actor.id, opp.id)
  if (existing) return `you already have a pending challenge to @${opp.handle}. say "cancel" to withdraw it`
  db.prepare(
    "insert into challenges (challenger_id, target_id, challenger_pokemon, status, created_at, expires_at) values (?,?,?,'pending',?,?)",
  ).run(actor.id, opp.id, mon.id, now(), now() + COOLDOWN.challengeExpiry)
  return fit(
    `@${opp.handle} you've been challenged by @${actor.handle}'s ${monName(mon)} Lv.${mon.level}! reply "accept" to battle or "decline". expires in 30 min`,
  )
}

type Challenge = {
  id: number
  challenger_id: string
  target_id: string
  challenger_pokemon: number
  status: string
  created_at: number
  expires_at: number
}

export function expireChallenges(db: DB): void {
  db.prepare("update challenges set status = 'expired' where status = 'pending' and expires_at <= ?").run(now())
}

function doAccept(c: Ctx, pick: Pick | undefined, wantWager: boolean): string {
  const { db, actor } = c
  expireChallenges(db)
  const w = incomingWager(db, actor.id)
  const ch = db
    .prepare("select * from challenges where status = 'pending' and target_id = ? and expires_at > ? order by created_at limit 1")
    .get(actor.id, now()) as Challenge | undefined
  // ⚠ a stranger can send an unsolicited wager at any time, so "accept" meant for a friendly
  // challenge must never lock a team into it: a wager is accepted only when it is the only thing
  // pending, or when the reply says "accept wager"
  if (w && (wantWager || !ch)) return acceptWager(c, w)
  if (!ch) return wantWager ? 'you have no pending wager to accept' : 'you have no pending challenges to accept'
  const r = pickParty(c, pick)
  if (!r.mon) return r.error!
  const mine = r.mon
  const theirs = getMon(db, ch.challenger_pokemon)
  const challenger = getTrainer(db, ch.challenger_id)!
  if (!theirs || theirs.trainer_id !== challenger.id || theirs.location !== 'party') {
    db.prepare("update challenges set status = 'cancelled' where id = ?").run(ch.id)
    return `@${challenger.handle}'s pokemon is no longer available, the challenge was cancelled`
  }
  const lockM = lockOf(db, mine.id)
  if (lockM) return `${sp(mine).name} is in a ${lockLabel(lockM)}. say "accept with [name]" to send another`
  const left = cooldownLeft(mine.last_battle_at, COOLDOWN.battle)
  if (left) return `${sp(mine).name} is resting for ${fmtDuration(left)}. say "accept with [name]" to send another`

  const res = duel(fighterOf(theirs), fighterOf(mine), c.rand)
  const challengerWon = res.winner === 0
  const xpA = challengerWon ? XP.winPlayer : -xpLoss(theirs.level, false)
  const xpB = challengerWon ? -xpLoss(mine.level, false) : XP.winPlayer
  const lvA = applyXp(db, theirs, xpA)
  const lvB = applyXp(db, mine, xpB)
  addMonResult(db, theirs.id, challengerWon)
  addMonResult(db, mine.id, !challengerWon)
  addTrainerResult(db, challenger.id, challengerWon)
  addTrainerResult(db, actor.id, !challengerWon)
  db.prepare('update pokemon set last_battle_at = ? where id in (?, ?)').run(now(), theirs.id, mine.id)
  const battleId = recordBattle(db, {
    kind: 'pvp',
    a_trainer: challenger.id,
    a_pokemon: theirs.id,
    b_trainer: actor.id,
    b_pokemon: mine.id,
    winner: res.winner,
    xp_a: xpA,
    xp_b: xpB,
    detail: battleDetail(fighterOf(theirs, `@${challenger.handle}'s ${sp(theirs).name}`), fighterOf(mine, `@${actor.handle}'s ${sp(mine).name}`), res),
  })
  db.prepare("update challenges set status = 'done', target_pokemon = ?, battle_id = ? where id = ?").run(mine.id, battleId, ch.id)
  const [w1, w1h, w1m, l1h, l1m] = challengerWon
    ? [theirs, challenger.handle, sp(theirs).name, actor.handle, sp(mine).name]
    : [mine, actor.handle, sp(mine).name, challenger.handle, sp(theirs).name]
  void w1
  return fit(
    `pvp! @${w1h}'s ${w1m} beat @${l1h}'s ${l1m} in ${res.rounds} round${res.rounds === 1 ? '' : 's'}. ` +
      `@${challenger.handle} ${xpText(xpA)}, @${actor.handle} ${xpText(xpB)}.` +
      `${levelLine(sp(theirs).name, lvA)}${levelLine(sp(mine).name, lvB)}`,
  )
}

function doDecline(c: Ctx, wantWager: boolean): string {
  const { db, actor } = c
  expireChallenges(db)
  const w = incomingWager(db, actor.id)
  if (wantWager) {
    if (!w) return 'you have no pending wager to decline'
    cancelWagerBy(db, w, actor.id, 'declined')
    return 'declined the wager'
  }
  const n = db.prepare("update challenges set status = 'declined' where status = 'pending' and target_id = ?").run(actor.id).changes
  if (!n && w) {
    cancelWagerBy(db, w, actor.id, 'declined')
    return 'declined the wager'
  }
  if (!n) return 'you have no pending challenges'
  return `declined ${n} challenge${n === 1 ? '' : 's'}${w ? '. a wager is still waiting, say "decline wager" to refuse it' : ''}`
}

function doCancel(c: Ctx): string {
  const { db, actor } = c
  expireChallenges(db)
  const n = db.prepare("update challenges set status = 'cancelled' where status = 'pending' and challenger_id = ?").run(actor.id).changes
  if (n) return `cancelled your challenge${n === 1 ? '' : 's'}. your pokemon is unlocked`
  const w = db
    .prepare("select * from wagers where status in ('pending_accept', 'awaiting_payment') and (challenger_id = ? or target_id = ?)")
    .get(actor.id, actor.id) as Parameters<typeof cancelWagerBy>[1] | undefined
  if (w) return cancelWagerBy(db, w, actor.id, 'cancelled by trainer')
  const t = db.prepare("update trades set status = 'cancelled', resolved_at = ? where status = 'pending' and from_id = ?").run(now(), actor.id).changes
  if (t) return 'cancelled your pending trade'
  return 'you have nothing pending to cancel'
}
