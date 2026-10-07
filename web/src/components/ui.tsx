import { useState, type ImgHTMLAttributes, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import type { Mon } from '../lib/api.ts'
import { copy } from '../lib/hooks.ts'
import { duration, short, spriteUrl, TYPE_COLORS } from '../lib/format.ts'

export function Term({ cmd, right, children, flush, scroll }: { cmd: string; right?: ReactNode; children: ReactNode; flush?: boolean; scroll?: boolean }) {
  return (
    <section className="term">
      <div className="term-head">
        <span className="dots">
          <i />
          <i />
          <i />
        </span>
        <span className="prompt">{cmd}</span>
        {right ? <span className="right">{right}</span> : null}
      </div>
      <div className={`term-body${flush ? ' flush' : ''}${scroll ? ' scroll' : ''}`}>{children}</div>
    </section>
  )
}

/** Dark type colours get light text, light ones dark text, so every chip reads on cream. */
function chipText(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? '#111' : '#fcfcfa'
}

export function TypeChip({ type }: { type: string }) {
  const bg = TYPE_COLORS[type] ?? '#b9b8b6'
  return (
    <span className="chip" style={{ background: bg, color: chipText(bg) }}>
      {type}
    </span>
  )
}

export function Types({ types }: { types: string[] }) {
  return (
    <span className="chips">
      {types.map((t) => (
        <TypeChip key={t} type={t} />
      ))}
    </span>
  )
}

export function Avatar({ src, handle, lg }: { src: string | null | undefined; handle: string; lg?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) return <span className={`avatar${lg ? ' lg' : ''}`}>{handle.slice(0, 1).toUpperCase()}</span>
  return <img className={`avatar${lg ? ' lg' : ''}`} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
}

export function Handle({ handle, avatar }: { handle: string | null | undefined; avatar?: string | null }) {
  if (!handle) return <span className="muted">?</span>
  return (
    <Link to={`/trainer/${handle}`} className="row" style={{ gap: 8, display: 'inline-flex', flexWrap: 'nowrap', minWidth: 0 }}>
      {avatar !== undefined ? <Avatar src={avatar} handle={handle} /> : null}
      <span className="handle">@{handle}</span>
    </Link>
  )
}

/**
 * An <img> that retries by itself. A browser never re-requests a broken image, so one failed request
 * (the server restarting during a deploy, a network blip) would leave a broken icon until a full reload.
 * Two retries, after 1 s and 3 s, each with a fresh URL so no cached failure is reused.
 */
export function RetryImg(props: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const [attempt, setAttempt] = useState(0)
  const [forSrc, setForSrc] = useState(props.src)
  if (forSrc !== props.src) {
    // a different image (an evolution, another bracket slot): fresh retries for it
    setForSrc(props.src)
    setAttempt(0)
  }
  const src = attempt ? `${props.src}${props.src.includes('?') ? '&' : '?'}retry=${attempt}` : props.src
  return (
    <img
      {...props}
      src={src}
      onError={() => {
        if (attempt < 2) setTimeout(() => setAttempt((a) => a + 1), attempt ? 3000 : 1000)
      }}
    />
  )
}

export function Sprite({ id, shiny, size = 72, alt = '' }: { id: number; shiny?: boolean; size?: number; alt?: string }) {
  return (
    <RetryImg
      className="sprite"
      src={spriteUrl(id, shiny)}
      width={size}
      height={size}
      alt={alt}
      loading="lazy"
      style={{ imageRendering: 'pixelated' }}
    />
  )
}

export function CopyPill({ value, label, display }: { value: string; label?: string; display?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className="pill"
      title="copy"
      onClick={async () => {
        if (await copy(value)) {
          setDone(true)
          setTimeout(() => setDone(false), 1400)
        }
      }}
    >
      {label ? <span className="tag">{label}</span> : null}
      <span>{display ?? value}</span>
      <span className="tag">{done ? 'copied' : 'copy'}</span>
    </button>
  )
}

export function CopyText({ value, display }: { value: string; display?: string }) {
  const [done, setDone] = useState(false)
  return (
    <span className="row" style={{ gap: 6, flexWrap: 'nowrap', minWidth: 0 }}>
      <span className="mono break" style={{ minWidth: 0 }}>
        {display ?? value}
      </span>
      <button
        className="btn sm"
        onClick={async () => {
          if (await copy(value)) {
            setDone(true)
            setTimeout(() => setDone(false), 1400)
          }
        }}
      >
        {done ? 'copied' : 'copy'}
      </button>
    </span>
  )
}

export function Addr({ addr, explorer }: { addr: string | null | undefined; explorer?: string }) {
  if (!addr) return <span className="faint">-</span>
  if (addr === 'burn') return <span className="badge red">burn</span>
  return explorer ? (
    <a href={`${explorer}/account/${addr}`} target="_blank" rel="noreferrer" className="mono">
      {short(addr)}
    </a>
  ) : (
    <span className="mono">{short(addr)}</span>
  )
}

export function XpBar({ xp, max }: { xp: number; max: number }) {
  return (
    <div className="xpbar" title={`${xp}/${max} xp`}>
      <i style={{ width: `${Math.min(100, (100 * xp) / max)}%` }} />
    </div>
  )
}

/** Live timers are computed against `now` so cards count down without refetching. */
export function MonCard({ mon, now, loadedAt, actions }: { mon: Mon; now: number; loadedAt: number; actions?: ReactNode }) {
  const elapsed = now - loadedAt
  const battle = Math.max(0, mon.battleReadyIn - elapsed)
  const feed = Math.max(0, mon.nextFeedIn - elapsed)
  const activity = Math.max(0, mon.activityReadyIn - elapsed)
  const hunger = feed > 0 ? 'Full' : mon.hunger === 'Full' ? 'Hungry' : mon.hunger
  return (
    <div className={`mon${mon.shiny ? ' shiny' : ''}`}>
      {mon.lock ? <div className="lockbar">locked · pending {mon.lock === 'pvp' ? 'challenge' : mon.lock === 'trade' ? 'trade' : 'wager'}</div> : null}
      <div className="mon-top">
        <div className={`mon-sprite${mon.shiny ? ' shiny' : ''}`}>
          <RetryImg src={spriteUrl(mon.sprite, mon.shiny)} alt={mon.name} loading="lazy" />
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="row" style={{ gap: 6 }}>
            <span className="mon-name">{mon.name}</span>
            {mon.shiny ? <span className="badge purple">shiny</span> : null}
          </div>
          <div className="row small" style={{ gap: 6 }}>
            <b>Lv.{mon.level}</b>
            <span className={`rarity-${mon.rarity}`}>{mon.rarity}</span>
          </div>
          <Types types={mon.types} />
        </div>
      </div>
      <XpBar xp={mon.xp} max={mon.xpNext} />
      {mon.readyToEvolve && mon.evolvesTo ? (
        <span className="badge green">Ready to Evolve → {mon.evolvesTo.name}</span>
      ) : mon.evolvesTo?.level ? (
        <span className="small faint">evolves into {mon.evolvesTo.name} at Lv.{mon.evolvesTo.level}</span>
      ) : null}
      <div className="mon-meta">
        <span>
          status <b>{hunger}</b>
        </span>
        <span>
          stage <b>{mon.growth}</b>
        </span>
        <span>
          feeds <b>{mon.feeds}</b>
        </span>
        <span>
          record <b>
            {mon.wins}W {mon.losses}L
          </b>
        </span>
        <span>
          battle <b>{battle ? duration(battle) : 'ready'}</b>
        </span>
        <span>
          feed <b>{feed ? `in ${duration(feed)}` : 'now'}</b>
        </span>
        <span>
          walk <b>{activity ? duration(activity) : 'ready'}</b>
        </span>
        <span>
          ivs{' '}
          <b title="hp/atk/def/spe">
            {mon.ivs.hp}/{mon.ivs.atk}/{mon.ivs.def}/{mon.ivs.spe}
          </b>
        </span>
      </div>
      {mon.lastActivity ? <div className="small muted">{mon.lastActivity}</div> : null}
      {actions ? <div className="mon-actions">{actions}</div> : null}
    </div>
  )
}

export function MonMini({ name, sprite, level, shiny }: { name: string; sprite: number; level: number; shiny?: boolean }) {
  return (
    <span className={`mon-mini${shiny ? ' shiny' : ''}`} title={`${name} Lv.${level}`}>
      <RetryImg src={spriteUrl(sprite, shiny)} alt={name} loading="lazy" />
      <span>
        {name} <span className="faint">Lv.{level}</span>
      </span>
    </span>
  )
}

export function Loading() {
  return <div className="empty">loading...</div>
}

export function ErrorLine({ error }: { error: string | null }) {
  return error ? <div className="error">{error}</div> : null
}

export function StatusTag({ status }: { status: 'Replied' | 'Replying' | 'Command' | 'Failed' }) {
  return <span className={`badge ${status === 'Replied' || status === 'Replying' ? 'green' : status === 'Failed' ? 'red' : 'grey'}`}>{status}</span>
}

/** The XPoke logo: 12x12 pixel art, so it is only ever drawn at multiples of 12px. */
export function Logo({ size = 24 }: { size?: 12 | 24 | 36 | 48 | 96 | 120 }) {
  return <img className="logo-img" src="/logo.png" width={size} height={size} alt="" aria-hidden="true" />
}
