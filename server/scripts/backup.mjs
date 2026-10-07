// Snapshot of the live database, every hour by xpoke-backup.timer (consistent while the server runs).
//
// - gzip-compressed, and every snapshot is opened and integrity-checked before it counts: a backup that
//   cannot be restored is worse than none, because it looks like one.
// - Keeps every snapshot of the last 48 hours, then one per day for 60 days.
// - The Mac pulls this folder every hour (deploy/pull-backups.sh), so a copy exists off this server too.
//
// Restore: deploy/restore.sh <snapshot.db.gz> (stops xpoke, keeps the current db aside, restores, starts).
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'

const dir = process.env.BACKUP_DIR ?? join(process.env.HOME ?? '.', 'xpoke-backups')
mkdirSync(dir, { recursive: true, mode: 0o700 })
const src = join(process.env.DATA_DIR ?? './data', 'xpoke.db')
if (!existsSync(src)) throw new Error(`no database at ${src}: refusing to back up nothing`)

const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const raw = join(dir, `.xpoke-${stamp}.db`)
new DatabaseSync(src, { readOnly: true }).exec(`vacuum into '${raw}'`)

// prove it opens and is whole, and record what it holds
const check = new DatabaseSync(raw, { readOnly: true })
const ok = check.prepare('pragma integrity_check').get()
if (Object.values(ok)[0] !== 'ok') throw new Error(`snapshot failed its integrity check: ${JSON.stringify(ok)}`)
const counts = check
  .prepare("select (select count(*) from trainers) t, (select count(*) from pokemon where location != 'released') p, (select count(*) from ledger) l")
  .get()
check.close()

const out = join(dir, `xpoke-${stamp}.db.gz`)
writeFileSync(out, gzipSync(readFileSync(raw), { level: 9 }), { mode: 0o600 })
rmSync(raw)
// and the compressed file decompresses to a database again
const back = gunzipSync(readFileSync(out))
if (back.subarray(0, 16).toString('latin1') !== 'SQLite format 3\u0000') throw new Error('compressed snapshot does not decompress to a database')

// retention: everything from the last 48 h, then the first snapshot of each day for 60 days
const now = Date.now()
const files = readdirSync(dir).filter((f) => /^xpoke-.*\.db(\.gz)?$/.test(f)).sort()
const keepDay = new Set()
for (const f of files) {
  const m = f.match(/^xpoke-(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/)
  if (!m) continue
  const t = Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`)
  const age = now - t
  if (age < 48 * 3600_000) continue
  if (age < 60 * 86400_000 && !keepDay.has(m[1])) {
    keepDay.add(m[1])
    continue
  }
  rmSync(join(dir, f))
}
console.log(`backup ${out} · ${counts.t} trainers, ${counts.p} pokemon, ${counts.l} ledger rows · integrity ok`)
