import { useSearchParams } from 'react-router-dom'
import type { Activity } from '../lib/api.ts'
import { useApi, useNow } from '../lib/hooks.ts'
import { ago } from '../lib/format.ts'
import { ErrorLine, Handle, Loading, StatusTag, Term } from '../components/ui.tsx'

export default function Agent() {
  const [params, setParams] = useSearchParams()
  const handle = params.get('handle') ?? ''
  const { data, error } = useApi<{ items: Activity[] }>(`/api/agent/activity?limit=200${handle ? `&handle=${encodeURIComponent(handle)}` : ''}`, 15_000)
  const now = useNow(15_000)
  return (
    <>
      <h1 className="page-title">Agent Log</h1>
      <p className="page-sub">
        Every command the agent processed. <span className="badge green">Replied</span> means it answered on X;{' '}
        <span className="badge grey">Command</span> means it ran silently because that trainer was over 3 public replies in the hour. Your game
        updated either way.
      </p>
      <div className="filters">
        <input
          className="input"
          placeholder="filter by @handle"
          defaultValue={handle}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              const v = (e.target as HTMLInputElement).value.replace(/^@/, '').trim()
              setParams(v ? { handle: v } : {})
            }
          }}
        />
        {handle ? (
          <button className="btn" onClick={() => setParams({})}>
            clear
          </button>
        ) : null}
      </div>
      <ErrorLine error={error} />
      <Term cmd={`xpoke --agent-log${handle ? ` --trainer ${handle}` : ''}`} right={data ? `${data.items.length} commands` : ''} flush>
        {!data ? <Loading /> : !data.items.length ? <div className="empty">nothing here yet</div> : null}
        {data?.items.map((m) => (
          <div className="feed-item" key={m.id}>
            <Handle handle={m.handle} avatar={m.avatar} />
            <div className="body">
              <div className="row" style={{ gap: 6 }}>
                <StatusTag status={m.status} />
                {m.command ? <span className="mono small">{m.command}</span> : null}
                <span className="spacer" />
                {m.url ? (
                  <a className="small" href={m.url} target="_blank" rel="noreferrer">
                    {ago(m.at, now)}
                  </a>
                ) : (
                  <span className="small faint">{ago(m.at, now)}</span>
                )}
              </div>
              <div className="said">{m.text}</div>
              {m.reply ? <div className="reply">{m.reply}</div> : null}
            </div>
          </div>
        ))}
      </Term>
    </>
  )
}
