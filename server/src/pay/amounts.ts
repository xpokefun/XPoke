/**
 * Unique payment amounts.
 *
 * Each payment gets a fractional tail (e.g. 1000.000243) so the transfer that lands in the pool
 * wallet says which order or wager side it belongs to. The tail is 1–999 millionths, unique among
 * every amount handed out in the last week, so a late payment still matches.
 */
import type { DB } from '../db.ts'
import { now } from '../db.ts'

/** SPL tokens from pump.fun and most launchpads have 6 decimals. */
export const TOKEN_DECIMALS = Number(process.env.TOKEN_DECIMALS ?? 6)
if (TOKEN_DECIMALS < 6) throw new Error('TOKEN_DECIMALS must be at least 6 for 6-decimal payment tails')
const TAIL_UNIT = 10n ** BigInt(TOKEN_DECIMALS - 6)
const DAY = 24 * 3600_000

/** Whole tokens → base units (exact for decimal strings, no float rounding). */
export function toWei(tokens: number | string): bigint {
  const s = typeof tokens === 'number' ? tokens.toFixed(TOKEN_DECIMALS) : tokens.trim()
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`not an amount: ${s}`)
  const [i, f = ''] = s.split('.')
  return BigInt(i!) * 10n ** BigInt(TOKEN_DECIMALS) + BigInt((f + '0'.repeat(TOKEN_DECIMALS)).slice(0, TOKEN_DECIMALS) || '0')
}

/** Base units → whole tokens as a plain decimal string. */
export function fromWei(wei: bigint | string): string {
  const v = BigInt(wei)
  const base = 10n ** BigInt(TOKEN_DECIMALS)
  const f = (v % base).toString().padStart(TOKEN_DECIMALS, '0').replace(/0+$/, '')
  return f ? `${v / base}.${f}` : `${v / base}`
}

/** "1000.000243" — always 6 decimals for a tailed amount so nobody rounds it away. */
export function showAmount(wei: bigint | string): string {
  const s = fromWei(wei)
  const [i, f = ''] = s.split('.')
  if (!f || /^0*$/.test(f)) return Number(i).toLocaleString('en-US')
  return `${i}.${f.padEnd(6, '0')}`
}

/**
 * Amounts that must not be handed out again: anything still payable, plus anything from the last day
 * so a payment that lands late still finds its own row. Only 999 tails exist per whole amount, so this
 * set is kept small on purpose: a week of every order ever made would let one trainer exhaust it.
 */
function usedAmounts(db: DB): Set<string> {
  const since = now() - DAY
  const used = new Set<string>()
  for (const r of db
    .prepare("select amount from orders where status = 'pending' or created_at > ?")
    .all(since) as { amount: string }[])
    used.add(r.amount)
  for (const r of db
    .prepare("select pay_a, pay_b from wagers where status in ('pending_accept','awaiting_payment') or accepted_at > ?")
    .all(since) as { pay_a: string | null; pay_b: string | null }[]) {
    if (r.pay_a) used.add(r.pay_a)
    if (r.pay_b) used.add(r.pay_b)
  }
  return used
}

export function uniqueAmount(db: DB, wholeWei: bigint, rand: () => number = Math.random): string {
  const used = usedAmounts(db)
  const start = 1 + Math.floor(rand() * 999)
  for (let i = 0; i < 999; i++) {
    const tail = BigInt(((start - 1 + i) % 999) + 1)
    const amt = (wholeWei + tail * TAIL_UNIT).toString()
    if (!used.has(amt)) return amt
  }
  throw new Error('no unique payment amount left for that total, try a slightly different amount')
}

/** For posts: whole tokens with up to 2 decimals ("1,980" / "20.01"). Payment amounts use showAmount. */
export function roundAmount(wei: bigint | string): string {
  const n = Number(fromWei(wei))
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 })
}
