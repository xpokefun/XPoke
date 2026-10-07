export function ago(t: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return `${s}s ago`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 48) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

export function duration(ms: number): string {
  if (ms <= 0) return '0s'
  const total = Math.ceil(ms / 1000)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h) return `${h}h ${m}m`
  if (m) return `${m}m ${s.toString().padStart(2, '0')}s`
  return `${s}s`
}

/** base58 is case-sensitive: shown as-is, first4…last4. */
export function short(addr: string | null | undefined, n = 4): string {
  if (!addr) return ''
  if (addr.length <= 2 * n + 2) return addr
  return `${addr.slice(0, n)}…${addr.slice(-n)}`
}

/** Dev-mode rows carry fake signatures that have no explorer page. */
export function isDevTx(tx: string | null | undefined): boolean {
  return !tx || tx.startsWith('dev-') || tx.startsWith('0xdev')
}

export function spriteUrl(id: number, shiny = false): string {
  return shiny ? `/sprites/shiny/${id}.png` : `/sprites/${id}.png`
}

export const TYPE_COLORS: Record<string, string> = {
  normal: '#a8a77a',
  fire: '#ee8130',
  water: '#6390f0',
  electric: '#f7d02c',
  grass: '#7ac74c',
  ice: '#96d9d6',
  fighting: '#c22e28',
  poison: '#a33ea1',
  ground: '#e2bf65',
  flying: '#a98ff3',
  psychic: '#f95587',
  bug: '#a6b91a',
  rock: '#b6a136',
  ghost: '#735797',
  dragon: '#6f35fc',
  dark: '#705746',
  steel: '#b7b7ce',
  fairy: '#d685ad',
}

export const RARITY_ORDER = ['common', 'uncommon', 'rare', 'legendary', 'mythical'] as const
