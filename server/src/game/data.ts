/**
 * Pokédex data, built from PokeAPI's CSVs by scripts/build-data.py.
 *
 * Catchable = base form (stage 1) of generations 1–8. Baby Pokémon are skipped, so Pikachu, not Pichu,
 * is the wild form, as the docs describe.
 */
import pokemonJson from '../data/pokemon.json' with { type: 'json' }
import typesJson from '../data/types.json' with { type: 'json' }

export type Rarity = 'common' | 'uncommon' | 'rare' | 'legendary' | 'mythical'

export type Species = {
  id: number
  /** PokeAPI pokemon id for an alternate form (megas), else null. Sprites are keyed by `form ?? id`. */
  form: number | null
  key: string
  name: string
  types: string[]
  hp: number
  atk: number
  def: number
  spa: number
  spd: number
  spe: number
  gen?: number
  legendary?: boolean
  mythical?: boolean
  base?: boolean
  stage?: number
  from?: number | null
  evolvesTo?: number[]
  evolveLevel?: number | null
  rarity: Rarity
  bst: number
}

const raw = pokemonJson as unknown as { species: Record<string, Species>; forms: Record<string, Species> }

export const SPECIES = new Map<number, Species>(Object.values(raw.species).map((s) => [s.id, s]))
export const FORMS = raw.forms
export const TYPE_CHART = typesJson as Record<string, Record<string, number>>

export const CATCHABLE: Species[] = [...SPECIES.values()].filter((s) => s.base)

export function species(id: number): Species {
  const s = SPECIES.get(id)
  if (!s) throw new Error(`unknown species ${id}`)
  return s
}

export function spriteId(s: Species): number {
  return s.form ?? s.id
}

/** Lower-cased, punctuation-free names → species, for parsing "check pikachu". */
const BY_NAME = new Map<string, Species>()
export function normName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/♀/g, 'f')
    .replace(/♂/g, 'm')
    .replace(/[^a-z0-9]/g, '')
}
for (const s of SPECIES.values()) {
  BY_NAME.set(normName(s.name), s)
  BY_NAME.set(normName(s.key), s)
}
// "nidoran" alone: the female line (#29), since neither spelling survives normalisation
if (!BY_NAME.has('nidoran')) BY_NAME.set('nidoran', SPECIES.get(29)!)
export function speciesByName(name: string): Species | null {
  return BY_NAME.get(normName(name)) ?? null
}

/**
 * Wild encounter weights by rarity. Legendaries are findable (the docs tell players to hunt them) but
 * rarer than common Pokémon, and still more common than a shiny (1.5%) "in practice".
 */
export const RARITY_WEIGHT: Record<Rarity, number> = {
  common: 60,
  uncommon: 22,
  rare: 13,
  legendary: 4,
  mythical: 1,
}

export function rollWildSpecies(rand: () => number = Math.random): Species {
  const byRarity = new Map<Rarity, Species[]>()
  for (const s of CATCHABLE) {
    const list = byRarity.get(s.rarity) ?? []
    list.push(s)
    byRarity.set(s.rarity, list)
  }
  const total = Object.values(RARITY_WEIGHT).reduce((a, b) => a + b, 0)
  let r = rand() * total
  for (const [rarity, w] of Object.entries(RARITY_WEIGHT) as [Rarity, number][]) {
    if ((r -= w) < 0) {
      const list = byRarity.get(rarity)!
      return list[Math.floor(rand() * list.length)]!
    }
  }
  return CATCHABLE[0]!
}

export const TYPE_EMOJI_FREE = true
export function titleType(t: string): string {
  return t.charAt(0).toUpperCase() + t.slice(1)
}
