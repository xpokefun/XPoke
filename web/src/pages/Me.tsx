import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { post, type Mon, type TrainerPublic, type WagerView } from '../lib/api.ts'
import { useApp, useNow } from '../lib/hooks.ts'
import { ago, duration, isDevTx, short } from '../lib/format.ts'
import { Avatar, ErrorLine, Handle, Loading, MonCard, MonMini, Term } from '../components/ui.tsx'
import { PayBox } from '../components/PayBox.tsx'

const GYM_LEADERS = ['Cheren', 'Skyla', 'Elesa', 'Shauntal', 'Drayden', 'Caitlin', 'Marlon', 'Grimsley', 'Iris', 'Colress', 'N', 'Ghetsis', 'Alder']

export function Medals({ t }: { t: TrainerPublic }) {
  const have = new Map(t.medals.map((m) => [m.n, m]))
  return (
    <div className="medals">
      {GYM_LEADERS.map((name, i) => {
        const m = have.get(i + 1)
        return (
          <div key={name} className={`medal${m ? ' on' : ''}`} title={m ? `${name} medal, earned ${new Date(m.earnedAt).toLocaleDateString()}` : `${name}: not yet`}>
            {i + 1}
          </div>
        )
      })}
    </div>
  )
}

export function TrainerHeader({ t, extra }: { t: TrainerPublic; extra?: ReactNode }) {
  return (
    <div className="me-head">
      <Avatar src={t.avatar} handle={t.handle} lg />
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8 }}>
          <span className="page-title" style={{ margin: 0, fontSize: 16 }}>
            @{t.handle}
          </span>
          <span className="badge ink">Trainer Lv.{t.trainerLevel}</span>
        </div>
        <div className="muted small">
          {t.wins} wins · {t.losses} losses
          {t.nextLevelAt !== null ? ` · next trainer level at ${t.nextLevelAt} wins` : ' · max trainer level'}
        </div>
      </div>
      <span className="spacer" />
      {extra}
    </div>
  )
}

export function LoggedOut({ title = 'My Pokémon' }: { title?: string }) {
  const { config, reloadMe } = useApp()
  const [handle, setHandle] = useState('')
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="card center" style={{ maxWidth: 520, margin: '40px auto', display: 'flex', flexDirection: 'column', gap: 14, alignItems: 'center' }}>
      <h1 className="page-title">{title}</h1>
      <p className="muted" style={{ margin: 0 }}>
        Log in with the X account you play with to manage your party and boxes, accept trades and pay wagers.
      </p>
      {config?.loginWithX ? (
        <a className="btn primary" href="/auth/x/login">
          Login with X
        </a>
      ) : (
        <span className="small faint">Login with X is not configured on this server yet.</span>
      )}
      {config?.devLogin ? (
        <form
          className="row"
          style={{ width: '100%', flexWrap: 'nowrap' }}
          onSubmit={async (e) => {
            e.preventDefault()
            try {
              await post('/api/dev/login', { handle })
              await reloadMe()
            } catch (err) {
              setError((err as Error).message)
            }
          }}
        >
          <input className="input" style={{ flex: 1 }} placeholder="dev login: handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
          <button className="btn">dev login</button>
        </form>
      ) : null}
      <ErrorLine error={error} />
    </div>
  )
}

export default function MePage() {
  const { me, reloadMe, config } = useApp()
  const now = useNow(1000)
  const [loadedAt, setLoadedAt] = useState(Date.now())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    setLoadedAt(Date.now())
  }, [me])

  useEffect(() => {
    const t = setInterval(() => {
      void reloadMe()
    }, 20_000)
    return () => {
      clearInterval(t)
    }
  }, [reloadMe])

  if (!me) return <Loading />
  if (!me.user || !me.trainer) return <LoggedOut />
  const t = me.trainer

  async function act(fn: () => Promise<unknown>, ok?: string) {
    setError(null)
    setNotice(null)
    try {
      const r = (await fn()) as { message?: string }
      setNotice(r?.message ?? ok ?? null)
      await reloadMe()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const move = (m: Mon, to: string) => act(() => post('/api/me/move', { id: m.id, to }))

  const actionsFor = (m: Mon) => {
    const locked = Boolean(m.lock)
    if (m.location === 'party')
      return (
        <>
          <button className="btn sm" disabled={locked} onClick={() => move(m, 'box1')}>
            Send to Box
          </button>
          <button className="btn sm" disabled={locked} onClick={() => move(m, 'box2')}>
            → Box 2
          </button>
        </>
      )
    return (
      <>
        <button className="btn sm" disabled={t.party.length >= 3} onClick={() => move(m, 'party')} title={t.party.length >= 3 ? 'party is full' : ''}>
          → Party
        </button>
        <button className="btn sm" onClick={() => move(m, m.location === 'box1' ? 'box2' : 'box1')}>
          → {m.location === 'box1' ? 'Box 2' : 'Box 1'}
        </button>
      </>
    )
  }

  const column = (title: string, list: Mon[], empty: string) => (
    <div>
      <h3>
        {title} <span className="faint">({list.length})</span>
      </h3>
      <div className="stack">
        {list.length ? list.map((m) => <MonCard key={m.id} mon={m} now={now} loadedAt={loadedAt} actions={actionsFor(m)} />) : <div className="card empty small">{empty}</div>}
      </div>
    </div>
  )

  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <TrainerHeader
          t={t}
          extra={
            <button
              className="btn ghost sm"
              onClick={async () => {
                await post('/auth/logout')
                await reloadMe()
              }}
            >
              Logout
            </button>
          }
        />
        <div className="row" style={{ marginTop: 14 }}>
          <div className="balls">
            <span className="ball-count">
              pokeballs <b>{t.balls.poke}</b>
              <span className="faint small">({t.balls.free} free today)</span>
            </span>
            <span className="ball-count">
              ultra <b>{t.balls.ultra}</b>
            </span>
            <span className="ball-count">
              master <b>{t.balls.master}</b>
            </span>
          </div>
          <Link className="btn primary sm" to="/shop">
            Buy Pokeballs
          </Link>
          <Link className={`badge ${t.wallet ? 'outline' : 'yellow'}`} to="/wallet" style={{ textDecoration: 'none' }}>
            {t.wallet ? `wallet ${short(t.wallet.address)}` : 'link wallet'}
          </Link>
        </div>
        <div style={{ marginTop: 14 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            gym medals ({t.medals.length}/13)
          </div>
          <Medals t={t} />
        </div>
      </div>

      {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}
      {notice ? <div className="notice" style={{ marginBottom: 12 }}>{notice}</div> : null}

      {t.wager ? <WagerPanel w={t.wager} now={now} pool={config?.pool ?? null} mint={config?.token.mint ?? null} linked={t.wallet?.address ?? null} onDone={reloadMe} setError={setError} /> : null}

      {t.trades.length ? (
        <Term cmd="xpoke --trades" right="pending">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {t.trades.map((tr) => (
              <div key={tr.id} className="row">
                <span className="small">
                  {tr.incoming ? (
                    <>
                      <Handle handle={tr.from} /> offers
                    </>
                  ) : (
                    <>
                      you offer <Handle handle={tr.to} />
                    </>
                  )}
                </span>
                {tr.offer ? <MonMini name={tr.offer.name} sprite={tr.offer.sprite} level={tr.offer.level} shiny={tr.offer.shiny} /> : null}
                {tr.want ? (
                  <>
                    <span className="muted small">for</span>
                    <MonMini name={tr.want.name} sprite={tr.want.sprite} level={tr.want.level} shiny={tr.want.shiny} />
                  </>
                ) : (
                  <span className="badge purple">gift</span>
                )}
                <span className="small faint">{ago(tr.createdAt, now)}</span>
                <span className="spacer" />
                {tr.incoming ? (
                  <>
                    <button className="btn primary sm" onClick={() => act(() => post(`/api/me/trade/${tr.id}`, { accept: true }))}>
                      Accept
                    </button>
                    <button className="btn sm" onClick={() => act(() => post(`/api/me/trade/${tr.id}`, { accept: false }))}>
                      Decline
                    </button>
                  </>
                ) : (
                  <button className="btn sm" onClick={() => act(() => post(`/api/me/trade/${tr.id}`, { accept: false }))}>
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        </Term>
      ) : null}

      <div className="columns" style={{ marginBottom: 16 }}>
        {column('Party', t.party, 'no Pokémon in your party. reply "catch" to an XPoke post')}
        {column('Box 1', t.box1, 'empty')}
        {column('Box 2', t.box2, 'empty')}
      </div>

      <div className="grid two">
        <Term cmd="xpoke --wagers" right="recent">
          {t.wagers.length ? (
            <div className="table-wrap">
              <table className="tbl">
                <tbody>
                  {t.wagers.map((w) => (
                    <tr key={w.id}>
                      <td className="faint">#{w.id}</td>
                      <td>
                        @{w.challenger?.handle} vs @{w.target?.handle}
                      </td>
                      <td className="num">{w.amount}</td>
                      <td>
                        <WagerStatus w={w} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty small">no wagers yet. say "wager @trainer 1000"</div>
          )}
        </Term>
        <Term cmd="xpoke --orders" right="shop">
          {t.orders.length ? (
            <div className="table-wrap">
              <table className="tbl">
                <tbody>
                  {t.orders.map((o) => (
                    <tr key={o.id}>
                      <td className="faint">#{o.id}</td>
                      <td>
                        {o.qty} {o.ball}
                      </td>
                      <td className="num mono">{o.amount}</td>
                      <td>
                        {o.tx && config && !isDevTx(o.tx) ? (
                          <a href={`${config.explorer}/tx/${o.tx}`} target="_blank" rel="noreferrer">
                            <span className={`badge ${o.status === 'paid' ? 'green' : 'grey'}`}>{o.status}</span>
                          </a>
                        ) : (
                          <span className={`badge ${o.status === 'paid' ? 'green' : 'grey'}`}>{o.status}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="empty small">
              no orders. <Link to="/shop">visit the shop</Link>
            </div>
          )}
        </Term>
      </div>
    </>
  )
}

function WagerStatus({ w }: { w: WagerView }) {
  if (w.status === 'complete') {
    const won = (w.winner === 0 && w.mySide === 'a') || (w.winner === 1 && w.mySide === 'b')
    return <span className={`badge ${won ? 'green' : 'red'}`}>{won ? 'won' : 'lost'}</span>
  }
  if (w.status === 'cancelled') return <span className="badge grey" title={w.cancelReason ?? ''}>cancelled</span>
  return <span className="badge grey">{w.status === 'pending_accept' ? 'waiting accept' : 'awaiting payment'}</span>
}

function WagerPanel({
  w,
  now,
  pool,
  mint,
  linked,
  onDone,
  setError,
}: {
  w: WagerView
  now: number
  pool: string | null
  mint: string | null
  linked: string | null
  onDone: () => Promise<void>
  setError: (e: string | null) => void
}) {
  const handle = useApp().config?.handle ?? 'xpokefun'
  const mine = w.mySide === 'a' ? { amount: w.payA, paid: w.paidA } : { amount: w.payB, paid: w.paidB }
  const left = w.payDeadline ? w.payDeadline - now : 0
  const anyPaid = w.paidA || w.paidB
  const canCancel = w.status === 'pending_accept' || !anyPaid || left <= 0
  const team = (list: WagerView['teamA']) => (
    <div className="team">{list.map((m, i) => (m ? <MonMini key={m.id} name={m.name} sprite={m.sprite} level={m.level} shiny={m.shiny} /> : <span key={i} className="faint">?</span>))}</div>
  )
  return (
    <Term cmd={`xpoke --wager ${w.id}`} right={`${w.amount} $XPOKE`}>
      <div className="grid two">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <div className="row small">
              <Handle handle={w.challenger?.handle} />
              <span className={`badge ${w.paidA ? 'green' : 'grey'}`}>{w.paidA ? 'paid' : 'unpaid'}</span>
            </div>
            {team(w.teamA)}
          </div>
          <div>
            <div className="row small">
              <Handle handle={w.target?.handle} />
              {w.status === 'pending_accept' ? <span className="badge grey">hasn't accepted</span> : <span className={`badge ${w.paidB ? 'green' : 'grey'}`}>{w.paidB ? 'paid' : 'unpaid'}</span>}
            </div>
            {w.teamB.length ? team(w.teamB) : <span className="small faint">team locks on accept</span>}
          </div>
          <div className="small muted">
            3v3 in order with HP carry-over. Winner takes 99% of what both sides sent, 1% is burned. Both sides must pay within 15 minutes of
            accepting or the wager cancels and payments are refunded.
          </div>
          <PayoutNote w={w} linked={linked} />
          {w.status === 'awaiting_payment' ? (
            <div className="row">
              <span className="badge yellow">{left > 0 ? `${duration(left)} left to pay` : 'window closed, cancelling'}</span>
            </div>
          ) : null}
          <div className="row">
            <button
              className="btn sm"
              disabled={!canCancel}
              onClick={async () => {
                setError(null)
                try {
                  const r = await post<{ message: string }>(`/api/me/wager/${w.id}/cancel`)
                  if (r?.message && !/cancelled/.test(r.message)) setError(r.message)
                  await onDone()
                } catch (e) {
                  setError((e as Error).message)
                }
              }}
            >
              Cancel wager
            </button>
            {!canCancel ? <span className="small faint">a payment is in: cancel opens when the 15-minute window passes</span> : null}
          </div>
        </div>
        <div>
          {w.status === 'pending_accept' ? (
            w.mySide === 'b' ? (
              <div className="notice">
                @{w.challenger?.handle} challenged you. reply <b>accept wager</b> to @{handle} on X to lock in your
                team of 3 (or <b>decline wager</b>). your payment amount appears here after that.
              </div>
            ) : (
              <div className="empty small">your payment amount appears here once @{w.target?.handle} accepts</div>
            )
          ) : mine.paid ? (
            <div className="notice">
              {w.myAutoPay?.status === 'confirmed' ? 'paid from your allowance ✓' : 'your payment is in.'} the battle runs as soon as the other side pays.
            </div>
          ) : w.myAutoPay && (w.myAutoPay.status === 'pending' || w.myAutoPay.status === 'signed') ? (
            <div className="notice">being paid from your allowance… no need to pay by hand, this updates on its own.</div>
          ) : w.myAutoPay?.status === 'confirmed' ? (
            <div className="notice">paid from your allowance ✓</div>
          ) : mine.amount ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {w.myAutoPay ? (
                <div className="warn small">
                  your allowance could not pay{w.myAutoPay.error ? ` (${w.myAutoPay.error})` : ''}: pay by hand below
                </div>
              ) : linked ? (
                <div className="small muted">
                  set a <Link to="/wallet">wager allowance on /wallet</Link> to skip this step next time
                </div>
              ) : null}
            <PayBox
              kind="wager"
              id={w.id}
              amount={mine.amount}
              pool={pool}
              mint={mint}
              onCheck={async (tx) => {
                await post(`/api/me/wager/${w.id}/check`, tx ? { tx } : {})
                await onDone()
              }}
            />
            </div>
          ) : null}
        </div>
      </div>
    </Term>
  )
}

/** Where this wager's winnings and refunds go. */
export function PayoutNote({ w, linked }: { w: WagerView; linked: string | null }) {
  if (w.status === 'complete' || w.status === 'cancelled') return null
  if (w.myPayout) return <div className="notice small">winnings and refunds go to your linked wallet {short(w.myPayout)}</div>
  if (linked && w.status === 'pending_accept') return <div className="notice small">your linked wallet {short(linked)} will be used</div>
  return (
    <div className="warn small">
      no wallet linked: winnings go to the wallet you pay from. <Link to="/wallet">Link one at /wallet</Link> first if you might pay from an exchange.
    </div>
  )
}
