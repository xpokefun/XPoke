import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import type { TrainerPublic } from '../lib/api.ts'
import { useApi, useNow } from '../lib/hooks.ts'
import { ErrorLine, Loading, MonCard } from '../components/ui.tsx'
import { Medals, TrainerHeader } from './Me.tsx'

export default function TrainerPage() {
  const { handle = '' } = useParams()
  const { data, error } = useApi<TrainerPublic>(`/api/trainer/${encodeURIComponent(handle)}`, 30_000)
  const now = useNow(1000)
  const [loadedAt, setLoadedAt] = useState(Date.now())
  useEffect(() => {
    setLoadedAt(Date.now())
  }, [data])
  if (!data) return error ? <ErrorLine error={error === 'no such trainer' ? `@${handle} hasn't caught a Pokémon yet` : error} /> : <Loading />
  const col = (title: string, list: TrainerPublic['party']) => (
    <div>
      <h3>
        {title} <span className="faint">({list.length})</span>
      </h3>
      <div className="stack">
        {list.length ? list.map((m) => <MonCard key={m.id} mon={m} now={now} loadedAt={loadedAt} />) : <div className="card empty small">empty</div>}
      </div>
    </div>
  )
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <TrainerHeader
          t={data}
          extra={
            <span className="row">
              <a className="btn sm" href={`https://x.com/${data.handle}`} target="_blank" rel="noreferrer">
                on X
              </a>
              <Link className="btn sm" to={`/agent?handle=${data.handle}`}>
                commands
              </Link>
            </span>
          }
        />
        <div style={{ marginTop: 14 }}>
          <div className="small muted" style={{ marginBottom: 6 }}>
            gym medals ({data.medals.length}/13)
          </div>
          <Medals t={data} />
        </div>
      </div>
      <div className="columns">
        {col('Party', data.party)}
        {col('Box 1', data.box1)}
        {col('Box 2', data.box2)}
      </div>
    </>
  )
}
