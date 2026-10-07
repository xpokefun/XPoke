/**
 * Operator commands. On the server: cd server && npm run admin -- <command>
 *
 *   status                       one screen: X, chain, queue, held/failed payouts, today's spend
 *   tournament "Name" "prize" [--prize-amount 5000]
 *                                open a tournament; with --prize-amount the champion is paid that many $XPOKE
 *                                automatically (send the prize to the pool wallet first; players need a linked wallet)
 *   ledger                       the last 30 ledger rows
 *   pause-payouts                stop sending payouts/refunds/burns at once (they queue up, nothing is lost)
 *   resume-payouts               start sending again
 *   held                         payouts the solvency guard parked, with the reason
 *   release <ledger id>          put a held/failed row back in the queue (after you checked it)
 *   clear-running                mark mentions stuck mid-command by a crash as failed (they are never re-run)
 *
 * ⚠ The running server picks up pause/resume within one heartbeat (2 s); no restart needed.
 */
import { loadConfig } from './config.ts'
import { getMeta, openDb, setMeta, now } from './db.ts'
import { createTournament } from './game/tournament.ts'
import { showAmount, toWei } from './pay/amounts.ts'

const cfg = loadConfig()
const db = openDb(cfg.dataDir)
const [cmd, ...args] = process.argv.slice(2)

function count(sql: string, ...p: unknown[]): number {
  return (db.prepare(sql).get(...(p as [])) as { n: number }).n
}

switch (cmd) {
  case 'tournament': {
    const i = args.indexOf('--prize-amount')
    const amount = i >= 0 ? args[i + 1] : undefined
    if (i >= 0 && !/^\d+(\.\d{1,6})?$/.test(amount ?? '')) throw new Error('--prize-amount needs a number of tokens')
    const rest = args.filter((_, k) => k !== i && k !== i + 1)
    const t = createTournament(db, rest[0] || 'XPoke Cup', rest[1] ?? (amount ? `${amount} $XPOKE` : null), amount ? toWei(amount).toString() : null)
    console.log('opened tournament', t.id, t.name, t.prize ?? '', amount ? `· ${amount} $XPOKE paid automatically to the champion's linked wallet. send it to the pool first: ${process.env.POOL_ADDRESS || '(pool wallet, see npm run admin -- status)'}` : '')
    break
  }
  case 'ledger':
    console.table(
      (db.prepare('select id, kind, ref_kind, ref_id, to_addr, amount, status, tx_hash, error from ledger order by id desc limit 30').all() as {
        amount: string
      }[]).map((r) => ({ ...r, amount: showAmount(r.amount) })),
    )
    break
  case 'pause-payouts':
    setMeta(db, 'payouts_paused', '1')
    console.log('payouts PAUSED. queued rows wait; run resume-payouts to continue')
    break
  case 'resume-payouts':
    setMeta(db, 'payouts_paused', '')
    console.log('payouts resumed')
    break
  case 'held':
    console.table(
      (db.prepare("select id, kind, ref_kind, ref_id, to_addr, amount, status, error from ledger where status in ('held','failed') order by id").all() as {
        amount: string
      }[]).map((r) => ({ ...r, amount: showAmount(r.amount) })),
    )
    break
  case 'release': {
    const id = Number(args[0])
    const r = db
      .prepare("update ledger set status = 'pending', raw_tx = null, tx_hash = null, nonce = null, tries = 0, error = 'released by operator', updated_at = ? where id = ? and status in ('held','failed')")
      .run(now(), id)
    console.log(r.changes ? `ledger #${id} back in the queue (the solvency guard still checks it before sending)` : `ledger #${id} is not held or failed`)
    break
  }
  case 'clear-running': {
    const r = db.prepare("update mentions set status = 'failed', reply = 'interrupted by a restart' where status = 'running' and processed_at < ?").run(now() - 5 * 60_000)
    console.log(`${r.changes} stuck mention(s) marked failed`)
    break
  }
  case 'status': {
    const day = new Date().toISOString().slice(0, 10)
    console.log({
      trainers: count('select count(*) n from trainers'),
      pokemon: count("select count(*) n from pokemon where location != 'released'"),
      mentionsToday: count('select count(*) n from mentions where processed_at > ?', Date.parse(day)),
      mentionsRunning: count("select count(*) n from mentions where status = 'running'"),
      openOrders: count("select count(*) n from orders where status = 'pending'"),
      openWagers: count("select count(*) n from wagers where status in ('pending_accept','awaiting_payment')"),
      payoutsPaused: getMeta(db, 'payouts_paused') === '1',
      queued: count("select count(*) n from ledger where status in ('pending','signed') and kind != 'payment'"),
      held: count("select count(*) n from ledger where status = 'held'"),
      failed: count("select count(*) n from ledger where status = 'failed'"),
      unmatchedTransfers: count("select count(*) n from transfers where matched_kind = 'unmatched'"),
      usageToday: JSON.parse(getMeta(db, `usage:${day}`) ?? '{}'),
      mint: cfg.tokenMint || '(not set)',
      payoutsEnabled: cfg.payoutsEnabled,
    })
    break
  }
  default:
    console.log('commands: status · tournament <name> [prize] · ledger · pause-payouts · resume-payouts · held · release <id> · clear-running')
}
