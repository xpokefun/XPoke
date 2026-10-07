/**
 * The battle system ("Real Stats").
 *
 * - Every species fights with its real Pokédex base stats.
 * - Effective stats scale with level, attack faster than defence, so higher levels hit harder.
 * - effectiveSpeed = baseSpeed + level × 2. The faster Pokémon attacks first every round.
 * - Type advantages apply.
 * - 10 rounds max; if both are standing the higher remaining HP% wins.
 *
 * Calibrated (scripts/tune-battle.ts) so the docs' examples hold: Pikachu crosses over a Lv.1 Mewtwo
 * around Lv.55, Raichu Lv.58 and Rattata Lv.100 beat a Lv.1 Mewtwo.
 */
import { TYPE_CHART, type Species } from './data.ts'

export const K_ATK = 0.04
export const K_DEF = 0.016
export const K_HP = 0.025
export const HP_SCALE = 3
export const POWER = 32
export const MAX_ROUNDS = 10
export const GYM_POWER_MULT = 1.15
export const GYM_HP_MULT = 1.25

export type Ivs = { hp: number; atk: number; def: number; spe: number }

export type Fighter = {
  label: string
  species: Species
  level: number
  ivs: Ivs
  powerMult?: number
  hpMult?: number
}

export type Stats = { hp: number; atk: number; def: number; spe: number }

export function effectiveStats(f: Fighter): Stats {
  const s = f.species
  const L = f.level
  const atkBase = Math.max(s.atk, s.spa) + f.ivs.atk
  const defBase = (s.def + s.spd) / 2 + f.ivs.def
  return {
    hp: Math.round(HP_SCALE * (s.hp + f.ivs.hp) * (1 + K_HP * L) * (f.hpMult ?? 1)),
    atk: Math.round(atkBase * (1 + K_ATK * L) * (f.powerMult ?? 1)),
    def: Math.round(defBase * (1 + K_DEF * L)),
    spe: s.spe + f.ivs.spe + L * 2,
  }
}

/**
 * Best multiplier any of the attacker's types gets on the defender, held to 0.5×–2×.
 * Immunity counts as 0.5, and a double weakness counts as 2×, so type matters but a big level gap still wins.
 */
export function typeMultiplier(attacker: Species, defender: Species): number {
  let best = 0
  for (const a of attacker.types) {
    let m = 1
    for (const d of defender.types) {
      const f = TYPE_CHART[a]?.[d] ?? 1
      m *= f === 0 ? 0.5 : f
    }
    best = Math.max(best, m)
  }
  return Math.min(2, Math.max(0.5, best))
}

export type Hit = { round: number; attacker: 0 | 1; damage: number; mult: number; hpLeft: number }

export type DuelResult = {
  winner: 0 | 1
  rounds: number
  hits: Hit[]
  hpLeft: [number, number]
  maxHp: [number, number]
  decidedBy: 'ko' | 'hp'
}

/**
 * One fight between two Pokémon. `startHp` carries HP between wager duels.
 */
export function duel(
  a: Fighter,
  b: Fighter,
  rand: () => number = Math.random,
  startHp?: [number | null, number | null],
): DuelResult {
  const sa = effectiveStats(a)
  const sb = effectiveStats(b)
  const stats = [sa, sb] as const
  const fighters = [a, b] as const
  const maxHp: [number, number] = [sa.hp, sb.hp]
  const hp: [number, number] = [startHp?.[0] ?? sa.hp, startHp?.[1] ?? sb.hp]
  const mults = [typeMultiplier(a.species, b.species), typeMultiplier(b.species, a.species)] as const
  const hits: Hit[] = []

  // ties on speed go to a coin flip, once, for the whole fight
  const first: 0 | 1 = sa.spe > sb.spe ? 0 : sb.spe > sa.spe ? 1 : rand() < 0.5 ? 0 : 1
  const order: [0 | 1, 0 | 1] = first === 0 ? [0, 1] : [1, 0]

  let round = 0
  for (round = 1; round <= MAX_ROUNDS; round++) {
    for (const i of order) {
      const j = (1 - i) as 0 | 1
      const roll = 0.9 + rand() * 0.1
      const dmg = Math.max(1, Math.round((POWER * stats[i].atk * mults[i] * roll) / stats[j].def))
      hp[j] = Math.max(0, hp[j] - dmg)
      hits.push({ round, attacker: i, damage: dmg, mult: mults[i], hpLeft: hp[j] })
      if (hp[j] === 0) {
        return { winner: i, rounds: round, hits, hpLeft: hp, maxHp, decidedBy: 'ko' }
      }
    }
  }
  round = MAX_ROUNDS
  const pa = hp[0] / maxHp[0]
  const pb = hp[1] / maxHp[1]
  const winner: 0 | 1 = pa > pb ? 0 : pb > pa ? 1 : first
  void fighters
  return { winner, rounds: round, hits, hpLeft: hp, maxHp, decidedBy: 'hp' }
}

export type TeamBattleResult = {
  winner: 0 | 1
  duels: { a: number; b: number; result: DuelResult }[]
  survivors: [number, number]
}

/**
 * Wager 3v3: first vs first, the winner of each duel keeps its remaining HP into the next fight
 * against the loser's next Pokémon. First trainer to knock out all 3 of the other's loses.
 */
export function teamBattle(teamA: Fighter[], teamB: Fighter[], rand: () => number = Math.random): TeamBattleResult {
  let ia = 0
  let ib = 0
  let hpA: number | null = null
  let hpB: number | null = null
  const duels: TeamBattleResult['duels'] = []
  while (ia < teamA.length && ib < teamB.length) {
    const r = duel(teamA[ia]!, teamB[ib]!, rand, [hpA, hpB])
    duels.push({ a: ia, b: ib, result: r })
    if (r.winner === 0) {
      hpA = r.hpLeft[0]
      hpB = null
      ib++
    } else {
      hpB = r.hpLeft[1]
      hpA = null
      ia++
    }
  }
  const winner: 0 | 1 = ia < teamA.length ? 0 : 1
  return { winner, duels, survivors: [teamA.length - ia, teamB.length - ib] }
}
