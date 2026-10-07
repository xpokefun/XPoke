import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { ApiError, get, post } from '../lib/api.ts'
import { useApp } from '../lib/hooks.ts'
import { ago, short } from '../lib/format.ts'
import { CopyText, ErrorLine, Loading, Term } from '../components/ui.tsx'
import { LoggedOut } from './Me.tsx'

type WalletMod = typeof import('../lib/wallet.ts')
type SolWallet = import('../lib/wallet.ts').SolWallet
type Balance = { token: string | null; sol: number | null; allowance?: string | null; allowanceWei?: string; tokenAccount?: boolean }

function Explainer() {
  return (
    <Term cmd="xpoke --wallet --help" right="what linking does">
      <ul className="small" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <li>Wager winnings and refunds go to your linked wallet, whichever wallet you pay from. Paying from an exchange is then safe.</li>
        <li>Linking is one free signature: no transaction, no fee, nothing moves.</li>
        <li>A wager pays the wallet that was linked when it was accepted. Changing or unlinking later never redirects a running wager.</li>
        <li>You can still pay from any wallet. On X, say "wallet" to see which one is linked.</li>
      </ul>
    </Term>
  )
}

function Connect({ label, onLinked }: { label: string; onLinked: (address: string) => void }) {
  const [mod, setMod] = useState<WalletMod | null>(null)
  const [list, setList] = useState<SolWallet[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!mod) return undefined
    setList(mod.signingWallets())
    return mod.onSolanaWallets(() => setList(mod.signingWallets()))
  }, [mod])

  async function toggle() {
    setError(null)
    if (!mod) {
      try {
        setMod(await import('../lib/wallet.ts'))
      } catch {
        setError('could not load wallet support, try reloading the page')
        return
      }
    }
    setOpen((o) => !o)
  }

  async function link(w: SolWallet) {
    if (!mod) return
    setBusy(true)
    setError(null)
    setOpen(false)
    try {
      const account = await mod.connect(w)
      const ch = await post<{ nonce: string; message: string }>('/api/me/wallet/challenge', { address: account.address })
      const signature = await mod.signText(w, account, ch.message)
      const r = await post<{ ok: boolean; address: string }>('/api/me/wallet/link', { nonce: ch.nonce, signature })
      onLinked(r.address)
    } catch (e) {
      if (e instanceof ApiError) setError(e.message)
      else {
        const m = (e as Error).message ?? String(e)
        setError(/reject|denied|cancel|declin/i.test(m) ? 'the signature request was rejected' : m)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={toggle}>
          {busy ? 'waiting for the wallet...' : label}
        </button>
      </div>
      {open ? (
        <div className="wallet-list">
          {list.length ? (
            list.map((w) => (
              <button key={w.name} className="btn" onClick={() => link(w)} style={{ justifyContent: 'flex-start' }}>
                {w.icon ? <img src={w.icon} alt="" /> : null}
                {w.name}
              </button>
            ))
          ) : (
            <div className="small muted">no Solana wallet that can sign messages was found in this browser. install Phantom, Solflare or Backpack, then reload</div>
          )}
        </div>
      ) : null}
      <ErrorLine error={error} />
    </div>
  )
}

const QUICK = ['1000', '5000', '25000']

/** Approve XPoke (the pool) as delegate on the linked wallet's $XPOKE account, up to an amount. */
function Allowance({ linked, balance, onChanged }: { linked: string; balance: Balance | null; onChanged: () => void }) {
  const [amount, setAmount] = useState('5000')
  const [busy, setBusy] = useState(false)
  const [mod, setMod] = useState<WalletMod | null>(null)
  const [list, setList] = useState<SolWallet[]>([])
  const [picking, setPicking] = useState<null | string>(null)
  const [confirmRevoke, setConfirmRevoke] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    if (!mod) return undefined
    setList(mod.solanaWallets())
    return mod.onSolanaWallets(() => setList(mod.solanaWallets()))
  }, [mod])

  const notLive = balance !== null && !balance.tokenAccount && balance.token === null
  const current = balance?.allowanceWei && balance.allowanceWei !== '0' ? balance.allowance : null

  async function start(value: string) {
    setError(null)
    setNotice(null)
    if (!/^\d+(\.\d{1,6})?$/.test(value)) {
      setError('enter a whole number of tokens (up to 6 decimals)')
      return
    }
    if (!mod) {
      try {
        setMod(await import('../lib/wallet.ts'))
      } catch {
        setError('could not load wallet support, try reloading the page')
        return
      }
    }
    setPicking(value)
  }

  async function sign(w: SolWallet, value: string) {
    if (!mod) return
    setBusy(true)
    setPicking(null)
    setError(null)
    try {
      const account = await mod.connect(w)
      if (account.address !== linked) {
        setError(`switch your wallet to ${short(linked)} (the linked wallet) and try again`)
        return
      }
      const built = await post<{ tx: string; amount: string }>('/api/me/wallet/allowance', { amount: value })
      await mod.signAndSend(w, account, built.tx)
      setNotice(value === '0' ? 'allowance revoked. it can take a few seconds to show here' : `allowance set to ${built.amount} $XPOKE. it can take a few seconds to show here`)
      setConfirmRevoke(false)
      setTimeout(onChanged, 4000)
      setTimeout(onChanged, 32000)
    } catch (e) {
      if (e instanceof ApiError) setError(e.message)
      else {
        const m = (e as Error).message ?? String(e)
        setError(/reject|denied|cancel|declin/i.test(m) ? 'the request was rejected in the wallet' : m)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <Term cmd="xpoke --allowance" right="wager allowance">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <ul className="small muted" style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <li>XPoke can take up to this amount from your linked wallet, only for wagers you make or accept on X, and only the exact stake.</li>
          <li>Your tokens stay in your wallet until a wager is accepted. Revoke anytime.</li>
          <li>Solana allows one approval per token account: approving another app replaces XPoke's, and you then just pay by hand.</li>
          <li>The key that uses the allowance lives on XPoke's server, so only approve what you're comfortable wagering.</li>
        </ul>
        {notLive ? (
          <div className="warn small">opens when $XPOKE is live</div>
        ) : (
          <>
            <div className="kv">
              <span>current allowance</span>
              <b>{!balance ? '...' : current ? `${current} $XPOKE` : 'not set'}</b>
            </div>
            <div className="row">
              <input
                className="input"
                style={{ width: 140 }}
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                aria-label="allowance amount"
              />
              {QUICK.map((q) => (
                <button key={q} className="btn sm" onClick={() => setAmount(q)}>
                  {Number(q).toLocaleString()}
                </button>
              ))}
            </div>
            <div className="row">
              <button className="btn primary" disabled={busy || !amount} onClick={() => start(amount)}>
                {busy ? 'waiting for the wallet...' : 'Approve'}
              </button>
              {current ? (
                confirmRevoke ? (
                  <>
                    <span className="small">revoke the allowance?</span>
                    <button className="btn sm primary" disabled={busy} onClick={() => start('0')}>
                      Yes, revoke
                    </button>
                    <button className="btn sm" onClick={() => setConfirmRevoke(false)}>
                      Keep it
                    </button>
                  </>
                ) : (
                  <button className="btn" disabled={busy} onClick={() => setConfirmRevoke(true)}>
                    Revoke
                  </button>
                )
              ) : null}
            </div>
            {picking !== null ? (
              <div className="wallet-list">
                {list.length ? (
                  list.map((w) => (
                    <button key={w.name} className="btn" onClick={() => sign(w, picking)} style={{ justifyContent: 'flex-start' }}>
                      {w.icon ? <img src={w.icon} alt="" /> : null}
                      {w.name}
                    </button>
                  ))
                ) : (
                  <div className="small muted">no Solana wallet found in this browser. install Phantom, Solflare or Backpack, then reload</div>
                )}
              </div>
            ) : null}
          </>
        )}
        {notice ? <div className="notice small">{notice}</div> : null}
        <ErrorLine error={error} />
      </div>
    </Term>
  )
}

export default function WalletPage() {
  const { me, reloadMe } = useApp()
  const [balance, setBalance] = useState<Balance | null>(null)
  const [balanceError, setBalanceError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [changing, setChanging] = useState(false)
  const linked = me?.trainer?.wallet ?? null

  const [balanceTick, setBalanceTick] = useState(0)
  useEffect(() => {
    if (!linked) {
      setBalance(null)
      return
    }
    setBalanceError(null)
    get<Balance>('/api/me/wallet/balance')
      .then(setBalance)
      .catch(() => setBalanceError('balances unavailable right now'))
  }, [linked?.address, balanceTick])

  if (!me) return <Loading />
  if (!me.user || !me.trainer) return <LoggedOut title="Wallet" />

  async function onLinked(address: string) {
    setChanging(false)
    setNotice(`linked ${short(address)}. wager winnings and refunds now go here`)
    await reloadMe()
  }

  return (
    <>
      <h1 className="page-title">Wallet</h1>
      <p className="page-sub">Link a Solana wallet to @{me.trainer.handle} so wager winnings and refunds always land in a wallet you control.</p>
      {notice ? <div className="notice" style={{ marginBottom: 12 }}>{notice}</div> : null}
      {error ? <div className="error" style={{ marginBottom: 12 }}>{error}</div> : null}
      <div className="card" style={{ marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
        {linked ? (
          <>
            <div className="small muted">linked wallet</div>
            <div className="amount" style={{ fontSize: 26 }}>
              <CopyText value={linked.address} />
            </div>
            <div className="row small muted">
              <span>linked {ago(linked.linkedAt)}</span>
              <a href={`https://solscan.io/account/${linked.address}`} target="_blank" rel="noreferrer">
                view on Solscan
              </a>
            </div>
            <div className="kv">
              <span>$XPOKE</span>
              <b>{balanceError ? '-' : !balance ? '...' : balance.token ?? 'token not live yet'}</b>
              <span>SOL</span>
              <b>{balanceError ? '-' : !balance ? '...' : balance.sol === null ? '-' : balance.sol.toLocaleString(undefined, { maximumFractionDigits: 4 })}</b>
            </div>
            {balanceError ? <div className="small faint">{balanceError}</div> : null}
            <div className="row">
              <button className="btn" onClick={() => setChanging((c) => !c)}>
                Change wallet
              </button>
              {confirming ? (
                <>
                  <span className="small">unlink {short(linked.address)}?</span>
                  <button
                    className="btn primary sm"
                    onClick={async () => {
                      setError(null)
                      try {
                        const r = await post<{ ok: boolean; note: string }>('/api/me/wallet/unlink')
                        setNotice(r.note)
                        setConfirming(false)
                        await reloadMe()
                      } catch (e) {
                        setError((e as Error).message)
                      }
                    }}
                  >
                    Yes, unlink
                  </button>
                  <button className="btn sm" onClick={() => setConfirming(false)}>
                    Keep it
                  </button>
                </>
              ) : (
                <button className="btn" onClick={() => setConfirming(true)}>
                  Unlink
                </button>
              )}
            </div>
            {changing ? <Connect label="Connect new wallet" onLinked={onLinked} /> : null}
          </>
        ) : (
          <>
            <div className="small muted">no wallet linked</div>
            <p style={{ margin: 0 }}>
              Without a linked wallet, wager winnings and refunds go back to the wallet you paid from. Link one with a single free signature.
            </p>
            <Connect label="Connect wallet" onLinked={onLinked} />
          </>
        )}
      </div>
      {linked ? <Allowance linked={linked.address} balance={balance} onChanged={() => setBalanceTick((n) => n + 1)} /> : null}
      <Explainer />
      <p className="small muted">
        Wagers are started on X. See <Link to="/docs#wallet">how the wallet works</Link>.
      </p>
    </>
  )
}
