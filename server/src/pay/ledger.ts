/** The pool's book: every payment in and every payout, refund and burn out, with its hash. */
import { type DB, now } from '../db.ts'

export type LedgerKind = 'payment' | 'payout' | 'refund' | 'burn'
export const BURN_TARGET = 'burn'

export function addLedger(
  db: DB,
  e: {
    kind: LedgerKind
    ref_kind: 'wager' | 'order' | 'transfer' | 'tournament'
    ref_id: number
    to_addr?: string | null
    from_addr?: string | null
    amount: bigint | string
    status: 'pending' | 'confirmed'
    tx_hash?: string | null
  },
): void {
  // unique (kind, ref_kind, ref_id, to_addr, amount): the same payout can never be queued twice
  db.prepare(
    `insert or ignore into ledger (kind, ref_kind, ref_id, to_addr, from_addr, amount, status, tx_hash, created_at, updated_at)
     values (?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    e.kind,
    e.ref_kind,
    e.ref_id,
    e.to_addr ?? null,
    e.from_addr ?? null,
    e.amount.toString(),
    e.status,
    e.tx_hash ?? null,
    now(),
    now(),
  )
}
