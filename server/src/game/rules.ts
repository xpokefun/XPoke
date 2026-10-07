/** Every number the docs promise, in one place. */

export const MIN = 60_000
export const HOUR = 60 * MIN

export const PARTY_MAX = 3
export const BOXES = ['box1', 'box2'] as const

export const COOLDOWN = {
  battle: 30 * MIN,
  feed: 60 * MIN,
  activity: 2 * HOUR,
  challengeExpiry: 30 * MIN,
} as const

export type Ball = 'poke' | 'ultra' | 'master'
export const BALLS: Record<Ball, { label: string; catchRate: number; shinyRate: number; price: number }> = {
  poke: { label: 'pokeball', catchRate: 0.4, shinyRate: 0.01, price: 0 },
  ultra: { label: 'ultra ball', catchRate: 0.65, shinyRate: 0.04, price: 2000 },
  master: { label: 'master ball', catchRate: 0.85, shinyRate: 0.08, price: 5000 },
}
export const FREE_BALLS_PER_DAY = 5
/** After this many failed throws in a row, the next master ball throw cannot fail. */
export const MASTER_PITY = 10

export const XP_PER_LEVEL = 100
export const XP = {
  winPlayer: 25,
  losePlayer: 25,
  winGym: 25,
  loseGym: 50,
} as const

/** Lv.1–2 lose nothing, Lv.3–4 lose a reduced amount, Lv.5+ the full amount. */
export function xpLoss(level: number, vsGym: boolean): number {
  if (level <= 2) return 0
  if (level <= 4) return vsGym ? 20 : 10
  return vsGym ? XP.loseGym : XP.losePlayer
}

export const TRAINER_LEVELS = [0, 2, 4, 7, 12, 20, 35, 60, 100, 200]
export function trainerLevel(wins: number): number {
  let lv = 1
  TRAINER_LEVELS.forEach((need, i) => {
    if (wins >= need) lv = i + 1
  })
  return lv
}

export type Growth = 'Baby' | 'Teen' | 'Adult'
export function growthStage(feeds: number): Growth {
  if (feeds >= 6) return 'Adult'
  if (feeds >= 3) return 'Teen'
  return 'Baby'
}

/** Gym bots are stronger than an average player Pokémon. */
export type Gym = { n: number; leader: string; species: string; level: number; sprite: string }
export const GYMS: Gym[] = [
  { n: 1, leader: 'Cheren', species: 'rattata', level: 3, sprite: 'cheren' },
  { n: 2, leader: 'Skyla', species: 'pidgeot', level: 10, sprite: 'skyla' },
  { n: 3, leader: 'Elesa', species: 'raichu', level: 18, sprite: 'elesa' },
  { n: 4, leader: 'Shauntal', species: 'gengar', level: 28, sprite: 'shauntal' },
  { n: 5, leader: 'Drayden', species: 'dragonite', level: 40, sprite: 'drayden' },
  { n: 6, leader: 'Caitlin', species: 'mewtwo', level: 55, sprite: 'caitlin' },
  { n: 7, leader: 'Marlon', species: 'gyarados', level: 70, sprite: 'marlon' },
  { n: 8, leader: 'Grimsley', species: 'houndoom-mega', level: 90, sprite: 'grimsley' },
  { n: 9, leader: 'Iris', species: 'salamence', level: 110, sprite: 'iris' },
  { n: 10, leader: 'Colress', species: 'metagross', level: 130, sprite: 'colress' },
  { n: 11, leader: 'N', species: 'rayquaza', level: 150, sprite: 'n' },
  { n: 12, leader: 'Ghetsis', species: 'mewtwo-mega-x', level: 175, sprite: 'ghetsis' },
  { n: 13, leader: 'Alder', species: 'kyogre', level: 200, sprite: 'alder' },
]
/** A real opponent must be within this many levels, or a Gym Bot steps in. */
export const MATCH_LEVEL_RANGE = 5

export const WAGER = {
  payWindow: 15 * MIN,
  acceptWindow: 24 * HOUR,
  burnBps: 100, // 1% of the pot
  minAmount: 1,
} as const

export const TRADE_EXPIRY = 24 * HOUR
export const ORDER_WINDOW = 30 * MIN
export const TOURNAMENT_SIZE = 8

export const REPLIES_PER_HOUR = 3
