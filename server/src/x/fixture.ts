/**
 * A mention source backed by a JSON file, and a replier that writes to memory.
 *
 * ⭐ This is what lets the whole pipeline — parse, guard, launch, record, reply — be exercised with
 * no X account, no API key and no spend, including against a forked chain. The alternative is a
 * system whose only integration test is a real launch on mainnet.
 *
 * The file is re-read on every poll, so a fixture can be edited while the worker runs and the next
 * cycle picks it up. That makes it a usable manual console as well as a test double: drop a mention
 * into the file and watch a real launch go out on a fork.
 */
import { readFile } from 'node:fs/promises'
import type { Mention, MentionSource, Replier } from './types.ts'
import { parseXDate } from './types.ts'

/** The minimum a fixture entry needs. Everything else takes a sensible default. */
export type FixtureMention = {
  id: string
  text: string
  authorHandle: string
  createdAt?: string
  authorId?: string
  authorName?: string
  authorFollowers?: number
  authorCreatedAt?: string
  authorAvatar?: string
  mediaUrl?: string
  inReplyToId?: string
  /** Only in fixtures: the image on the post being replied to. */
  parentMediaUrl?: string
  isRetweet?: boolean
}

export function fixtureToMention(f: FixtureMention): Mention {
  return {
    id: String(f.id),
    text: f.text,
    createdAt: parseXDate(f.createdAt) ?? new Date(),
    authorHandle: f.authorHandle,
    authorId: f.authorId ?? f.authorHandle,
    authorName: f.authorName ?? f.authorHandle,
    /*
      ⚠ Defaults are generous on purpose. A fixture is for exercising the launch path, and a
      follower count of zero would be stopped by the spam guards before it ever got there, which
      would make every fixture run look like a guard bug.
    */
    authorFollowers: f.authorFollowers ?? 1_000,
    authorCreatedAt: parseXDate(f.authorCreatedAt) ?? new Date(Date.now() - 365 * 24 * 3600 * 1000),
    authorAvatar: f.authorAvatar ?? null,
    mediaUrl: f.mediaUrl ?? null,
    inReplyToId: f.inReplyToId ?? null,
    isRetweet: f.isRetweet ?? false,
    url: `https://x.com/${f.authorHandle}/status/${f.id}`,
  }
}

export class FixtureSource implements MentionSource {
  readonly kind = 'fixture'
  /** Parent-post images, keyed by the id a fixture says it replies to. */
  private readonly parentMedia = new Map<string, string>()

  async fetchTweetMedia(tweetId: string): Promise<string | null> {
    return this.parentMedia.get(tweetId) ?? null
  }

  constructor(private readonly path: string) {}

  async fetchMentions(): Promise<Mention[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch {
      // ⚠ A missing fixture is an empty inbox, not a crash. XPoke runs on the fixture source by
      // default so that a first `npm start` with no credentials does something sane.
      return []
    }
    const parsed = JSON.parse(raw) as FixtureMention[] | { mentions?: FixtureMention[] }
    const list = Array.isArray(parsed) ? parsed : (parsed.mentions ?? [])
    for (const entry of list) {
      if (entry.inReplyToId && entry.parentMediaUrl) this.parentMedia.set(entry.inReplyToId, entry.parentMediaUrl)
    }

    return list.map(fixtureToMention)
  }

  /**
   * ⭐ Finds it in the fixture file rather than pretending it cannot. It lets the ingest path be
   * exercised with no account and no spend, like every other part of the pipeline.
   */
  async fetchMentionById(tweetId: string): Promise<Mention | null> {
    return (await this.fetchMentions()).find((m) => m.id === tweetId) ?? null
  }
}

/** Records what would have been posted, so a dry run can be inspected. */
export class MemoryReplier implements Replier {
  readonly kind = 'memory'
  readonly sent: { inReplyToId: string | null; text: string }[] = []

  async post(text: string): Promise<string | null> {
    this.sent.push({ inReplyToId: null, text })
    return `memory-${this.sent.length}`
  }

  async reply(inReplyToId: string, text: string): Promise<string | null> {
    this.sent.push({ inReplyToId, text })
    return `memory-${this.sent.length}`
  }
}
