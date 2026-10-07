import type { ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useApi, useApp } from '../lib/hooks.ts'
import { Avatar, ErrorLine, Loading, Sprite, Term, Types } from '../components/ui.tsx'

type Board = 'trainers' | 'medals' | 'pokemon' | 'shinies' | 'wagers'

type Row = {
  rank: number
  handle: string
  avatar: string | null
  trainerLevel: number
  value: number
  detail: Record<string, unknown>
}

type TrainerD = { wins: number; losses: number; bestLevel: number; medals: number; pokemon: number }
type MedalD = { highestGym: string | null; wins: number }
type MonD = { name: string; sprite: number; shiny: boolean; types: string[]; rarity: string; wins: number; losses: number; xp: number }
type ShinyD = { best: { name: string; sprite: number; level: number } | null }
type WagerD = { tokensWon: string }

const BOARDS: { key: Board; label: string; cmd: string; empty: string }[] = [
  { key: 'trainers', label: 'Trainers', cmd: 'xpoke --leaderboard trainers', empty: 'no trainers yet. reply "catch" to an XPoke post on X to be the first' },
  { key: 'medals', label: 'Medals', cmd: 'xpoke --leaderboard medals', empty: 'no gym medals won yet. say "battle" on X and beat Cheren to get the first one' },
  { key: 'pokemon', label: 'Pokémon', cmd: 'xpoke --leaderboard pokemon', empty: 'no Pokémon caught yet. reply "catch" to an XPoke post on X' },
  { key: 'shinies', label: 'Shinies', cmd: 'xpoke --leaderboard shinies', empty: 'no shiny caught yet. 1 in 100 catches with a pokeball, 1 in 12 with a master ball' },
  { key: 'wagers', label: 'Wagers', cmd: 'xpoke --leaderboard wagers', empty: 'no wagers settled yet. say "wager @trainer 1000" on X' },
]

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`
}

/** The big number for a row. */
function mainValue(board: Board, r: Row): string {
  switch (board) {
    case 'trainers':
      return plural(r.value, 'win')
    case 'medals':
      return `${r.value} / 13 medals`
    case 'pokemon':
      return `Lv.${r.value}`
    case 'shinies':
      return plural(r.value, 'shiny', 'shinies')
    case 'wagers':
      return `${(r.detail as WagerD).tokensWon} $XPOKE`
  }
}

/** The small line under it on a podium card. */
function secondary(board: Board, r: Row): ReactNode {
  switch (board) {
    case 'trainers': {
      const d = r.detail as TrainerD
      return `Trainer Lv.${r.trainerLevel} · ${d.wins}W ${d.losses}L`
    }
    case 'medals': {
      const d = r.detail as MedalD
      return d.highestGym ? `highest gym: ${d.highestGym}` : `${plural(d.wins, 'win')}`
    }
    case 'pokemon': {
      const d = r.detail as MonD
      return `${d.wins}W ${d.losses}L · ${d.rarity}`
    }
    case 'shinies': {
      const d = r.detail as ShinyD
      return d.best ? `best: ${d.best.name} Lv.${d.best.level}` : `Trainer Lv.${r.trainerLevel}`
    }
    case 'wagers':
      return plural(r.value, 'wager won', 'wagers won')
  }
}

function HandleLink({ handle }: { handle: string }) {
  return (
    <Link to={`/trainer/${handle}`} className="handle lb-handle">
      @{handle}
    </Link>
  )
}

function MonSprite({ d, size }: { d: { sprite: number; shiny?: boolean; name: string }; size: 48 | 72 | 96 }) {
  return (
    <span className={`lb-sprite${d.shiny ? ' shiny' : ''}`} style={{ width: size, height: size }}>
      <Sprite id={d.sprite} shiny={d.shiny} size={size} alt={d.name} />
    </span>
  )
}

const RANK_LABEL = ['1st', '2nd', '3rd']

function Podium({ board, rows, me }: { board: Board; rows: Row[]; me: string | null }) {
  // desktop order 2nd, 1st, 3rd; CSS restores 1-2-3 on a phone
  const order = [rows[1], rows[0], rows[2]].filter(Boolean) as Row[]
  return (
    <div className={`podium n${rows.length}`}>
      {order.map((r) => {
        const mine = me !== null && r.handle.toLowerCase() === me
        const mon = board === 'pokemon' ? (r.detail as MonD) : null
        const shiny = board === 'shinies' ? (r.detail as ShinyD).best : null
        return (
          <div key={`${r.rank}-${r.handle}`} className={`podium-card p${r.rank}${mine ? ' mine' : ''}`}>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className={`lb-rank r${r.rank}`}>{RANK_LABEL[r.rank - 1]}</span>
              {mine ? <span className="badge ink">you</span> : null}
            </div>
            {mon ? (
              <>
                <MonSprite d={mon} size={96} />
                <b className="podium-name">
                  {mon.name}
                  {mon.shiny ? <span className="badge purple" style={{ marginLeft: 6 }}>shiny</span> : null}
                </b>
                <Types types={mon.types} />
              </>
            ) : shiny ? (
              <MonSprite d={{ ...shiny, shiny: true }} size={72} />
            ) : null}
            <div className="row podium-who">
              <Avatar src={r.avatar} handle={r.handle} />
              <HandleLink handle={r.handle} />
            </div>
            <div className="podium-value">{mainValue(board, r)}</div>
            <div className="small muted">{secondary(board, r)}</div>
          </div>
        )
      })}
    </div>
  )
}

/** Main column(s) for ranks 4+. */
function columns(board: Board): { head: string; cell: (r: Row) => ReactNode }[] {
  switch (board) {
    case 'trainers':
      return [
        { head: 'Wins', cell: (r) => <b>{r.value}</b> },
        { head: 'W-L', cell: (r) => `${(r.detail as TrainerD).wins}-${(r.detail as TrainerD).losses}` },
        { head: 'Best Lv', cell: (r) => `Lv.${(r.detail as TrainerD).bestLevel}` },
        { head: 'Medals', cell: (r) => (r.detail as TrainerD).medals },
      ]
    case 'medals':
      return [
        { head: 'Medals', cell: (r) => <b>{r.value} / 13</b> },
        { head: 'Highest gym', cell: (r) => (r.detail as MedalD).highestGym ?? '-' },
      ]
    case 'pokemon':
      return [
        { head: 'Level', cell: (r) => <b>Lv.{r.value}</b> },
        { head: 'W-L', cell: (r) => `${(r.detail as MonD).wins}-${(r.detail as MonD).losses}` },
      ]
    case 'shinies':
      return [
        { head: 'Shinies', cell: (r) => <b>{r.value}</b> },
        { head: 'Best', cell: (r) => ((r.detail as ShinyD).best ? `${(r.detail as ShinyD).best!.name} Lv.${(r.detail as ShinyD).best!.level}` : '-') },
      ]
    case 'wagers':
      return [
        { head: 'Won', cell: (r) => <b>{r.value}</b> },
        { head: '$XPOKE won', cell: (r) => (r.detail as WagerD).tokensWon },
      ]
  }
}

function Rest({ board, rows, me }: { board: Board; rows: Row[]; me: string | null }) {
  const cols = columns(board)
  const who = (r: Row) =>
    board === 'pokemon' ? (
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
        <MonSprite d={r.detail as MonD} size={48} />
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6 }}>
            <b>{(r.detail as MonD).name}</b>
            {(r.detail as MonD).shiny ? <span className="badge purple">shiny</span> : null}
            <Types types={(r.detail as MonD).types} />
          </div>
          <div className="small muted">
            <HandleLink handle={r.handle} />
          </div>
        </div>
      </div>
    ) : (
      <div className="row" style={{ gap: 8, flexWrap: 'nowrap', minWidth: 0 }}>
        <Avatar src={r.avatar} handle={r.handle} />
        <HandleLink handle={r.handle} />
        <span className="badge grey">T.Lv{r.trainerLevel}</span>
      </div>
    )
  return (
    <>
      {/* wide screens: a table */}
      <div className="table-wrap lb-table">
        <table className="tbl">
          <thead>
            <tr>
              <th>#</th>
              <th>{board === 'pokemon' ? 'Pokémon' : 'Trainer'}</th>
              {cols.map((c) => (
                <th key={c.head} className="num">
                  {c.head}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const mine = me !== null && r.handle.toLowerCase() === me
              return (
                <tr key={`${r.rank}-${r.handle}`} className={mine ? 'lb-mine' : ''}>
                  <td className="faint">{r.rank}</td>
                  <td>
                    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                      {who(r)}
                      {mine ? <span className="badge ink">you</span> : null}
                    </div>
                  </td>
                  {cols.map((c) => (
                    <td key={c.head} className="num">
                      {c.cell(r)}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {/* phones: two-line rows */}
      <div className="lb-list">
        {rows.map((r) => {
          const mine = me !== null && r.handle.toLowerCase() === me
          return (
            <div key={`${r.rank}-${r.handle}`} className={`lb-item${mine ? ' lb-mine' : ''}`}>
              <span className="lb-num">{r.rank}</span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="row" style={{ gap: 6 }}>
                  {who(r)}
                  {mine ? <span className="badge ink">you</span> : null}
                </div>
                <div className="small muted lb-sub">
                  {cols.map((c) => (
                    <span key={c.head}>
                      {c.head.toLowerCase()} {c.cell(r)}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </>
  )
}

export default function Leaderboards() {
  const { me } = useApp()
  const [params, setParams] = useSearchParams()
  const raw = params.get('board')
  const board: Board = BOARDS.some((b) => b.key === raw) ? (raw as Board) : 'trainers'
  const meta = BOARDS.find((b) => b.key === board)!
  const { data, error } = useApi<{ board: Board; items: Row[] }>(`/api/leaderboards/${board}?limit=50`, 30_000)
  const myHandle = me?.user?.handle?.toLowerCase() ?? null
  const rows = data && data.board === board ? data.items : null

  return (
    <>
      <div className="center" style={{ marginBottom: 20 }}>
        <h1 className="page-title">Leaderboards</h1>
        <p className="page-sub" style={{ margin: '0 auto' }}>
          The best trainers, Pokémon and collectors on XPoke.
        </p>
      </div>
      <div className="tabs" role="tablist" aria-label="leaderboards">
        {BOARDS.map((b) => (
          <button
            key={b.key}
            role="tab"
            aria-selected={b.key === board}
            className={`tab${b.key === board ? ' active' : ''}`}
            onClick={() => setParams(b.key === 'trainers' ? {} : { board: b.key })}
          >
            {b.label}
          </button>
        ))}
      </div>
      <ErrorLine error={error} />
      {!rows ? (
        error ? null : <Loading />
      ) : !rows.length ? (
        <Term cmd={meta.cmd}>
          <div className="empty">{meta.empty}</div>
        </Term>
      ) : (
        <>
          <Podium board={board} rows={rows.slice(0, 3)} me={myHandle} />
          {rows.length > 3 ? (
            <Term cmd={meta.cmd} right={`ranks 4 to ${rows.length}`} flush>
              <Rest board={board} rows={rows.slice(3)} me={myHandle} />
            </Term>
          ) : null}
        </>
      )}
    </>
  )
}
