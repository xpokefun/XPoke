/** Rows, and the reads/writes every command shares. */
import { type DB, now } from '../db.ts'
import { species, spriteId, normName, type Species } from './data.ts'
import { BOXES, COOLDOWN, FREE_BALLS_PER_DAY, PARTY_MAX, XP_PER_LEVEL, growthStage } from './rules.ts'
import type { Fighter } from './battle.ts'

export type Trainer = {
  id: string
  handle: string
  name: string | null
  avatar: string | null
  wins: number
  losses: number
  free_balls: number
  free_balls_day: string | null
  ultra_balls: number
  master_balls: number
  bought_pokeballs: number
  fail_streak: number
  created_at: number
  /** linked Solana wallet (signed), where wager winnings and refunds go */
  wallet: string | null
  wallet_linked_at: number | null
}

export type Mon = {
  id: number
  trainer_id: string
  species_id: number
  shiny: number
  level: number
  xp: number
  iv_hp: number
  iv_atk: number
  iv_def: number
  iv_spe: number
  feeds: number
  last_food: string | null
  last_fed_at: number | null
  last_battle_at: number | null
  last_activity_at: number | null
  last_activity: string | null
  wins: number
  losses: number
  location: string
  slot: number
  wager_eligible: number
  caught_at: number
  released_at: number | null
}

export function utcDay(t = now()): string {
  return new Date(t).toISOString().slice(0, 10)
}

export function ensureTrainer(
  db: DB,
  u: { id: string; handle: string; name?: string | null; avatar?: string | null },
): Trainer {
  const existing = db.prepare('select * from trainers where id = ?').get(u.id) as Trainer | undefined
  if (existing) {
    if (existing.handle !== u.handle || (u.avatar && existing.avatar !== u.avatar) || (u.name && existing.name !== u.name)) {
      // a handle can move between accounts: free it from whoever held it before
      db.prepare('update trainers set handle = handle || ? where handle = ? collate nocase and id != ?').run(
        `~${existing.id}`,
        u.handle,
        u.id,
      )
      db.prepare('update trainers set handle = ?, name = coalesce(?, name), avatar = coalesce(?, avatar) where id = ?').run(
        u.handle,
        u.name ?? null,
        u.avatar ?? null,
        u.id,
      )
    }
    return refreshFreeBalls(db, getTrainer(db, u.id)!)
  }
  db.prepare('update trainers set handle = handle || ? where handle = ? collate nocase').run(`~old${now()}`, u.handle)
  db.prepare(
    'insert into trainers (id, handle, name, avatar, free_balls, free_balls_day, created_at) values (?, ?, ?, ?, ?, ?, ?)',
  ).run(u.id, u.handle, u.name ?? null, u.avatar ?? null, FREE_BALLS_PER_DAY, utcDay(), now())
  return getTrainer(db, u.id)!
}

/** 5 free pokeballs every day at midnight UTC. The free stock resets; bought balls are kept apart. */
export function refreshFreeBalls(db: DB, t: Trainer): Trainer {
  const today = utcDay()
  if (t.free_balls_day === today) return t
  db.prepare('update trainers set free_balls = ?, free_balls_day = ? where id = ?').run(FREE_BALLS_PER_DAY, today, t.id)
  return { ...t, free_balls: FREE_BALLS_PER_DAY, free_balls_day: today }
}

export function getTrainer(db: DB, id: string): Trainer | null {
  return (db.prepare('select * from trainers where id = ?').get(id) as Trainer | undefined) ?? null
}

export function trainerByHandle(db: DB, handle: string): Trainer | null {
  const h = handle.replace(/^@/, '')
  return (db.prepare('select * from trainers where handle = ? collate nocase').get(h) as Trainer | undefined) ?? null
}

export function getMon(db: DB, id: number): Mon | null {
  return (db.prepare('select * from pokemon where id = ?').get(id) as Mon | undefined) ?? null
}

export function monsAt(db: DB, trainerId: string, location: string): Mon[] {
  return db
    .prepare('select * from pokemon where trainer_id = ? and location = ? order by slot, id')
    .all(trainerId, location) as Mon[]
}

export function party(db: DB, trainerId: string): Mon[] {
  return monsAt(db, trainerId, 'party')
}

export function allMons(db: DB, trainerId: string): Mon[] {
  return db
    .prepare("select * from pokemon where trainer_id = ? and location != 'released' order by location = 'party' desc, location, slot, id")
    .all(trainerId) as Mon[]
}

export function nextSlot(db: DB, trainerId: string, location: string): number {
  const r = db
    .prepare('select coalesce(max(slot), -1) + 1 as s from pokemon where trainer_id = ? and location = ?')
    .get(trainerId, location) as { s: number }
  return r.s
}

export function moveMon(db: DB, mon: Mon, location: string): void {
  db.prepare('update pokemon set location = ?, slot = ? where id = ?').run(location, nextSlot(db, mon.trainer_id, location), mon.id)
}

/** Where a newly received Pokémon goes: the party if it has room, else Box 1. */
export function arrivalLocation(db: DB, trainerId: string): string {
  return party(db, trainerId).length < PARTY_MAX ? 'party' : BOXES[0]
}

export function sp(m: Mon): Species {
  return species(m.species_id)
}

export function monName(m: Mon): string {
  return `${m.shiny ? 'shiny ' : ''}${sp(m).name}`
}

export function fighterOf(m: Mon, label?: string): Fighter {
  return {
    label: label ?? sp(m).name,
    species: sp(m),
    level: m.level,
    ivs: { hp: m.iv_hp, atk: m.iv_atk, def: m.iv_def, spe: m.iv_spe },
  }
}

/** What a lock reads as in a reply. */
export function lockLabel(lock: string): string {
  return lock === 'pvp' ? 'pending challenge' : lock === 'trade' ? 'pending trade' : 'pending wager'
}

/** Ids of Pokémon held by a pending PvP challenge, a live wager or an open trade. */
export function lockedIds(db: DB): Map<number, string> {
  const locks = new Map<number, string>()
  const t = now()
  for (const r of db
    .prepare("select offer_pokemon, want_pokemon from trades where status = 'pending'")
    .all() as { offer_pokemon: number; want_pokemon: number | null }[]) {
    locks.set(r.offer_pokemon, 'trade')
    if (r.want_pokemon) locks.set(r.want_pokemon, 'trade')
  }
  for (const r of db
    .prepare("select challenger_pokemon from challenges where status = 'pending' and expires_at > ?")
    .all(t) as { challenger_pokemon: number }[])
    locks.set(r.challenger_pokemon, 'pvp')
  for (const r of db
    .prepare("select team_a, team_b from wagers where status in ('pending_accept', 'awaiting_payment')")
    .all() as { team_a: string | null; team_b: string | null }[]) {
    for (const id of [...JSON.parse(r.team_a ?? '[]'), ...JSON.parse(r.team_b ?? '[]')] as number[]) locks.set(id, 'wager')
  }
  return locks
}

export function lockOf(db: DB, monId: number): string | null {
  return lockedIds(db).get(monId) ?? null
}

/** Applies XP; level never decreases and XP never goes below 0. */
export function applyXp(db: DB, m: Mon, delta: number): { level: number; xp: number; leveledUp: number } {
  let level = m.level
  let xp = m.xp + delta
  let up = 0
  if (xp < 0) xp = 0
  while (xp >= XP_PER_LEVEL) {
    xp -= XP_PER_LEVEL
    level++
    up++
  }
  db.prepare('update pokemon set level = ?, xp = ? where id = ?').run(level, xp, m.id)
  return { level, xp, leveledUp: up }
}

export function cooldownLeft(at: number | null, cd: number, t = now()): number {
  if (!at) return 0
  return Math.max(0, at + cd - t)
}

export function fmtDuration(ms: number): string {
  const m = Math.ceil(ms / 60_000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
}

/** Feed status shown on cards. */
export function hunger(m: Mon, t = now()): { status: 'Full' | 'Hungry' | 'Starving'; nextFeedIn: number } {
  const left = cooldownLeft(m.last_fed_at, COOLDOWN.feed, t)
  if (left > 0) return { status: 'Full', nextFeedIn: left }
  if (m.last_fed_at && t - m.last_fed_at < 12 * 3600_000) return { status: 'Hungry', nextFeedIn: 0 }
  return { status: m.last_fed_at ? 'Starving' : 'Hungry', nextFeedIn: 0 }
}

export function evolutionInfo(m: Mon): { to: Species | null; level: number | null; ready: boolean } {
  const s = sp(m)
  const toId = s.evolvesTo?.[0]
  if (!toId) return { to: null, level: null, ready: false }
  const to = species(toId)
  const level = to.evolveLevel ?? null
  return { to, level, ready: level !== null && m.level >= level }
}

/** Public view of a Pokémon, as every API returns it. */
export function monView(db: DB, m: Mon, locks?: Map<number, string>) {
  const s = sp(m)
  const t = now()
  const evo = evolutionInfo(m)
  const h = hunger(m, t)
  return {
    id: m.id,
    speciesId: s.id,
    sprite: spriteId(s),
    name: s.name,
    types: s.types,
    rarity: s.rarity,
    shiny: Boolean(m.shiny),
    level: m.level,
    xp: m.xp,
    xpNext: XP_PER_LEVEL,
    ivs: { hp: m.iv_hp, atk: m.iv_atk, def: m.iv_def, spe: m.iv_spe },
    base: { hp: s.hp, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe },
    feeds: m.feeds,
    growth: growthStage(m.feeds),
    hunger: h.status,
    nextFeedIn: h.nextFeedIn,
    battleReadyIn: cooldownLeft(m.last_battle_at, COOLDOWN.battle, t),
    activityReadyIn: cooldownLeft(m.last_activity_at, COOLDOWN.activity, t),
    lastActivity: m.last_activity,
    lastFood: m.last_food,
    wins: m.wins,
    losses: m.losses,
    location: m.location,
    lock: (locks ?? lockedIds(db)).get(m.id) ?? null,
    wagerEligible: Boolean(m.wager_eligible),
    evolvesTo: evo.to ? { name: evo.to.name, level: evo.level } : null,
    readyToEvolve: evo.ready,
    caughtAt: m.caught_at,
  }
}

/** Finds a Pokémon by "first"/"2nd"/index or by species name. */
export function findMon(mons: Mon[], pick: { index?: number; name?: string } | undefined): Mon | null {
  if (!pick) return null
  if (pick.index !== undefined) return mons[pick.index] ?? null
  if (pick.name) {
    const n = normName(pick.name)
    return mons.find((m) => normName(sp(m).name) === n || normName(sp(m).key) === n) ?? null
  }
  return null
}
