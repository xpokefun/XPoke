/**
 * The agent: read mentions, run each as a command, answer.
 *
 * - Every mention is stored by post id first, so a restart or an overlapping poll never runs one twice.
 * - At most 3 public replies per trainer per hour. Over that, the command still runs and is logged
 *   as "Command" instead of "Replied"; the result is on /agent either way.
 * - Polling is split (from a drained twitterapi.io balance): a cheap frequent poll with a 5 minute
 *   lookback, and a wide 2 hour catch-up every 15 minutes, because the mentions index can lag.
 */
import { type DB, getMeta, now, setMeta } from './db.ts'
import type { Config } from './config.ts'
import type { Mention, MentionSource, Replier } from './x/types.ts'
import { parseCommand } from './game/parse.ts'
import { describe, type Command } from './game/commands.ts'
import { run } from './game/engine.ts'
import { ensureTrainer } from './game/store.ts'
import { REPLIES_PER_HOUR } from './game/rules.ts'
import type { Agent } from './llm.ts'

export type AgentStatus = {
  platform: 'x' | 'reddit'
  online: boolean
  lastPollAt: number | null
  lastError: string | null
}

export const xStatus: AgentStatus = { platform: 'x', online: false, lastPollAt: null, lastError: null }

export type Deps = {
  db: DB
  cfg: Config
  source: MentionSource
  replier: Replier
  agent: Agent | null
}

/** Per-day spend counters (UTC), shown on /api/agent/status so cost is visible, not guessed. */
export function bump(db: DB, key: 'xReads' | 'xTweetsRead' | 'xPosts' | 'llmCalls' | 'llmSkipped', by = 1): void {
  const day = new Date().toISOString().slice(0, 10)
  const k = `usage:${day}`
  const u = JSON.parse(getMeta(db, k) ?? '{}') as Record<string, number>
  u[key] = (u[key] ?? 0) + by
  setMeta(db, k, JSON.stringify(u))
}

export function usage(db: DB, days = 7): { day: string; usage: Record<string, number> }[] {
  const out = []
  for (let i = 0; i < days; i++) {
    const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10)
    out.push({ day, usage: JSON.parse(getMeta(db, `usage:${day}`) ?? '{}') })
  }
  return out
}

/** Recent model answers by normalised text, so "best fire type?" asked twice costs once. */
const llmCache = new Map<string, { at: number; command: Command | null; chat: string | null }>()

/**
 * Whether a post is worth a model call. Most traffic the rules miss is noise ("gm", emoji, a lone link),
 * and that must cost nothing.
 */
function modelWorthy(d: Deps, text: string, authorId: string): boolean {
  const words = text.replace(/@\w+/g, ' ').replace(/https?:\/\/\S+/g, ' ').match(/[\p{L}\p{N}]{2,}/gu) ?? []
  if (words.length < 2) return false
  const hour = (d.db.prepare("select count(*) as n from mentions where author_id = ? and model = 1 and processed_at > ?").get(authorId, now() - 3600_000) as { n: number }).n
  if (hour >= d.cfg.llmPerUserHour) return false
  const day = (JSON.parse(getMeta(d.db, `usage:${new Date().toISOString().slice(0, 10)}`) ?? '{}') as Record<string, number>).llmCalls ?? 0
  return day < d.cfg.llmDailyCap
}

/**
 * The account-wide posting budget. A brand-new X account that suddenly posts hundreds of replies an hour
 * gets limited or suspended (accounts have been suspended after a few dozen posts in their first days), and every
 * reply is a paid post. Over the budget a command still runs and shows on /agent as "Command".
 * Posts also leave at least REPLY_GAP_MS apart, so a launch rush never fires a burst at X.
 */
let lastPostAt = 0
/** Counted from the database, so a restart does not hand out a fresh hourly budget. */
function postBudgetLeft(db: DB, cfg: Config): boolean {
  const n = (db.prepare("select count(*) as n from mentions where status = 'replied' and replied_at > ?").get(now() - 3600_000) as { n: number }).n
  return n < cfg.globalRepliesPerHour
}
async function postSlot(cfg: Config): Promise<void> {
  const wait = lastPostAt + cfg.replyGapMs - now()
  lastPostAt = Math.max(now(), lastPostAt + cfg.replyGapMs)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

/** Mention ids being processed right now, so two loops can never take the same one. */
const inFlight = new Set<string>()

export async function processMention(d: Deps, m: Mention, platform = 'x'): Promise<{ reply: string; status: string } | null> {
  const { db, cfg } = d
  if (m.authorHandle.toLowerCase() === cfg.handle.toLowerCase() || m.isRetweet) return null
  const authorId = m.authorId || `h:${m.authorHandle.toLowerCase()}`
  const ins = db
    .prepare('insert or ignore into mentions (id, platform, author_id, handle, text, created_at) values (?,?,?,?,?,?)')
    .run(m.id, platform, authorId, m.authorHandle, m.text, m.createdAt.getTime())
  const row = db.prepare('select processed_at from mentions where id = ?').get(m.id) as { processed_at: number | null }
  if ((!ins.changes && row.processed_at) || inFlight.has(m.id)) return null
  inFlight.add(m.id)
  try {
    const actor = ensureTrainer(db, { id: authorId, handle: m.authorHandle, name: m.authorName, avatar: m.authorAvatar })

    let command: Command | null = parseCommand(m.text, cfg.handle)
    let chatReply: string | null = null
    if (!command && d.agent) {
      const text = m.text.replace(/@\w+/g, ' ').replace(/\s+/g, ' ').trim()
      const key = text.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, '')
      const hit = llmCache.get(key)
      // only chat answers and "ignore" are reused: anything with a target or an amount must be judged on
      // this post's own words, not on an earlier stranger's
      if (hit && now() - hit.at < 6 * 3600_000 && (hit.command?.kind === 'chat' || hit.command?.kind === 'none')) {
        command = hit.command
        chatReply = hit.chat
      } else if (modelWorthy(d, text, authorId)) {
        try {
          bump(db, 'llmCalls')
          db.prepare('update mentions set model = 1 where id = ?').run(m.id)
          const r = await d.agent.interpret(text, m.text)
          command = r.command
          chatReply = r.chat
          llmCache.set(key, { at: now(), command: r.command, chat: r.chat })
          if (llmCache.size > 500) llmCache.delete(llmCache.keys().next().value!)
        } catch (e) {
          console.error('[agent] model error', (e as Error).message)
        }
      } else {
        bump(db, 'llmSkipped')
      }
    }
    if (!command) {
      // not understood: one help reply per trainer per day, otherwise stay quiet (a reply is a paid post)
      const helped = db
        .prepare("select 1 from mentions where author_id = ? and command = 'help' and processed_at > ? limit 1")
        .get(authorId, now() - 86400_000)
      command = helped ? { kind: 'none' } : { kind: 'help' }
    }

    // marked before running: a crash in the middle leaves a 'running' row that is never re-run (and
    // never re-replied); it shows in the log for the operator rather than firing twice
    db.prepare("update mentions set processed_at = ?, command = ?, status = 'running' where id = ?").run(now(), describe(command), m.id)
    const out = await run(
      {
        db,
        actor,
        site: cfg.publicUrl,
        chat: chatReply ? async () => chatReply! : undefined,
      },
      command,
    )

    // the command is done; its reply goes to the posting queue (never wait for X here: in a launch rush
    // the posting pace would otherwise hold every trainer's game up behind it)
    let status = 'ignored'
    const replyId: string | null = null
    if (out.reply) {
      const recent = db
        .prepare("select count(*) as n from mentions where author_id = ? and status in ('replied','queued') and processed_at > ?")
        .get(authorId, now() - 3600_000) as { n: number }
      status = recent.n < REPLIES_PER_HOUR && d.replier.kind !== 'none' ? 'queued' : 'command'
    }
    db.prepare('update mentions set processed_at = ?, command = ?, reply = ?, status = ?, reply_id = ? where id = ?').run(
      now(),
      describe(command),
      out.reply || null,
      status,
      replyId,
      m.id,
    )
    for (const line of out.announce ?? []) await announce(d, line)
    return { reply: out.reply, status }
  } catch (e) {
    console.error('[agent] command failed', m.id, e)
    db.prepare("update mentions set processed_at = ?, status = 'failed', reply = ? where id = ?").run(now(), String((e as Error).message).slice(0, 200), m.id)
    return null
  } finally {
    inFlight.delete(m.id)
  }
}

export async function announce(d: Deps, text: string): Promise<void> {
  db_log(d.db, text)
  if (!d.replier.post) return
  try {
    await d.replier.post(text.slice(0, 280))
    bump(d.db, 'xPosts')
  } catch (e) {
    console.error('[agent] announce failed', (e as Error).message)
  }
}

/** Announcements also show in the activity feed. */
function db_log(db: DB, text: string): void {
  const list = JSON.parse(getMeta(db, 'announcements') ?? '[]') as { at: number; text: string }[]
  list.unshift({ at: now(), text })
  setMeta(db, 'announcements', JSON.stringify(list.slice(0, 50)))
}

/**
 * Cost model (twitterapi.io bills every tweet returned, with a minimum per request even when empty):
 * - routine polls read only what is newer than the newest mention already seen (minus a 2 min overlap),
 *   so a mention is billed about once, not once per poll;
 * - polls run every POLL_SECONDS while people are playing and slow to POLL_IDLE_SECONDS when quiet;
 * - a 2 hour catch-up (the index can lag over an hour) runs every CATCHUP_MINUTES, not every 15.
 */
let lastWide = 0
let backoff = 0
let lastActivity = 0

export async function pollOnce(d: Deps): Promise<number> {
  const { db, cfg } = d
  const wide = now() - lastWide > cfg.catchupMinutes * 60_000
  const nowS = Math.floor(now() / 1000)
  const newest = Number(getMeta(db, 'x_newest_mention') ?? 0)
  const since = wide ? nowS - 2 * 3600 : Math.max(nowS - 5 * 60, newest ? newest - 120 : nowS - 5 * 60)
  const mentions = await d.source.fetchMentions(d.source.kind === 'fixture' ? null : since)
  if (d.source.kind !== 'fixture') {
    bump(db, 'xReads')
    bump(db, 'xTweetsRead', mentions.length)
  }
  if (wide) lastWide = now()
  xStatus.lastPollAt = now()
  xStatus.online = true
  xStatus.lastError = null
  const top = mentions.reduce((t, m) => Math.max(t, Math.floor(m.createdAt.getTime() / 1000)), newest)
  if (top > newest) setMeta(db, 'x_newest_mention', String(top))
  // oldest first, so a "challenge" is seen before its "accept"
  const fresh = mentions
    .filter((m) => !db.prepare('select 1 from mentions where id = ? and processed_at is not null').get(m.id))
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
  if (fresh.length) lastActivity = now()
  await processInParallel(d, fresh)
  return fresh.length
}

/**
 * A launch brings hundreds of mentions at once. One trainer's mentions run in order (a "challenge" before
 * its "accept"); different trainers run side by side, MENTION_WORKERS at a time, so one slow model call or
 * reply never holds up everyone else. Game state stays consistent: every command applies inside one
 * synchronous SQLite transaction.
 */
export async function processInParallel(d: Deps, mentions: Mention[]): Promise<void> {
  // replies to something (accept/decline/cancel) run after everything else in this batch, so B's "accept"
  // never overtakes A's "challenge" that arrived in the same poll but sits behind other trainers
  const answer = /\b(accept|accepted|decline|declined|cancel)\b/i
  const later = mentions.filter((m) => answer.test(m.text))
  if (later.length && later.length < mentions.length) {
    await processInParallel(d, mentions.filter((m) => !answer.test(m.text)))
    await processInParallel(d, later)
    return
  }
  const byAuthor = new Map<string, Mention[]>()
  for (const m of mentions) {
    const k = (m.authorId || m.authorHandle).toLowerCase()
    byAuthor.set(k, [...(byAuthor.get(k) ?? []), m])
  }
  const queues = [...byAuthor.values()]
  const worker = async () => {
    for (let q = queues.shift(); q; q = queues.shift()) for (const m of q) await processMention(d, m)
  }
  await Promise.all(Array.from({ length: Math.max(1, d.cfg.mentionWorkers) }, worker))
}

/**
 * The reply queue: posts queued replies oldest first, REPLY_GAP_MS apart, within the account-wide hourly
 * budget. A reply that waited more than 15 minutes is not posted any more (it would read as stale); it
 * becomes a "Command" like any over-limit reply, and the result is on /agent either way. Rows live in the
 * database, so a restart picks the queue up where it was.
 */
let replyLoopRunning = false
export async function drainReplies(d: Deps, once = false): Promise<number> {
  const { db, cfg } = d
  let sent = 0
  for (;;) {
    const row = db
      .prepare("select id, reply, processed_at from mentions where status = 'queued' order by processed_at, id limit 1")
      .get() as { id: string; reply: string; processed_at: number } | undefined
    if (!row) return sent
    if (now() - row.processed_at > 15 * 60_000 || !postBudgetLeft(db, cfg)) {
      db.prepare("update mentions set status = 'command' where id = ?").run(row.id)
      continue
    }
    await postSlot(cfg)
    try {
      const replyId = await d.replier.reply(row.id, row.reply)
      if (d.replier.kind !== 'memory') bump(db, 'xPosts')
      db.prepare("update mentions set status = 'replied', reply_id = ?, replied_at = ? where id = ?").run(replyId, now(), row.id)
      sent++
    } catch (e) {
      console.error('[agent] reply failed', (e as Error).message)
      db.prepare("update mentions set status = 'command' where id = ?").run(row.id)
    }
    if (once) return sent
  }
}

export function startReplyLoop(d: Deps): void {
  if (replyLoopRunning) return
  replyLoopRunning = true
  const tick = async () => {
    try {
      await drainReplies(d)
    } catch (e) {
      console.error('[agent] reply loop', e)
    }
    setTimeout(tick, 1000)
  }
  void tick()
}

export function startPolling(d: Deps): void {
  const tick = async () => {
    try {
      await pollOnce(d)
      backoff = 0
    } catch (e) {
      xStatus.online = false
      xStatus.lastError = (e as Error).message.slice(0, 200)
      // a dead key or an empty balance must not be hammered: back off up to 30 min
      backoff = Math.min(backoff ? backoff * 2 : 60_000, 30 * 60_000)
      console.error('[agent] poll failed, backing off', backoff / 1000, 's:', xStatus.lastError)
    }
    const busy = now() - lastActivity < 10 * 60_000
    setTimeout(tick, backoff || (busy ? d.cfg.pollSeconds : d.cfg.pollIdleSeconds) * 1000)
  }
  void tick()
}
