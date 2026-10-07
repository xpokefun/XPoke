/**
 * A transfer reached the pool. Which order or wager side is it for?
 *
 * Amounts are unique per payment, so the exact wei value is the key. Anything that matches a payment
 * that can no longer be used (a cancelled wager, a side already paid) is refunded to the sender.
 */
import { type DB, now, tx } from '../db.ts'
import { addLedger, BURN_TARGET } from './ledger.ts'
import { recordWagerPayment, type Wager } from '../game/wager.ts'

export type Transfer = { txHash: string; logIndex: number; from: string; amount: string; block: number }

export type MatchResult = { kind: 'order' | 'wager' | 'refund' | 'unmatched'; id: number | null; announce?: string }

export function handleTransfer(db: DB, t: Transfer): MatchResult | null {
  return tx(db, () => {
    const ins = db
      .prepare('insert or ignore into transfers (tx_hash, log_index, from_addr, amount, block, seen_at) values (?,?,?,?,?,?)')
      .run(t.txHash, t.logIndex, t.from, t.amount, t.block, now())
    if (!ins.changes) return null // already handled
    const r = match(db, t)
    db.prepare('update transfers set matched_kind = ?, matched_id = ? where tx_hash = ? and log_index = ?').run(r.kind, r.id, t.txHash, t.logIndex)
    return r
  })
}

function match(db: DB, t: Transfer): MatchResult {
  // Solana addresses are case-sensitive base58: never lowercase them
  const from = t.from

  // our own allowance pull: recognised by its signature, and it pays exactly the side it was made for
  const pull = db.prepare("select * from pulls where sig = ?").get(t.txHash) as { wager_id: number; side: 'a' | 'b'; owner: string; amount: string } | undefined
  if (pull && pull.amount === t.amount) {
    const w = db.prepare('select * from wagers where id = ?').get(pull.wager_id) as Wager
    const already = pull.side === 'a' ? w.paid_a_tx : w.paid_b_tx
    if (w.status === 'awaiting_payment' && !already) {
      addLedger(db, { kind: 'payment', ref_kind: 'wager', ref_id: w.id, from_addr: from, amount: t.amount, status: 'confirmed', tx_hash: t.txHash })
      const announce = recordWagerPayment(db, w, pull.side, { tx: t.txHash, from, amount: t.amount })
      return { kind: 'wager', id: w.id, ...(announce ? { announce } : {}) }
    }
    // the side was paid by hand meanwhile, or the wager closed: this pull goes back like any duplicate
    addLedger(db, { kind: 'payment', ref_kind: 'transfer', ref_id: transferRowId(db, t), from_addr: from, amount: t.amount, status: 'confirmed', tx_hash: t.txHash })
    refundTransfer(db, t)
    return { kind: 'refund', id: w.id }
  }
  // shop orders: credited even when paid a little after the window, since the amount is still unique to it
  // an expired order still gets credited for a day (its amount stays reserved that long, see usedAmounts)
  const order = db
    .prepare("select * from orders where amount = ? and (status = 'pending' or (status = 'expired' and created_at > ?)) order by id desc limit 1")
    .get(t.amount, now() - 24 * 3600_000) as
    | { id: number; trainer_id: string; ball: string; qty: number }
    | undefined
  if (order) {
    db.prepare("update orders set status = 'paid', paid_tx = ?, paid_from = ?, paid_at = ? where id = ?").run(t.txHash, from, now(), order.id)
    db.prepare(`update trainers set ${order.ball === 'master' ? 'master_balls' : 'ultra_balls'} = ${order.ball === 'master' ? 'master_balls' : 'ultra_balls'} + ? where id = ?`).run(
      order.qty,
      order.trainer_id,
    )
    addLedger(db, { kind: 'payment', ref_kind: 'order', ref_id: order.id, from_addr: from, amount: t.amount, status: 'confirmed', tx_hash: t.txHash })
    // every ball purchase is burned in full: the tokens leave circulation, nothing stays in the pool
    addLedger(db, { kind: 'burn', ref_kind: 'order', ref_id: order.id, to_addr: BURN_TARGET, amount: t.amount, status: 'pending' })
    return { kind: 'order', id: order.id }
  }

  const w = db.prepare('select * from wagers where pay_a = ? or pay_b = ? order by id desc limit 1').get(t.amount, t.amount) as Wager | undefined
  if (w) {
    const side: 'a' | 'b' = w.pay_a === t.amount ? 'a' : 'b'
    const already = side === 'a' ? w.paid_a_tx : w.paid_b_tx
    if (w.status === 'awaiting_payment' && !already) {
      addLedger(db, { kind: 'payment', ref_kind: 'wager', ref_id: w.id, from_addr: from, amount: t.amount, status: 'confirmed', tx_hash: t.txHash })
      const announce = recordWagerPayment(db, w, side, { tx: t.txHash, from, amount: t.amount })
      return { kind: 'wager', id: w.id, ...(announce ? { announce } : {}) }
    }
    // late, duplicate or for a finished wager: booked against the transfer (never against the wager, so the
    // wager's paid-in total that caps its payouts stays exactly the two payments that fund it) and sent back
    addLedger(db, { kind: 'payment', ref_kind: 'transfer', ref_id: transferRowId(db, t), from_addr: from, amount: t.amount, status: 'confirmed', tx_hash: t.txHash })
    refundTransfer(db, t)
    return { kind: 'refund', id: w.id }
  }

  addLedger(db, { kind: 'payment', ref_kind: 'transfer', ref_id: transferRowId(db, t), from_addr: from, amount: t.amount, status: 'confirmed', tx_hash: t.txHash })
  return { kind: 'unmatched', id: null }
}

function transferRowId(db: DB, t: Transfer): number {
  return (db.prepare('select rowid as id from transfers where tx_hash = ? and log_index = ?').get(t.txHash, t.logIndex) as { id: number }).id
}

function refundTransfer(db: DB, t: Transfer): void {
  addLedger(db, { kind: 'refund', ref_kind: 'transfer', ref_id: transferRowId(db, t), to_addr: t.from, amount: t.amount, status: 'pending' })
}
