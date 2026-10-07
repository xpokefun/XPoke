import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import type { Activity, Battle, Gym, LeaderRow, Mon, WagerView } from '../lib/api.ts'
import { useApi, useApp, useNow } from '../lib/hooks.ts'
import { ago, duration, short } from '../lib/format.ts'
import { CopyPill, ErrorLine, Handle, Loading, Logo, MonCard, MonMini, Sprite, StatusTag, Term, Types } from '../components/ui.tsx'

type Status = { platforms: { platform: string; online: boolean; lastPollAt: number | null }[] }
type Pending = {
  challenges: { id: number; challenger: string; target: string; pokemon: { name: string; level: number; sprite: number; shiny: boolean } | null; createdAt: number; expiresAt: number }[]
  wagers: WagerView[]
}
type TrainerCard = { handle: string; name: string | null; avatar: string | null; wins: number; trainerLevel: number; rank: number | null; party: Mon[]; total: number }

export default function Home() {
  const { config } = useApp()
  const handle = config?.handle ?? 'xpokefun'

  return (
    <>
      <div className="hero">
        <Logo size={120} />
        <h1 className="hero-logo">XPoke</h1>
        <p className="hero-tag">
          Catch, train and battle Pokémon by talking to <b>@{handle}</b> on X.
        </p>
        <div className="hero-ca">
          {config?.token.mint ? (
            <CopyPill value={config.token.mint} label="CA" display={short(config.token.mint, 6)} />
          ) : (
            <span className="pill">
              <span className="tag">CA</span>
              <span>coming soon</span>
            </span>
          )}
        </div>
        <div className="hero-links">
          <a className="btn" href={`https://x.com/${handle}`} target="_blank" rel="noreferrer">
            @{handle}
          </a>
          <Link className="btn" to="/stats">
            on-chain stats
          </Link>
          <Link className="btn primary" to="/docs">
            how to play
          </Link>
        </div>
      </div>

      <div className="grid two">
        <div>
          <Help handle={handle} />
          <AgentStatus />
          <ActivityFeed />
        </div>
        <div>
          <PvpLog />
          <PvpQueue />
          <Leaderboard />
        </div>
      </div>
      <GymHall />
      <Trainers />
      <UpdateLog />
    </>
  )
}

function Help({ handle }: { handle: string }) {
  return (
    <Term cmd="xpoke --help" right="how the agent works">
      <p style={{ marginTop: 0 }}>
        Mention <b>@{handle}</b> on X with a command in plain words: <code className="code">catch</code>, <code className="code">check</code>,{' '}
        <code className="code">feed</code>, <code className="code">battle</code>, <code className="code">evolve</code> and more. The agent runs it
        instantly and updates your game.
      </p>
      <p className="muted" style={{ marginBottom: 0 }}>
        To keep the account healthy it posts at most <b>3 public replies per hour per user</b>. Over that limit your command still runs; the result
        just appears in the log below instead of as a reply, tagged <span className="badge grey">Command</span> instead of{' '}
        <span className="badge green">Replied</span>.
      </p>
    </Term>
  )
}

function AgentStatus() {
  const { data } = useApi<Status>('/api/agent/status', 30_000)
  return (
    <Term cmd="xpoke --status" right="agent status">
      <div className="row" style={{ gap: 18 }}>
        {(data?.platforms ?? [{ platform: 'x', online: false }, { platform: 'reddit', online: false }]).map((p) => (
          <span key={p.platform} className="row" style={{ gap: 8 }}>
            <span className={`status-dot ${p.online ? 'on' : 'off'}`} />
            <b>{p.platform === 'x' ? 'X' : 'Reddit'}</b>
            <span className="muted">{p.online ? 'online' : 'offline'}</span>
          </span>
        ))}
      </div>
    </Term>
  )
}

function ActivityFeed() {
  const { data, error } = useApi<{ items: Activity[]; announcements: { at: number; text: string }[] }>('/api/agent/activity?limit=25', 15_000)
  const now = useNow(15_000)
  return (
    <Term cmd="xpoke --agent-log" right={<Link to="/agent">full log</Link>} flush scroll>
      <ErrorLine error={error} />
      {!data ? <Loading /> : null}
      {data && !data.items.length && !data.announcements.length ? <div className="empty">no commands yet. be the first to say catch</div> : null}
      {data?.announcements.slice(0, 3).map((a) => (
        <div className="feed-item" key={`a${a.at}${a.text}`}>
          <span className="badge ink">news</span>
          <div className="body">
            <div className="small">{a.text}</div>
            <div className="small faint">{ago(a.at, now)}</div>
          </div>
        </div>
      ))}
      {data?.items.map((m) => (
        <div className="feed-item" key={m.id}>
          <Handle handle={m.handle} avatar={m.avatar} />
          <div className="body">
            <div className="row" style={{ gap: 6 }}>
              <StatusTag status={m.status} />
              {m.command ? <span className="small mono">{m.command}</span> : null}
              <span className="spacer" />
              <span className="small faint">{ago(m.at, now)}</span>
            </div>
            <div className="said">{m.text}</div>
            {m.reply ? <div className="reply">{m.reply}</div> : null}
          </div>
        </div>
      ))}
    </Term>
  )
}

function kindLabel(k: Battle['kind']): string {
  return k === 'random' ? 'battle' : k
}

export function BattleLine({ b, now }: { b: Battle; now: number }) {
  const aWon = b.winner === 0
  const d = b.detail
  if (b.kind === 'wager') {
    return (
      <div className="feed-item">
        <span className="badge ink">wager</span>
        <div className="body small">
          <Handle handle={aWon ? b.a.handle : b.b?.handle} /> beat <Handle handle={aWon ? b.b?.handle : b.a.handle} /> 3v3
          {d.survivors ? ` with ${d.survivors[b.winner]} standing` : ''}
          <div className="faint">{ago(b.at, now)}</div>
        </div>
      </div>
    )
  }
  const winner = aWon ? d.a : d.b
  const loser = aWon ? d.b : d.a
  return (
    <div className="feed-item">
      <span className={`badge ${b.kind === 'gym' || b.kind === 'pvp' || b.kind === 'tournament' ? 'ink' : 'grey'}`}>{kindLabel(b.kind)}</span>
      <div className="body small">
        <div className="row" style={{ gap: 6 }}>
          {winner ? <MonMini name={winner.name} sprite={winner.sprite} level={winner.level} /> : null}
          <span className="muted">beat</span>
          {loser ? <MonMini name={loser.name} sprite={loser.sprite} level={loser.level} /> : null}
        </div>
        <div className="faint">
          {d.rounds} round{d.rounds === 1 ? '' : 's'}
          {d.decidedBy === 'hp' ? ', decided on HP%' : ''}
          {b.xpA !== null ? ` · @${b.a.handle} ${b.xpA > 0 ? '+' : ''}${b.xpA} xp` : ''} · {ago(b.at, now)}
        </div>
      </div>
    </div>
  )
}

function PvpLog() {
  const { data } = useApi<{ items: Battle[] }>('/api/pvp/recent?limit=12', 20_000)
  const now = useNow(20_000)
  return (
    <Term cmd="xpoke --pvp-log" right="recent battles" flush scroll>
      {!data ? <Loading /> : data.items.length ? data.items.map((b) => <BattleLine key={b.id} b={b} now={now} />) : <div className="empty">no battles yet</div>}
    </Term>
  )
}

function PvpQueue() {
  const { data } = useApi<Pending>('/api/pvp/pending', 20_000)
  const now = useNow(1000)
  const empty = data && !data.challenges.length && !data.wagers.length
  return (
    <Term cmd="xpoke --pvp-queue" right="open challenges" flush>
      {!data ? <Loading /> : null}
      {empty ? <div className="empty">no open challenges. say "challenge @trainer"</div> : null}
      {data?.challenges.map((c) => (
        <div className="feed-item" key={`c${c.id}`}>
          <span className="badge blue">pvp</span>
          <div className="body small">
            <div className="row" style={{ gap: 6 }}>
              <Handle handle={c.challenger} /> challenged <Handle handle={c.target} />
            </div>
            {c.pokemon ? <MonMini name={c.pokemon.name} sprite={c.pokemon.sprite} level={c.pokemon.level} shiny={c.pokemon.shiny} /> : null}
            <div className="faint">expires in {duration(c.expiresAt - now)}</div>
          </div>
        </div>
      ))}
      {data?.wagers.map((w) => (
        <div className="feed-item" key={`w${w.id}`}>
          <span className="badge ink">wager</span>
          <div className="body small">
            <div className="row" style={{ gap: 6 }}>
              <Handle handle={w.challenger?.handle} /> vs <Handle handle={w.target?.handle} />
              <b>{w.amount} $XPOKE</b>
            </div>
            <div className="faint">
              {w.status === 'pending_accept'
                ? 'waiting for accept'
                : `waiting for payment · ${w.paidA ? 1 : 0}${w.paidB ? '+1' : ''}/2 paid · ${duration((w.payDeadline ?? now) - now)} left`}
            </div>
          </div>
        </div>
      ))}
    </Term>
  )
}

function Leaderboard() {
  const { data } = useApi<{ items: LeaderRow[] }>('/api/leaderboard?limit=25', 30_000)
  return (
    <Term cmd="xpoke --leaderboard" right="top trainers by wins" flush>
      {!data ? (
        <Loading />
      ) : !data.items.length ? (
        <div className="empty">no trainers yet</div>
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>#</th>
                <th>Trainer</th>
                <th className="num">Wins</th>
                <th className="num">Best Lv</th>
                <th className="num">Pkmn</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => (
                <tr key={r.handle}>
                  <td className="faint">{r.rank}</td>
                  <td>
                    <div className="row" style={{ gap: 8, flexWrap: 'nowrap' }}>
                      <Handle handle={r.handle} avatar={r.avatar} />
                      <span className="badge grey">T.Lv{r.trainerLevel}</span>
                    </div>
                  </td>
                  <td className="num">
                    <b>{r.wins}</b> W
                  </td>
                  <td className="num">Lv. {r.bestLevel}</td>
                  <td className="num">{r.party} / 3</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Term>
  )
}

function GymHall() {
  const { data } = useApi<{ gyms: Gym[] }>('/api/gym')
  return (
    <Term cmd="xpoke --gyms" right="13 gym leaders, one medal each">
      <p className="muted small" style={{ marginTop: 0 }}>
        When no trainer within 5 levels is around, a Gym Bot steps in, starting with the first gym you have not beaten. Gym Bots hit harder and
        have more HP; losing costs 50 xp.
      </p>
      {!data ? (
        <Loading />
      ) : (
        <div className="gym-grid">
          {data.gyms.map((g) => (
            <div className="gym" key={g.n}>
              <span className="n">#{g.n}</span>
              <Sprite id={g.sprite} size={80} alt={g.pokemon} />
              <div className="leader">{g.leader}</div>
              <div className="small">
                {g.pokemon} <b>Lv.{g.level}</b>
              </div>
              <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0' }}>
                <Types types={g.types} />
              </div>
              <div className="small faint">
                {g.medals} medal{g.medals === 1 ? '' : 's'} awarded
              </div>
            </div>
          ))}
        </div>
      )}
    </Term>
  )
}

function Trainers() {
  const [q, setQ] = useState('')
  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250)
    return () => {
      clearTimeout(t)
    }
  }, [q])
  const { data, error } = useApi<{ items: TrainerCard[] }>(`/api/trainers?limit=30${debounced ? `&q=${encodeURIComponent(debounced)}` : ''}`)
  const now = useNow(30_000)
  const [loadedAt, setLoadedAt] = useState(Date.now())
  useEffect(() => {
    setLoadedAt(Date.now())
  }, [data])
  return (
    <Term cmd="xpoke --trainers" right={`${data?.items.length ?? 0} shown`}>
      <div className="filters">
        <input className="input" placeholder="filter by @handle" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorLine error={error} />
      {!data ? <Loading /> : !data.items.length ? <div className="empty">no trainers match</div> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {data?.items.map((t) => (
          <div key={t.handle}>
            <div className="row" style={{ marginBottom: 8 }}>
              <Handle handle={t.handle} avatar={t.avatar} />
              <span className="small muted">
                {t.party.length} Pokémon in party · {t.wins}W · Trainer Lv.{t.trainerLevel}
                {t.rank ? ` (#${t.rank})` : ''}
              </span>
            </div>
            <div className="mon-grid">
              {t.party.map((m) => (
                <MonCard key={m.id} mon={m} now={now} loadedAt={loadedAt} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Term>
  )
}

const UPDATES: { date: string; title: string; items: string[] }[] = [
  {
    date: '2026-10-07',
    title: 'shop burns',
    items: ['Every $XPOKE spent on ultra and master balls is burned in full. Each purchase lowers the total supply.'],
  },
  {
    date: '2026-10-07',
    title: 'Solana',
    items: [
      '$XPOKE is an SPL token on Solana. Wagers and the pokeball shop are paid from any Solana wallet (Phantom, Solflare, Backpack) or with a Solana Pay link.',
      'Network fees are paid in SOL. Wager winnings go back to the wallet that paid, and the 1% fee is burned with an SPL burn, so supply drops.',
      'Every payment, payout, refund and burn is listed with its Solana signature on /stats.',
    ],
  },
  {
    date: '2026-10-07',
    title: 'XPoke is live',
    items: [
      'Catching: 471 base-form Pokémon from all 8 generations, with free daily pokeballs (5 a day), ultra balls and master balls with a pity counter.',
      'Battles with real Pokédex stats: speed decides who goes first, type advantages apply, 10 rounds max, level scaling.',
      'PvP challenges: "challenge @trainer", they reply "accept". Pokémon lock while a challenge is pending.',
      '13 Gym Leaders from Lv.3 to Lv.200, each with a medal on your profile.',
      'Wagers: 3v3 battles staked in $XPOKE. Winner takes 99%, 1% is burned forever, every payment and payout listed with its signature on /stats.',
      'Trading and gifting between trainers, confirmed on the website.',
      '8-player tournaments with automatic seeding and a public bracket.',
      'Shiny Pokémon, growth stages from feeding, trainer levels from total wins.',
      'Agent reply limit: 3 public replies per hour per user. Every command still runs and shows in the agent log.',
    ],
  },
]

function UpdateLog() {
  return (
    <Term cmd="xpoke --changelog" right="update log">
      {UPDATES.map((u) => (
        <div key={u.date}>
          <div className="row">
            <span className="update-date">{u.date}</span>
            <b>{u.title}</b>
          </div>
          <ul className="updates small muted">
            {u.items.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ))}
    </Term>
  )
}
