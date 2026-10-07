import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, getMeta } from '../src/db.ts'
import { loadConfig } from '../src/config.ts'
import { processMention, pollOnce, drainReplies, type Deps } from '../src/agent.ts'
import { MemoryReplier } from '../src/x/fixture.ts'
import type { Mention, MentionSource } from '../src/x/types.ts'

let calls = 0
const stubAgent = {
  async interpret(text: string) {
    calls++
    return { command: { kind: 'chat' as const, text }, chat: `answer to ${text}` }
  },
}

function deps(over: Partial<ReturnType<typeof loadConfig>> = {}): Deps & { replier: MemoryReplier } {
  const db = openDb(mkdtempSync(join(tmpdir(), 'xpc-')))
  const cfg = { ...loadConfig(), handle: 'xpokebot', llmPerUserHour: 2, llmDailyCap: 3, replyGapMs: 0, ...over }
  const source: MentionSource = { kind: 'stub', fetchMentions: async () => [] }
  return { db, cfg, source, replier: new MemoryReplier(), agent: stubAgent as never }
}

let n = 0
const mention = (handle: string, text: string, at = new Date()): Mention => ({
  id: String(++n), text: `@xpokebot ${text}`, createdAt: at, authorHandle: handle, authorId: `id-${handle}`, authorName: handle,
  authorFollowers: 1, authorCreatedAt: null, authorAvatar: null, mediaUrl: null, inReplyToId: null, isRetweet: false, url: '',
})

test('rule-parsed commands never call the model', async () => {
  calls = 0
  const d = deps()
  for (const t of ['catch', 'check', 'feed ramen', 'battle', 'help', 'wager @x 10']) await processMention(d, mention('ash', t))
  assert.equal(calls, 0)
})

test('noise costs nothing and gets one help reply a day at most', async () => {
  calls = 0
  const d = deps()
  for (const t of ['gm', '🔥🔥', 'lol', 'https://x.com/a', 'ok']) await processMention(d, mention('ash', t))
  assert.equal(calls, 0)
  await drainReplies(d)
  const helps = d.replier.sent.filter((r) => r.text.startsWith('say:'))
  assert.equal(helps.length, 1)
})

test('same question twice costs one call; per-user and daily caps hold', async () => {
  calls = 0
  const d = deps()
  await processMention(d, mention('ash', 'what is the best fire type'))
  await processMention(d, mention('misty', 'what is the best fire type?'))
  assert.equal(calls, 1)
  await processMention(d, mention('ash', 'tell me about ghost types'))
  await processMention(d, mention('ash', 'who would win mewtwo or mew'))
  assert.equal(calls, 2) // ash hit 2/hour
  await processMention(d, mention('brock', 'which rock type is strongest'))
  await processMention(d, mention('gary', 'is shiny charizard rare'))
  assert.equal(calls, 3) // daily cap 3
  const day = JSON.parse(getMeta(d.db, `usage:${new Date().toISOString().slice(0, 10)}`)!)
  assert.equal(day.llmCalls, 3)
  assert.ok(day.llmSkipped >= 2)
})

test('routine polls ask only for what is newer than the newest mention seen', async () => {
  const d = deps()
  const asked: (number | null)[] = []
  const t0 = Math.floor(Date.now() / 1000)
  d.source = {
    kind: 'stub',
    fetchMentions: async (since) => {
      asked.push(since)
      return asked.length === 2 ? [mention('ash', 'catch', new Date((t0 - 30) * 1000))] : []
    },
  }
  await pollOnce(d) // first poll is the wide 2 h catch-up
  await pollOnce(d)
  await pollOnce(d)
  assert.ok(t0 - asked[0]! >= 7000, 'catch-up looks back 2 h')
  assert.ok(t0 - asked[1]! <= 301, 'routine poll looks back at most 5 min')
  assert.equal(asked[2], t0 - 30 - 120, 'next poll starts at the newest mention minus 2 min overlap')
})

test('a launch rush: commands finish at once, replies drain from the queue within the budget', async () => {
  const d = deps({ globalRepliesPerHour: 5 })
  const { processInParallel } = await import('../src/agent.ts')
  const batch = Array.from({ length: 40 }, (_, i) => mention(`p${i}`, 'catch'))
  const t0 = Date.now()
  await processInParallel(d, batch)
  assert.ok(Date.now() - t0 < 5000, 'all 40 commands ran without waiting for X')
  const queued = (d.db.prepare("select count(*) n from mentions where status = 'queued'").get() as { n: number }).n
  assert.equal(queued, 40)
  await drainReplies(d)
  const by = Object.fromEntries((d.db.prepare('select status, count(*) n from mentions group by status').all() as { status: string; n: number }[]).map((r) => [r.status, r.n]))
  assert.equal(by.replied, 5, 'the hourly budget holds')
  assert.equal(by.command, 35, 'the rest ran silently')
  assert.equal(d.replier.sent.length, 5)
})
