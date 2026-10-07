import { useState } from 'react'
import { post } from '../lib/api.ts'
import { useApp } from '../lib/hooks.ts'
import { Term } from '../components/ui.tsx'

const QUICK = ['catch', 'catch ultra ball', 'check', 'feed berries', 'battle', 'evolve', 'walk', 'accept', 'accept wager', 'decline', 'wallet', 'cancel', 'help', 'tournament join', 'whats the best fire type?']

type Line = { handle: string; text: string; reply: string; status: string }

export default function Dev() {
  const { config } = useApp()
  const [handle, setHandle] = useState('alice')
  const [text, setText] = useState('')
  const [log, setLog] = useState<Line[]>([])
  const [busy, setBusy] = useState(false)
  if (!config?.devLogin) return <div className="empty">not available</div>

  async function send(t: string) {
    if (!t.trim()) return
    setBusy(true)
    try {
      const r = await post<{ reply: string; status: string }>('/api/dev/mention', { handle, text: t })
      setLog((l) => [{ handle, text: t, reply: r.reply, status: r.status }, ...l].slice(0, 100))
    } catch (e) {
      setLog((l) => [{ handle, text: t, reply: (e as Error).message, status: 'error' }, ...l])
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h1 className="page-title">Dev console</h1>
      <p className="page-sub">Sends a mention to the agent as any handle, exactly as if it was posted on X (dev mode only).</p>
      <form
        className="filters"
        onSubmit={(e) => {
          e.preventDefault()
          void send(text)
          setText('')
        }}
      >
        <input className="input" style={{ flex: '0 1 160px' }} value={handle} onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} placeholder="handle" />
        <input className="input" value={text} onChange={(e) => setText(e.target.value)} placeholder={`@${config.handle} ...`} />
        <button className="btn primary" disabled={busy}>
          send
        </button>
      </form>
      <div className="row" style={{ marginBottom: 16 }}>
        {QUICK.map((q) => (
          <button key={q} className="btn sm" disabled={busy} onClick={() => send(q)}>
            {q}
          </button>
        ))}
      </div>
      <Term cmd="xpoke --dev" flush>
        {!log.length ? <div className="empty">nothing sent yet</div> : null}
        {log.map((l, i) => (
          <div className="feed-item" key={i}>
            <span className="handle">@{l.handle}</span>
            <div className="body">
              <div className="row" style={{ gap: 6 }}>
                <span className={`badge ${l.status === 'replied' || l.status === 'queued' ? 'green' : l.status === 'error' ? 'red' : 'grey'}`}>{l.status}</span>
                <span className="said">{l.text}</span>
              </div>
              {l.reply ? <div className="reply">{l.reply}</div> : null}
            </div>
          </div>
        ))}
      </Term>
    </>
  )
}
