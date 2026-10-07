import { useState } from 'react'
import { post, type TournamentView } from '../lib/api.ts'
import { Link } from 'react-router-dom'
import { useApi, useApp } from '../lib/hooks.ts'
import { ago, short, spriteUrl } from '../lib/format.ts'
import { ErrorLine, Handle, Loading, RetryImg, Term } from '../components/ui.tsx'

type Match = NonNullable<TournamentView['bracket']>['matches'][number]

function Side({ handle, mon, win }: { handle: string; mon: Match['aMon']; win: boolean }) {
  return (
    <div className={`side${win ? ' win' : ''}`}>
      {mon ? <RetryImg src={spriteUrl(mon.sprite)} alt={mon.name} /> : <span style={{ width: 32 }} />}
      <span className="handle">@{handle}</span>
      {mon ? <span className="small faint">Lv.{mon.level}</span> : <span className="small faint">forfeit</span>}
    </div>
  )
}

function Bracket({ t }: { t: TournamentView }) {
  if (!t.bracket) return null
  const rounds: Match['round'][] = ['Quarterfinal', 'Semifinal', 'Final']
  return (
    <div className="bracket">
      {rounds.map((r) => (
        <div className="col" key={r}>
          <h4>{r === 'Quarterfinal' ? 'Quarterfinals' : r === 'Semifinal' ? 'Semifinals' : 'Final'}</h4>
          {t.bracket!.matches
            .filter((m) => m.round === r)
            .map((m, i) => (
              <div className="match" key={`${r}${i}`}>
                <Side handle={m.a} mon={m.aMon} win={m.winner === m.a} />
                <Side handle={m.b} mon={m.bMon} win={m.winner === m.b} />
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

function PrizeStatus({ t }: { t: TournamentView }) {
  const p = t.prizePayout
  const label = `${t.prizeAmount} $XPOKE prize`
  if (!p) return <div className="small muted" style={{ marginBottom: 14 }}>{label}: payout not queued yet</div>
  const waitingForFunds = p.status === 'pending' && p.error && /balance|fund|low/i.test(p.error)
  let body
  if (p.status === 'confirmed')
    body = (
      <div className="notice small">
        {label} paid{p.wallet ? ` to ${short(p.wallet)}` : ''}
        {p.tx ? (
          <>
            {' · '}
            <a href={`https://solscan.io/tx/${p.tx}`} target="_blank" rel="noreferrer">
              view on Solscan
            </a>
          </>
        ) : null}
      </div>
    )
  else if (p.status === 'signed') body = <div className="notice small">{label}: sending{p.wallet ? ` to ${short(p.wallet)}` : ''}…</div>
  else if (p.status === 'pending')
    body = (
      <div className={waitingForFunds ? 'warn small' : 'small muted'}>
        {label}: {waitingForFunds ? 'waiting for the prize to be sent to the pool' : `queued${p.wallet ? ` for ${short(p.wallet)}` : ''}`}
      </div>
    )
  else
    body = (
      <div className={p.status === 'failed' ? 'error small' : 'warn small'}>
        {label}: {p.status}
        {p.error ? ` (${p.error})` : ''}
      </div>
    )
  return <div style={{ marginBottom: 14 }}>{body}</div>
}

export default function Tournament() {
  const { me, config } = useApp()
  const { data, error, reload } = useApi<{ open: TournamentView | null; last: TournamentView | null }>('/api/tournament', 20_000)
  const [msg, setMsg] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  if (!data) return error ? <ErrorLine error={error} /> : <Loading />
  const open = data.open
  const needsWallet = Boolean(open?.walletRequired && me?.user && !me.trainer?.wallet)
  const joined = open && me?.user ? open.entries.some((e) => e.handle?.toLowerCase() === me.user!.handle.toLowerCase()) : false

  return (
    <>
      <h1 className="page-title">Tournament</h1>
      <p className="page-sub">
        8-player single elimination. The first 8 to join are seeded 1–8 by wins (1v8, 2v7, 3v6, 4v5). Every match uses each trainer's strongest
        party Pokémon and runs automatically when the bracket fills.
      </p>
      <Term cmd="xpoke --tournament" right={open ? 'open now' : 'no open tournament'}>
        {open ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div className="row">
              <b style={{ fontSize: 18 }}>{open.name}</b>
              {open.prize ? <span className="badge outline">prize: {open.prize}</span> : null}
              <span className="spacer" />
              <span className="mono">
                {open.entries.length}/{open.size} spots
              </span>
            </div>
            {open.prizeAmount ? (
              <div className="paybox" style={{ gap: 4 }}>
                <div className="small muted">prize</div>
                <div className="amount">{open.prizeAmount} $XPOKE</div>
                <div className="small">paid automatically to the champion's linked wallet</div>
              </div>
            ) : null}
            <div className="xpbar">
              <i style={{ width: `${(100 * open.entries.length) / open.size}%` }} />
            </div>
            <div className="row">
              {open.entries.map((e) => (
                <Handle key={e.handle} handle={e.handle} avatar={e.avatar} />
              ))}
            </div>
            <div className="row">
              {me?.user ? (
                <button
                  className="btn primary"
                  disabled={joined || needsWallet}
                  onClick={async () => {
                    setErr(null)
                    try {
                      const r = await post<{ message: string }>('/api/tournament/join')
                      setMsg(r.message)
                      await reload()
                    } catch (e) {
                      setErr((e as Error).message)
                    }
                  }}
                >
                  {joined ? 'You are in' : 'Join Tournament'}
                </button>
              ) : (
                <span className="small muted">
                  Reply "tournament join" to any @{config?.handle} post, or log in to join here.
                </span>
              )}
            </div>
            {needsWallet ? (
              <div className="warn small">
                this tournament pays a token prize, so a linked wallet is needed to join. <Link to="/wallet">Link a wallet to join</Link>
              </div>
            ) : open.walletRequired && !me?.user ? (
              <div className="small muted">a linked wallet is needed to join this prize tournament (link one at /wallet)</div>
            ) : null}
            {msg ? <div className="notice">{msg}</div> : null}
            <ErrorLine error={err} />
          </div>
        ) : (
          <div className="empty">no tournament is open right now. follow @{config?.handle} for the next one</div>
        )}
      </Term>
      {data.last ? (
        <Term cmd="xpoke --bracket" right={data.last.finishedAt ? `finished ${ago(data.last.finishedAt)}` : ''}>
          <div className="row" style={{ marginBottom: 14 }}>
            <b style={{ fontSize: 18 }}>{data.last.name}</b>
            {data.last.prize ? <span className="badge outline">prize: {data.last.prize}</span> : null}
            <span className="spacer" />
            {data.last.winner ? (
              <span className="row" style={{ gap: 6 }}>
                <span className="badge green">champion</span>
                <Handle handle={data.last.winner} />
              </span>
            ) : null}
          </div>
          {data.last.prizeAmount ? <PrizeStatus t={data.last} /> : null}
          <Bracket t={data.last} />
        </Term>
      ) : null}
    </>
  )
}
