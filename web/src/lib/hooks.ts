import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { get, type Config, type Me } from './api.ts'

/** Loads a GET endpoint, optionally refreshing it. */
export function useApi<T>(path: string | null, refreshMs = 0) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(Boolean(path))
  const pathRef = useRef(path)
  pathRef.current = path

  const seq = useRef(0)
  const load = useCallback(async () => {
    if (!pathRef.current) return
    const mine = ++seq.current
    const asked = pathRef.current
    try {
      const d = await get<T>(asked)
      // only the newest request for the current path may land
      if (mine !== seq.current || asked !== pathRef.current) return
      setData(d)
      setError(null)
    } catch (e) {
      if (mine === seq.current) setError((e as Error).message)
    } finally {
      if (mine === seq.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(Boolean(path))
    void load()
    if (!refreshMs || !path) return undefined
    const t = setInterval(() => {
      void load()
    }, refreshMs)
    return () => {
      clearInterval(t)
    }
  }, [path, refreshMs, load])

  return { data, error, loading, reload: load }
}

/** A clock that ticks, for countdowns and "3m ago". */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now())
    }, ms)
    return () => {
      clearInterval(t)
    }
  }, [ms])
  return now
}

export type AppState = {
  config: Config | null
  me: Me | null
  reloadMe: () => Promise<void>
}

export const AppContext = createContext<AppState>({ config: null, me: null, reloadMe: async () => {} })

export function useApp(): AppState {
  return useContext(AppContext)
}

export async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
