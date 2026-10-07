import type { Stats as StatsT } from '../lib/api.ts'
import { useApi, useNow } from '../lib/hooks.ts'
import { ago, isDevTx, short } from '../lib/format.ts'
import { Addr, CopyText, ErrorLine, Loading, Term } from '../components/ui.tsx'

const KIND_BADGE: Record<string, string> = { payment: 'ink', payout: 'outline', refund: 'outline', burn: 'grey' }

export default function Stats() {
  const { data, error } = useApi<StatsT>('/api/stats', 30_000)
  const now = useNow(30_000)
  if (!data) return error ? <ErrorLine error={error} /> : <Loading />
  const ex = data.explorer
  const sym = data.symbol
  const tiles: [string, string | number][] = [
    ['paid in', data.totals.paidIn],
    ['paid out', data.totals.paidOut],
    ['refunded', data.totals.refunded],
    ['burned', data.totals.burned],
    ['queued', data.totals.queued],
  ]
  const counts: [string, number][] = [
    ['trainers', data.counts.trainers],
    ['pokémon', data.counts.pokemon],
    ['shinies', data.counts.shinies],
    ['battles', data.counts.battles],
    ['wagers settled', data.counts.wagers],
    ['commands', data.counts.commands],
  ]
  return (
    <>
      <h1 className="page-title">On-chain Stats</h1>
      <p className="page-sub">
        Wagers, the pokeball shop and every payout run through one pool wallet on Solana. Every payment, payout, refund and burn is listed
        here with its Solana signature.
      </p>
      <div className="grid two" style={{ marginBottom: 16 }}>
        <div className="card">
          <div className="kv">
            <span>${sym} mint</span>
            {data.token ? (
              <span className="row" style={{ gap: 6 }}>
                <CopyText value={data.token} display={short(data.token, 6)} />
                <a href={`${ex}/token/${data.token}`} target="_blank" rel="noreferrer" className="small">
                  explorer
                </a>
              </span>
            ) : (
              <span className="faint">announced soon</span>
            )}
            <span>pool wallet</span>
            {data.pool ? (
              <span className="row" style={{ gap: 6 }}>
                <CopyText value={data.pool} display={short(data.pool, 6)} />
                <a href={`${ex}/account/${data.pool}`} target="_blank" rel="noreferrer" className="small">
                  explorer
                </a>
              </span>
            ) : (
              <span className="faint">announced with the token</span>
            )}
            <span>pool balance</span>
            <b>{data.poolBalance ? `${data.poolBalance} $${sym}` : '-'}</b>
            <span>total supply</span>
            <b>{data.totalSupply ? `${data.totalSupply} $${sym}` : '-'}</b>
            <span>network</span>
            <span>Solana mainnet</span>
            <span>watcher</span>
            <span className="small">
              {data.chain.enabled ? (data.chain.lastScanAt ? `scanned ${ago(data.chain.lastScanAt, now)}` : 'starting') : 'off until the token is set'}
              {data.chain.lastError ? <span className="faint"> · last error: {data.chain.lastError}</span> : null}
            </span>
          </div>
        </div>
        <div className="card">
          <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))', gap: 10 }}>
            {tiles.map(([k, v]) => (
              <div key={k}>
                <div className="small muted">{k}</div>
                <div className="mono" style={{ fontSize: 22, color: 'var(--text)' }}>
                  {v}
                </div>
              </div>
            ))}
            {counts.map(([k, v]) => (
              <div key={k}>
                <div className="small muted">{k}</div>
                <div className="mono" style={{ fontSize: 22 }}>
                  {v.toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <Term cmd="xpoke --ledger" right={`${data.ledger.length} entries`} flush>
        {!data.ledger.length ? (
          <div className="empty">no payments yet</div>
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>kind</th>
                  <th>for</th>
                  <th>from</th>
                  <th>to</th>
                  <th className="num">amount</th>
                  <th>status</th>
                  <th>tx</th>
                  <th>when</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className={`badge ${KIND_BADGE[r.kind] ?? 'grey'}`}>{r.kind}</span>
                    </td>
                    <td className="small">{r.ref}</td>
                    <td>{r.kind === 'payment' ? <Addr addr={r.from} explorer={ex} /> : <span className="faint">pool</span>}</td>
                    <td>{r.kind === 'payment' ? <span className="faint">pool</span> : <Addr addr={r.to} explorer={ex} />}</td>
                    <td className="num mono">{r.amount}</td>
                    <td>
                      <span className={`badge ${r.status === 'confirmed' ? 'green' : r.status === 'failed' ? 'red' : r.status === 'held' ? 'yellow' : 'grey'}`} title={r.error ?? ''}>
                        {r.status}
                      </span>
                      {(r.status === 'held' || r.status === 'failed') && r.error ? <div className="small faint">{r.error}</div> : null}
                    </td>
                    <td>
                      {r.tx && !isDevTx(r.tx) ? (
                        <a href={`${ex}/tx/${r.tx}`} target="_blank" rel="noreferrer" className="mono">
                          {short(r.tx, 5)}
                        </a>
                      ) : r.tx ? (
                        <span className="faint small">dev</span>
                      ) : (
                        <span className="faint">-</span>
                      )}
                    </td>
                    <td className="small faint" style={{ whiteSpace: 'nowrap' }}>
                      {ago(r.at, now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Term>
    </>
  )
}
