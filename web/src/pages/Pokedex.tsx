import { useMemo, useState } from 'react'
import type { DexEntry } from '../lib/api.ts'
import { useApi } from '../lib/hooks.ts'
import { RARITY_ORDER, TYPE_COLORS } from '../lib/format.ts'
import { ErrorLine, Loading, Sprite, Types } from '../components/ui.tsx'

const STATS: [keyof DexEntry['stats'], string][] = [
  ['hp', 'HP'],
  ['atk', 'Atk'],
  ['def', 'Def'],
  ['spa', 'SpA'],
  ['spd', 'SpD'],
  ['spe', 'Spe'],
]

export default function Pokedex() {
  const { data, error } = useApi<{ items: DexEntry[]; total: number }>('/api/pokedex')
  const [q, setQ] = useState('')
  const [type, setType] = useState('')
  const [rarity, setRarity] = useState('')
  const [owned, setOwned] = useState('')
  const [sort, setSort] = useState('id')
  const [open, setOpen] = useState<number | null>(null)

  const list = useMemo(() => {
    if (!data) return []
    const needle = q.trim().toLowerCase()
    const out = data.items.filter(
      (d) =>
        (!needle || d.name.toLowerCase().includes(needle) || String(d.id) === needle) &&
        (!type || d.types.includes(type)) &&
        (!rarity || d.rarity === rarity) &&
        (!owned || (owned === 'owned' ? d.owners > 0 : d.owners === 0)),
    )
    const rank = (r: string) => RARITY_ORDER.indexOf(r as (typeof RARITY_ORDER)[number])
    out.sort((a, b) =>
      sort === 'az' ? a.name.localeCompare(b.name) : sort === 'owned' ? b.owners - a.owners || a.id - b.id : sort === 'rarity' ? rank(b.rarity) - rank(a.rarity) || a.id - b.id : a.id - b.id,
    )
    return out
  }, [data, q, type, rarity, owned, sort])

  const caught = data?.items.filter((d) => d.owners > 0).length ?? 0

  return (
    <>
      <h1 className="page-title">Pokédex</h1>
      <p className="page-sub">
        Every base-form Pokémon you can catch in the wild: {data?.total ?? '...'} species across 8 generations. {caught} caught by trainers so far.
        Evolved forms are reached by levelling up and saying "evolve".
      </p>
      <div className="filters">
        <input className="input" placeholder="search name or #" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="input" value={type} onChange={(e) => setType(e.target.value)} style={{ flex: '0 1 140px' }}>
          <option value="">all types</option>
          {Object.keys(TYPE_COLORS).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className="input" value={rarity} onChange={(e) => setRarity(e.target.value)} style={{ flex: '0 1 140px' }}>
          <option value="">all rarities</option>
          {RARITY_ORDER.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select className="input" value={owned} onChange={(e) => setOwned(e.target.value)} style={{ flex: '0 1 140px' }}>
          <option value="">owned + uncaught</option>
          <option value="owned">owned</option>
          <option value="uncaught">uncaught</option>
        </select>
        <select className="input" value={sort} onChange={(e) => setSort(e.target.value)} style={{ flex: '0 1 150px' }}>
          <option value="id">sort: number</option>
          <option value="az">sort: A–Z</option>
          <option value="owned">sort: most owned</option>
          <option value="rarity">sort: rarity</option>
        </select>
      </div>
      <ErrorLine error={error} />
      {!data ? <Loading /> : null}
      {data ? (
        <div className="small muted" style={{ marginBottom: 10 }}>
          {list.length} shown
        </div>
      ) : null}
      <div className="dex-grid">
        {list.map((d) => (
          <button key={d.id} className={`dex${d.owners ? '' : ' uncaught'}`} onClick={() => setOpen(open === d.id ? null : d.id)}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="id">#{String(d.id).padStart(3, '0')}</span>
              <span className={`small rarity-${d.rarity}`}>{d.rarity}</span>
            </div>
            <Sprite id={d.id} size={80} alt={d.name} />
            <b>{d.name}</b>
            <Types types={d.types} />
            <span className="small muted">{d.owners ? `${d.owners} trainer${d.owners === 1 ? '' : 's'}` : 'uncaught'}</span>
            {d.evolutions.length ? (
              <span className="small faint">
                {d.evolutions.map((e) => `${e.name}${e.level ? ` Lv.${e.level}` : ''}`).join(' → ')}
                {d.branches.length > 1 ? ` (+${d.branches.length - 1} other branch${d.branches.length > 2 ? 'es' : ''})` : ''}
              </span>
            ) : (
              <span className="small faint">does not evolve</span>
            )}
            {open === d.id ? (
              <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 3 }}>
                {STATS.map(([k, label]) => (
                  <div className="stat-row" key={k}>
                    <span className="faint">{label}</span>
                    <b>{d.stats[k]}</b>
                    <span className="bar">
                      <i style={{ width: `${Math.min(100, (d.stats[k] / 180) * 100)}%` }} />
                    </span>
                  </div>
                ))}
                <span className="small muted">
                  total {d.bst} · gen {d.gen}
                </span>
                {d.branches.length > 1 ? <span className="small faint">branches: {d.branches.join(', ')} (first is used)</span> : null}
              </div>
            ) : null}
          </button>
        ))}
      </div>
    </>
  )
}
