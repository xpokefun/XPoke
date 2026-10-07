import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import { get, post, type Config, type Me } from './lib/api.ts'
import { short } from './lib/format.ts'
import { AppContext, useApp } from './lib/hooks.ts'
import { Avatar, Logo } from './components/ui.tsx'
import Home from './pages/Home.tsx'
import Docs from './pages/Docs.tsx'
import Pokedex from './pages/Pokedex.tsx'
import MePage from './pages/Me.tsx'
import Shop from './pages/Shop.tsx'
import Tournament from './pages/Tournament.tsx'
import Agent from './pages/Agent.tsx'
import Stats from './pages/Stats.tsx'
import TrainerPage from './pages/Trainer.tsx'
import Dev from './pages/Dev.tsx'
import WalletPage from './pages/Wallet.tsx'

function Header({ config, me }: { config: Config | null; me: Me | null }) {
  const [open, setOpen] = useState(false)
  const loc = useLocation()
  useEffect(() => {
    setOpen(false)
  }, [loc.pathname])
  const user = me?.user
  const wallet = me?.trainer?.wallet ?? null
  return (
    <header className="header">
      <div className="wrap">
        <Link to="/" className="logo">
          <Logo size={24} />
          <span>XPoke</span>
        </Link>
        <button className="menu-btn" aria-label="menu" onClick={() => setOpen((o) => !o)}>
          {open ? 'close' : 'menu'}
        </button>
        <nav className={`nav${open ? ' open' : ''}`}>
          <NavLink to="/docs">Docs</NavLink>
          <NavLink to="/pokedex">Pokédex</NavLink>
          <NavLink to="/shop">Shop</NavLink>
          <NavLink to="/tournament">Tournament</NavLink>
          <NavLink to="/agent">Agent</NavLink>
          <NavLink to="/stats">Stats</NavLink>
          {config ? (
            <a href={`https://x.com/${config.handle}`} target="_blank" rel="noreferrer">
              X
            </a>
          ) : null}
          {config?.devLogin ? <NavLink to="/dev">Dev</NavLink> : null}
          {user ? (
            <>
              <AccountMenu me={me!} />
              <div className="mobile-account">
                <NavLink to="/me">My profile</NavLink>
                <NavLink to="/wallet">
                  Wallet <span className="faint small">{wallet ? short(wallet.address) : 'not linked'}</span>
                </NavLink>
                <SignOut className="nav-signout" />
              </div>
            </>
          ) : config?.loginWithX ? (
            <a className="login" href="/auth/x/login">
              Login with X
            </a>
          ) : (
            <NavLink to="/me" className="login">
              Login with X
            </NavLink>
          )}
        </nav>
      </div>
    </header>
  )
}

function SignOut({ className, onDone, role }: { className?: string; onDone?: () => void; role?: string }) {
  const { reloadMe } = useApp()
  const navigate = useNavigate()
  return (
    <button
      className={className}
      role={role}
      onClick={async () => {
        try {
          await post('/auth/logout')
        } finally {
          onDone?.()
          await reloadMe()
          navigate('/')
        }
      }}
    >
      Sign out
    </button>
  )
}

/** The signed-in trainer's menu: profile, wallet, sign out. */
function AccountMenu({ me }: { me: Me }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  const btn = useRef<HTMLButtonElement>(null)
  const loc = useLocation()
  const user = me.user!
  const wallet = me.trainer?.wallet ?? null

  useEffect(() => {
    setOpen(false)
  }, [loc.pathname])

  useEffect(() => {
    if (!open) return undefined
    box.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false)
        btn.current?.focus()
        return
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      const items = [...(box.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
      const i = items.indexOf(document.activeElement as HTMLElement)
      const next = items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]
      next?.focus()
      e.preventDefault()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="account" ref={box}>
      <button ref={btn} className="me account-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Avatar src={user.avatar} handle={user.handle} />@{user.handle}
        <span aria-hidden="true" className="caret">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open ? (
        <div className="menu" role="menu" aria-label="account">
          <Link role="menuitem" to="/me">
            My profile
          </Link>
          <Link role="menuitem" to="/wallet">
            <span>Wallet</span>
            <span className={wallet ? 'mono small' : 'small faint'}>{wallet ? short(wallet.address) : 'not linked'}</span>
          </Link>
          <div className="menu-divider" role="separator" />
          <SignOut role="menuitem" onDone={() => setOpen(false)} />
        </div>
      ) : null}
    </div>
  )
}

function Footer({ config }: { config: Config | null }) {
  return (
    <footer className="footer">
      <div className="wrap">
        <span className="logo" style={{ fontSize: 11 }}>
          <Logo size={24} /> XPoke
        </span>
        <span>catch, train and battle on X</span>
        <span className="spacer" />
        {config ? (
          <a href={`https://x.com/${config.handle}`} target="_blank" rel="noreferrer">
            @{config.handle}
          </a>
        ) : null}
        <Link to="/docs">docs</Link>
        <Link to="/stats">on-chain stats</Link>
        <a href="https://github.com/xpokefun/XPoke" target="_blank" rel="noreferrer">
          open source
        </a>
      </div>
    </footer>
  )
}

export default function App() {
  const [config, setConfig] = useState<Config | null>(null)
  const [me, setMe] = useState<Me | null>(null)

  const reloadMe = useCallback(async () => {
    try {
      setMe(await get<Me>('/api/me'))
    } catch {
      setMe({ user: null })
    }
  }, [])

  useEffect(() => {
    get<Config>('/api/config')
      .then(setConfig)
      .catch(() => {})
    void reloadMe()
  }, [reloadMe])

  return (
    <AppContext.Provider value={{ config, me, reloadMe }}>
      <Header config={config} me={me} />
      <main>
        <div className="wrap">
          <Routes>
            <Route path="/" element={<Home />} />
            <Route path="/docs" element={<Docs />} />
            <Route path="/pokedex" element={<Pokedex />} />
            <Route path="/me" element={<MePage />} />
            <Route path="/shop" element={<Shop />} />
            <Route path="/tournament" element={<Tournament />} />
            <Route path="/agent" element={<Agent />} />
            <Route path="/stats" element={<Stats />} />
            <Route path="/trainer/:handle" element={<TrainerPage />} />
            <Route path="/dev" element={<Dev />} />
            <Route path="/wallet" element={<WalletPage />} />
            <Route path="*" element={<div className="empty">that page does not exist. <Link to="/">go home</Link></div>} />
          </Routes>
        </div>
      </main>
      <Footer config={config} />
    </AppContext.Provider>
  )
}
