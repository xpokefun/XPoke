/** Typed access to the XPoke API. Shapes mirror server/src/api.ts. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin' })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `request failed (${res.status})`)
  return body as T
}

export async function post<T>(path: string, data: unknown = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(data),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new ApiError(res.status, (body as { error?: string }).error ?? `request failed (${res.status})`)
  return body as T
}

export type Ball = { label: string; catchRate: number; shinyRate: number; price: number }

export type Config = {
  name: string
  handle: string
  chain: 'solana'
  token: { symbol: string; mint: string | null; decimals: number }
  pool: string | null
  poolTokenAccount: string | null
  explorer: string
  loginWithX: boolean
  devLogin: boolean
  balls: Record<'poke' | 'ultra' | 'master', Ball>
  trainerLevels: number[]
}

export type Mon = {
  id: number
  speciesId: number
  sprite: number
  name: string
  types: string[]
  rarity: string
  shiny: boolean
  level: number
  xp: number
  xpNext: number
  ivs: { hp: number; atk: number; def: number; spe: number }
  base: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }
  feeds: number
  growth: 'Baby' | 'Teen' | 'Adult'
  hunger: 'Full' | 'Hungry' | 'Starving'
  nextFeedIn: number
  battleReadyIn: number
  activityReadyIn: number
  lastActivity: string | null
  lastFood: string | null
  wins: number
  losses: number
  location: string
  lock: string | null
  wagerEligible: boolean
  evolvesTo: { name: string; level: number | null } | null
  readyToEvolve: boolean
  caughtAt: number
}

export type Medal = { n: number; leader: string; species: string; level: number; earnedAt: number }

export type TrainerPublic = {
  handle: string
  name: string | null
  avatar: string | null
  wins: number
  losses: number
  trainerLevel: number
  nextLevelAt: number | null
  medals: Medal[]
  party: Mon[]
  box1: Mon[]
  box2: Mon[]
}

export type TeamMon = { id: number; name: string; sprite: number; level: number; shiny: boolean } | null

export type WagerView = {
  id: number
  status: 'pending_accept' | 'awaiting_payment' | 'complete' | 'cancelled'
  amount: string
  challenger: { handle: string; avatar: string | null } | null
  target: { handle: string; avatar: string | null } | null
  teamA: TeamMon[]
  teamB: TeamMon[]
  payA: string | null
  payB: string | null
  payAWei: string | null
  payBWei: string | null
  paidA: boolean
  paidB: boolean
  paidATx: string | null
  paidBTx: string | null
  payDeadline: number | null
  winner: number | null
  battleId: number | null
  cancelReason: string | null
  createdAt: number
  mySide: 'a' | 'b' | null
  /** Where my winnings/refund go, fixed at acceptance. null = the wallet I pay from. */
  myPayout: string | null
  /** My allowance pull for this wager, if one was queued. */
  myAutoPay: { status: 'pending' | 'signed' | 'confirmed' | 'skipped' | 'failed'; error: string | null } | null
}

export type TradeView = {
  id: number
  incoming: boolean
  from: string
  to: string
  offer: Mon | null
  want: Mon | null
  createdAt: number
}

export type OrderView = {
  id: number
  ball: string
  qty: number
  amount: string
  amountWei: string
  status: string
  createdAt: number
  expiresAt: number
  tx: string | null
}

export type LinkedWallet = { address: string; linkedAt: number }

export type TrainerMine = TrainerPublic & {
  id: string
  wallet: LinkedWallet | null
  balls: { poke: number; free: number; ultra: number; master: number; failStreak: number }
  trades: TradeView[]
  wager: WagerView | null
  wagers: WagerView[]
  orders: OrderView[]
}

export type Me = { user: { id: string; handle: string; name: string; avatar: string | null } | null; trainer?: TrainerMine }

export type Activity = {
  id: string
  platform: string
  handle: string
  avatar: string | null
  text: string
  command: string | null
  reply: string | null
  status: 'Replied' | 'Replying' | 'Command' | 'Failed'
  at: number
  url: string | null
}

export type Hit = { round: number; attacker: 0 | 1; damage: number; mult: number; hpLeft: number }
export type Side = { name: string; species: string; sprite: number; level: number; maxHp: number }
export type Battle = {
  id: number
  kind: 'random' | 'gym' | 'pvp' | 'wager' | 'tournament'
  a: { handle: string; avatar: string | null }
  b: { handle: string; avatar: string | null; gym?: number } | null
  winner: 0 | 1
  xpA: number | null
  xpB: number | null
  detail: {
    a?: Side
    b?: Side
    rounds?: number
    decidedBy?: string
    hits?: Hit[]
    hpLeft?: [number, number]
    round?: string
    wager?: number
    survivors?: [number, number]
    duels?: ({ ai: number; bi: number; a: Side; b: Side; rounds: number; hpLeft: [number, number] })[]
  }
  at: number
}

export type LeaderRow = {
  rank: number
  handle: string
  name: string | null
  avatar: string | null
  wins: number
  losses: number
  trainerLevel: number
  bestLevel: number
  party: number
  total: number
  medals: number
}

export type Gym = { n: number; leader: string; pokemon: string; sprite: number; types: string[]; level: number; medals: number }

export type DexEntry = {
  id: number
  name: string
  types: string[]
  rarity: 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythical'
  gen: number
  stats: { hp: number; atk: number; def: number; spa: number; spd: number; spe: number }
  bst: number
  owners: number
  evolutions: { name: string; id: number; level: number | null }[]
  branches: string[]
}

export type TournamentView = {
  id: number
  name: string
  prize: string | null
  status: string
  createdAt: number
  finishedAt: number | null
  winner: string | null
  entries: { handle: string; avatar: string | null; wins: number; seed: number | null; joinedAt: number }[]
  size: number
  prizeAmount: string | null
  walletRequired: boolean
  prizePayout: { status: string; tx: string | null; wallet: string | null; error: string | null } | null
  bracket: {
    seeds: string[]
    matches: {
      round: 'Quarterfinal' | 'Semifinal' | 'Final'
      a: string
      b: string
      aMon: { name: string; level: number; sprite: number } | null
      bMon: { name: string; level: number; sprite: number } | null
      winner: string
      battleId: number | null
    }[]
  } | null
}

export type Stats = {
  token: string | null
  symbol: string
  pool: string | null
  explorer: string
  poolBalance: string | null
  totalSupply: string | null
  totals: { paidIn: string; paidOut: string; refunded: string; burned: string; queued: string }
  counts: { trainers: number; pokemon: number; battles: number; shinies: number; wagers: number; commands: number }
  chain: { enabled: boolean; lastScanAt: number | null; lastSignature: string | null; lastError: string | null; payouts: boolean }
  ledger: {
    id: number
    kind: string
    ref: string
    to: string | null
    from: string | null
    amount: string
    status: string
    tx: string | null
    error: string | null
    at: number
  }[]
}
