import { useEffect, useState } from 'react'
import { post } from '../lib/api.ts'
import { useApp } from '../lib/hooks.ts'
import { CopyText } from './ui.tsx'

type WalletMod = typeof import('../lib/wallet.ts')
type SolWallet = import('../lib/wallet.ts').SolWallet

/**
 * The exact amount, where to send it, and the ways to pay: a Solana wallet (the server builds the
 * transfer, the wallet signs and sends it), a Solana Pay link, or send manually and paste the signature.
 */
export function PayBox({
  kind,
  id,
  amount,
  pool,
  mint,
  onCheck,
  checkLabel = 'Check Payment',
  note,
}: {
  kind: 'order' | 'wager'
  id: number
  amount: string
  pool: string | null
  mint: string | null
  onCheck: (sig?: string) => Promise<void>
  checkLabel?: string
  note?: string
}) {
  const { config } = useApp()
  const [mod, setMod] = useState<WalletMod | null>(null)
  const [list, setList] = useState<SolWallet[]>([])
  const [choosing, setChoosing] = useState(false)
  const [sig, setSig] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  useEffect(() => {
    if (!mod) return undefined
    setList(mod.solanaWallets())
    return mod.onSolanaWallets(() => setList(mod.solanaWallets()))
  }, [mod])

  const symbol = config?.token.symbol ?? 'XPOKE'
  const plain = amount.replace(/,/g, '')
  const payLink = pool && mint ? `solana:${pool}?amount=${plain}&spl-token=${mint}&label=XPoke` : null

  async function openChooser() {
    setError(null)
    if (!mod) {
      try {
        setMod(await import('../lib/wallet.ts'))
      } catch {
        setError('could not load wallet support. send manually below')
        return
      }
    }
    setChoosing((c) => !c)
  }

  async function pay(w: SolWallet) {
    if (!mod) return
    setBusy(true)
    setError(null)
    setMsg(null)
    setChoosing(false)
    try {
      const account = await mod.connect(w)
      const built = await post<{ tx: string; amount: string }>('/api/pay/build', { kind, id, payer: account.address })
      const signature = await mod.signAndSend(w, account, built.tx)
      setSig(signature)
      setMsg('sent. confirming on Solana...')
      // the transfer is on its way: the server also watches the pool by itself, so a check that comes back
      // "not confirmed yet" or "checked a moment ago" is not a failure, just a moment too early. One retry.
      for (const wait of [4000, 11000]) {
        await new Promise((r) => setTimeout(r, wait))
        try {
          await onCheck(signature)
          break
        } catch {
          /* still confirming, or rate-limited: try once more, then leave it to the watcher */
        }
      }
      setMsg('payment sent. it is credited automatically as soon as it confirms, no need to pay again')
    } catch (e) {
      const m = (e as Error).message ?? String(e)
      setError(/reject|denied|cancel/i.test(m) ? 'the wallet request was rejected' : m)
    } finally {
      setBusy(false)
    }
  }

  async function check() {
    setBusy(true)
    setError(null)
    try {
      await onCheck(sig.trim() || undefined)
      setMsg('checked')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="paybox">
      <div className="small muted">send exactly</div>
      <div className="row" style={{ gap: 8 }}>
        <span className="amount">{amount}</span>
        <span className="muted">${symbol}</span>
      </div>
      <CopyText value={plain} display="copy exact amount" />
      <div className="small warn-text">do not round it: the decimals identify your payment</div>
      <div className="warn small">Pay from a wallet you control (Phantom, Solflare, Backpack…), never from an exchange: payouts and refunds go back to the wallet that paid.</div>
      <div className="kv">
        <span>to wallet</span>
        {pool ? <CopyText value={pool} /> : <span className="faint">-</span>}
        <span>token mint</span>
        {mint ? <CopyText value={mint} /> : <span className="faint">-</span>}
        <span>network</span>
        <span>Solana, fee paid in SOL</span>
      </div>
      {note ? <div className="small muted">{note}</div> : null}
      <div className="row">
        <button className="btn primary" disabled={busy || !mint || !pool} onClick={openChooser}>
          Pay with wallet
        </button>
        {payLink ? (
          <a className="btn" href={payLink}>
            Open in wallet
          </a>
        ) : null}
      </div>
      {choosing ? (
        <div className="wallet-list">
          {list.length ? (
            list.map((w) => (
              <button key={w.name} className="btn" onClick={() => pay(w)} style={{ justifyContent: 'flex-start' }}>
                {w.icon ? <img src={w.icon} alt="" /> : null}
                {w.name}
              </button>
            ))
          ) : (
            <div className="small muted">
              no Solana wallet found in this browser. install Phantom or Solflare, or send the exact amount manually and paste the signature below
            </div>
          )}
        </div>
      ) : null}
      <div className="row" style={{ flexWrap: 'nowrap' }}>
        <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="transaction signature (optional)" value={sig} onChange={(e) => setSig(e.target.value)} />
        <button className="btn" disabled={busy} onClick={check}>
          {checkLabel}
        </button>
      </div>
      {msg ? <div className="notice">{msg}</div> : null}
      {error ? <div className="error">{error}</div> : null}
    </div>
  )
}
