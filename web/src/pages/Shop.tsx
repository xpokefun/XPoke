import { useState } from 'react'
import { Link } from 'react-router-dom'
import { post } from '../lib/api.ts'
import { useApi, useApp, useNow } from '../lib/hooks.ts'
import { duration } from '../lib/format.ts'
import { ErrorLine, Loading } from '../components/ui.tsx'
import { PayBox } from '../components/PayBox.tsx'

type ShopInfo = {
  balls: { key: string; label: string; catchRate: number; shinyRate: number; price: number }[]
  token: string | null
  symbol: string
  pool: string | null
  enabled: boolean
}
type Order = { id: number; ball: string; qty: number; amount: string; amountWei: string; pool: string; poolTokenAccount: string | null; mint: string; expiresAt: number }

const BALL_ART: Record<string, [string, string]> = {
  poke: ['#e3350d', '#f2f2f2'],
  ultra: ['#2b2b2b', '#ffcb05'],
  master: ['#7b3fbf', '#f2f2f2'],
}

function BallIcon({ kind }: { kind: string }) {
  const [top] = BALL_ART[kind] ?? BALL_ART.poke!
  return (
    <svg width="56" height="56" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14" fill={top} stroke="#000" strokeWidth="2" />
      {kind === 'ultra' ? <path d="M6 9 L12 13 M26 9 L20 13" stroke="#ffcb05" strokeWidth="3" /> : null}
      {kind === 'master' ? <text x="16" y="12" fontSize="7" textAnchor="middle" fill="#fff" fontFamily="monospace" fontWeight="bold">M</text> : null}
      <path d="M2 16h28a14 14 0 0 1-28 0z" fill="#f2f2f2" stroke="#000" strokeWidth="2" />
      <line x1="2" y1="16" x2="30" y2="16" stroke="#000" strokeWidth="3" />
      <circle cx="16" cy="16" r="4.5" fill="#f2f2f2" stroke="#000" strokeWidth="2.5" />
    </svg>
  )
}

export default function Shop() {
  const { me } = useApp()
  const { data, error } = useApi<ShopInfo>('/api/shop')
  const [qty, setQty] = useState<Record<string, number>>({ ultra: 1, master: 1 })
  const [order, setOrder] = useState<Order | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const now = useNow(1000)
  const loggedIn = Boolean(me?.user)

  if (!data) return error ? <ErrorLine error={error} /> : <Loading />
  const sym = data.symbol

  return (
    <>
      <h1 className="page-title">Pokeball Shop</h1>
      <p className="page-sub">
        Better balls catch more often and find more shinies. Everyone gets 5 free pokeballs every day at midnight UTC; bought balls stack on top.
        Pay in ${sym} on Solana. Every ${sym} spent on balls is burned: it leaves circulation for good. Pay from a wallet you control (Phantom, Solflare, Backpack…), never from an exchange: payouts and refunds go back to the wallet that paid.
      </p>
      {!data.enabled ? (
        <div className="warn" style={{ marginBottom: 16 }}>
          The shop opens when ${sym} is live. Prices and odds below are final.
        </div>
      ) : null}
      <div className="grid three" style={{ marginBottom: 20 }}>
        {data.balls.map((b) => (
          <div key={b.key} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div className="row">
              <span className="ball-art">
                <BallIcon kind={b.key} />
              </span>
              <div>
                <div style={{ fontFamily: 'var(--pixel)', fontSize: 12, textTransform: 'capitalize' }}>{b.label}</div>
                <div className="muted small">{b.price ? `${b.price.toLocaleString()} $${sym} each` : 'free · 5 per day'}</div>
              </div>
            </div>
            <div className="kv">
              <span>catch rate</span>
              <b>{Math.round(b.catchRate * 100)}%</b>
              <span>shiny rate</span>
              <b>{Math.round(b.shinyRate * 100)}%</b>
            </div>
            {b.key === 'master' ? <div className="small muted">Pity: after 10 failed throws in a row, the next master ball can't miss.</div> : null}
            {b.key === 'ultra' ? <div className="small muted">Best value for shiny hunters: 4x the shiny odds of a pokeball.</div> : null}
            {b.key === 'poke' ? <div className="small muted">Reset to 5 every day at midnight UTC. Just reply "catch".</div> : null}
            {b.price ? (
              <div className="row" style={{ marginTop: 'auto' }}>
                <button className="btn sm" onClick={() => setQty((q) => ({ ...q, [b.key]: Math.max(1, (q[b.key] ?? 1) - 1) }))}>
                  -
                </button>
                <input
                  className="input"
                  style={{ width: 64, textAlign: 'center' }}
                  value={qty[b.key] ?? 1}
                  onChange={(e) => setQty((q) => ({ ...q, [b.key]: Math.max(1, Math.min(100, Number(e.target.value.replace(/\D/g, '')) || 1)) }))}
                />
                <button className="btn sm" onClick={() => setQty((q) => ({ ...q, [b.key]: Math.min(100, (q[b.key] ?? 1) + 1) }))}>
                  +
                </button>
                <span className="spacer" />
                <button
                  className="btn primary sm"
                  disabled={!data.enabled || !loggedIn}
                  title={!loggedIn ? 'log in first' : ''}
                  onClick={async () => {
                    setErr(null)
                    setStatus(null)
                    try {
                      setOrder(await post<Order>('/api/shop/order', { ball: b.key, qty: qty[b.key] ?? 1 }))
                    } catch (e) {
                      setErr((e as Error).message)
                    }
                  }}
                >
                  Get payment amount
                </button>
              </div>
            ) : null}
            {b.price ? (
              <div className="small faint">
                total {((qty[b.key] ?? 1) * b.price).toLocaleString()} ${sym}
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {!loggedIn ? (
        <div className="small muted" style={{ marginBottom: 12 }}>
          <Link to="/me">Log in with X</Link> to buy balls for your account.
        </div>
      ) : null}
      <ErrorLine error={err} />
      {order ? (
        <div className="card" style={{ maxWidth: 640 }}>
          <div className="row" style={{ marginBottom: 10 }}>
            <b>
              Order #{order.id}: {order.qty} {order.ball} ball{order.qty === 1 ? '' : 's'}
            </b>
            <span className="spacer" />
            <span className="badge yellow">{order.expiresAt > now ? `${duration(order.expiresAt - now)} to pay` : 'window passed'}</span>
          </div>
          {status === 'paid' ? (
            <div className="notice">
              paid! {order.qty} {order.ball} ball{order.qty === 1 ? ' is' : 's are'} in your bag. say "catch {order.ball} ball" on X.
            </div>
          ) : (
            <PayBox
              kind="order"
              id={order.id}
              amount={order.amount}
              pool={order.pool}
              mint={order.mint}
              checkLabel="I've paid / confirm"
              note="balls are added automatically as soon as the transfer lands"
              onCheck={async (tx) => {
                const r = await post<{ status: string }>(`/api/shop/order/${order.id}/check`, tx ? { tx } : {})
                setStatus(r.status)
                if (r.status !== 'paid') throw new Error('not seen yet. it can take a few seconds after the transfer confirms, try again shortly')
              }}
            />
          )}
        </div>
      ) : null}
    </>
  )
}
