/**
 * Trades: "trade @trainer [yours] for [theirs]", or a gift without "for".
 * The other trainer accepts or declines on the website (/me).
 */
import { type DB, now, tx } from '../db.ts'
import { TRADE_EXPIRY } from './rules.ts'
import { arrivalLocation, findMon, getMon, getTrainer, lockOf, monName, nextSlot, party, sp, trainerByHandle } from './store.ts'
import type { Ctx } from './engine.ts'

export type Trade = {
  id: number
  from_id: string
  to_id: string
  offer_pokemon: number
  want_pokemon: number | null
  status: string
  created_at: number
  resolved_at: number | null
}

export function expireTrades(db: DB): void {
  db.prepare("update trades set status = 'expired', resolved_at = ? where status = 'pending' and created_at <= ?").run(
    now(),
    now() - TRADE_EXPIRY,
  )
}

function pendingFor(db: DB, trainerId: string): Trade | null {
  return (
    (db
      .prepare("select * from trades where status = 'pending' and (from_id = ? or to_id = ?)")
      .get(trainerId, trainerId) as Trade | undefined) ?? null
  )
}

export function createTrade(c: Ctx, targetHandle: string, offerName: string, wantName?: string): string {
  const { db, actor } = c
  expireTrades(db)
  if (targetHandle.toLowerCase() === actor.handle.toLowerCase()) return "you can't trade with yourself"
  const opp = trainerByHandle(db, targetHandle)
  if (!opp) return `that trainer hasn't started playing yet`
  if (pendingFor(db, actor.id)) return 'you already have a pending trade. one at a time'
  if (pendingFor(db, opp.id)) return `@${opp.handle} already has a pending trade`
  const offer = findMon(party(db, actor.id), { name: offerName })
  if (!offer) return `you don't have a ${offerName} in your party. only party pokemon can be traded`
  if (lockOf(db, offer.id)) return `${sp(offer).name} is locked in a battle right now`
  let want = null
  if (wantName) {
    want = findMon(party(db, opp.id), { name: wantName })
    if (!want) return `@${opp.handle} doesn't have a ${wantName} in their party`
    if (lockOf(db, want.id)) return `@${opp.handle}'s ${sp(want).name} is locked in a battle right now`
  }
  db.prepare("insert into trades (from_id, to_id, offer_pokemon, want_pokemon, status, created_at) values (?,?,?,?,'pending',?)").run(
    actor.id,
    opp.id,
    offer.id,
    want?.id ?? null,
    now(),
  )
  const host = c.site.replace(/^https?:\/\//, '')
  if (want)
    return `@${actor.handle} @${opp.handle} trade offer: ${actor.handle}'s ${monName(offer)} for ${opp.handle}'s ${monName(want)}. ${opp.handle}, login at ${host}/me and accept or decline`
  return `@${actor.handle} @${opp.handle} ${actor.handle} sends ${monName(offer)} to ${opp.handle}. ${opp.handle}, accept at ${host}/me`
}

/** Accept or decline, by the receiving trainer, from the website. */
export function resolveTrade(db: DB, tradeId: number, trainerId: string, accept: boolean): { ok: boolean; message: string } {
  return tx(db, () => {
    expireTrades(db)
    const t = db.prepare('select * from trades where id = ?').get(tradeId) as Trade | undefined
    if (!t || t.status !== 'pending') return { ok: false, message: 'that trade is no longer pending' }
    if (t.to_id !== trainerId && !(t.from_id === trainerId && !accept))
      return { ok: false, message: 'only the receiving trainer can accept' }
    if (!accept) {
      db.prepare("update trades set status = ?, resolved_at = ? where id = ?").run(t.from_id === trainerId ? 'cancelled' : 'declined', now(), t.id)
      return { ok: true, message: 'trade cancelled, nothing moved' }
    }
    const offer = getMon(db, t.offer_pokemon)
    const want = t.want_pokemon ? getMon(db, t.want_pokemon) : null
    if (!offer || offer.trainer_id !== t.from_id || offer.location !== 'party')
      return fail(db, t, 'the offered pokemon is no longer in their party')
    if (t.want_pokemon && (!want || want.trainer_id !== t.to_id || want.location !== 'party'))
      return fail(db, t, 'your pokemon is no longer in your party')
    // the pending trade itself locks both Pokémon; any other lock blocks the swap
    const blocked = (id: number) => {
      const l = lockOf(db, id)
      return l && l !== 'trade'
    }
    if (blocked(offer.id) || (want && blocked(want.id))) return { ok: false, message: 'one of the pokemon is locked in a battle, try again after' }
    if (want) {
      // straight swap of owners, each lands in the slot the other left
      db.prepare('update pokemon set trainer_id = ?, slot = ? where id = ?').run(t.to_id, want.slot, offer.id)
      db.prepare('update pokemon set trainer_id = ?, slot = ? where id = ?').run(t.from_id, offer.slot, want.id)
    } else {
      const loc = arrivalLocation(db, t.to_id)
      db.prepare('update pokemon set trainer_id = ?, location = ?, slot = ? where id = ?').run(t.to_id, loc, nextSlot(db, t.to_id, loc), offer.id)
    }
    db.prepare("update trades set status = 'accepted', resolved_at = ? where id = ?").run(now(), t.id)
    const from = getTrainer(db, t.from_id)!
    return { ok: true, message: want ? `traded! ${sp(offer).name} is yours and @${from.handle} got ${sp(want).name}` : `${sp(offer).name} is yours!` }
  })
}

function fail(db: DB, t: Trade, message: string) {
  db.prepare("update trades set status = 'cancelled', resolved_at = ? where id = ?").run(now(), t.id)
  return { ok: false, message }
}
