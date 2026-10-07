/**
 * X's own API v2.
 *
 * - `GET  /2/users/:id/mentions` — 450 requests per 15 minutes per app, 300 per user
 * - `POST /2/tweets` — 10,000 per 24 hours per app, 100 per 15 minutes per user
 *
 * ⚠⚠ Two things about this path are worth knowing before choosing it. Reads are billed per post
 * under the pay-per-use model that replaced the flat tiers in February 2026, and a **post carrying
 * a URL is priced separately and far higher than a plain one**. XPoke's reply carries a link to the
 * token page, so every successful launch answered through this provider costs materially more than
 * the launch fee itself. The twitterapi.io provider exists for exactly that reason.
 *
 * ⚠ The mentions endpoint takes the account's **numeric id**, not its handle. `X_USER_ID` is
 * therefore a separate setting from `X_HANDLE`, and `preflight` resolves and prints it.
 */
import type { Mention, MentionSource, Replier } from './types.ts'
import { parseXDate } from './types.ts'

const BASE = 'https://api.x.com/2'

type RawUser = { id?: string; username?: string; name?: string; created_at?: string; profile_image_url?: string; public_metrics?: { followers_count?: number } }
type RawMedia = { media_key?: string; type?: string; url?: string; preview_image_url?: string }
type RawTweet = {
  id?: string
  text?: string
  created_at?: string
  author_id?: string
  referenced_tweets?: { type?: string; id?: string }[]
  attachments?: { media_keys?: string[] }
}

export class XApiSource implements MentionSource {
  readonly kind = 'x-api'

  constructor(
    private readonly bearerToken: string,
    private readonly userId: string,
    private readonly maxResults = 50,
  ) {}

  async fetchMentions(sinceUnix: number | null): Promise<Mention[]> {
    const url = new URL(`${BASE}/users/${this.userId}/mentions`)
    url.searchParams.set('max_results', String(Math.min(100, Math.max(5, this.maxResults))))
    url.searchParams.set('tweet.fields', 'created_at,author_id,referenced_tweets,attachments')
    url.searchParams.set('expansions', 'author_id,attachments.media_keys')
    url.searchParams.set('user.fields', 'username,name,created_at,public_metrics,profile_image_url')
    url.searchParams.set('media.fields', 'url,preview_image_url,type')
    /*
      ⚠ `start_time` is RFC3339 and is rejected if it is more than seven days back on this endpoint.
      It is also exclusive of nothing in particular: the caller still deduplicates by tweet id,
      because narrowing the window is a cost control, not a correctness mechanism.
    */
    if (sinceUnix) url.searchParams.set('start_time', new Date(sinceUnix * 1000).toISOString())

    const res = await fetch(url, { headers: { authorization: `Bearer ${this.bearerToken}` } })
    if (res.status === 429) {
      // ⚠ Surfaced as a plain error so the poll loop backs off rather than treating a rate limit as
      // "no mentions", which would look identical and would silently stop the product.
      throw new Error('x-api rate limited (429); the poll interval is below what this tier allows')
    }
    if (!res.ok) throw new Error(`x-api mentions returned ${res.status} ${await res.text().catch(() => '')}`)

    const body = (await res.json()) as {
      data?: RawTweet[]
      includes?: { users?: RawUser[]; media?: RawMedia[] }
    }

    const users = new Map<string, RawUser>()
    for (const u of body.includes?.users ?? []) if (u.id) users.set(u.id, u)

    const media = new Map<string, RawMedia>()
    for (const m of body.includes?.media ?? []) if (m.media_key) media.set(m.media_key, m)

    const out: Mention[] = []
    for (const t of body.data ?? []) {
      if (!t.id || typeof t.text !== 'string') continue
      const author = t.author_id ? users.get(t.author_id) : undefined
      const handle = author?.username ?? ''
      if (!handle) continue

      const key = t.attachments?.media_keys?.[0]
      const attached = key ? media.get(key) : undefined

      out.push({
        id: t.id,
        text: t.text,
        createdAt: parseXDate(t.created_at) ?? new Date(),
        authorHandle: handle,
        authorId: t.author_id ?? '',
        authorName: author?.name ?? handle,
        authorFollowers: author?.public_metrics?.followers_count ?? 0,
        authorCreatedAt: parseXDate(author?.created_at),
        authorAvatar: author?.profile_image_url ?? null,
        // `url` is present for photos; video and GIF carry only a preview, which XPoke declines.
        mediaUrl: attached?.type === 'photo' ? (attached.url ?? null) : null,
        inReplyToId: (t.referenced_tweets ?? []).find((r) => r.type === 'replied_to')?.id ?? null,
        isRetweet: (t.referenced_tweets ?? []).some((r) => r.type === 'retweeted'),
        url: `https://x.com/${handle}/status/${t.id}`,
      })
    }

    return out
  }
}

/** `GET /2/tweets/:id`, expanded to include its photo. */
export async function fetchXTweetMedia(bearerToken: string, tweetId: string): Promise<string | null> {
  const url = new URL(`${BASE}/tweets/${tweetId}`)
  url.searchParams.set('expansions', 'attachments.media_keys')
  url.searchParams.set('media.fields', 'url,type')

  const res = await fetch(url, { headers: { authorization: `Bearer ${bearerToken}` } })
  if (!res.ok) return null

  const body = (await res.json()) as { includes?: { media?: RawMedia[] } }
  // ⚠ Photos only. A video or GIF exposes a preview rather than `url`, and a thumbnail is not what
  // somebody attaching a clip is asking to see minted.
  return body.includes?.media?.find((m) => m.type === 'photo')?.url ?? null
}

export class XApiReplier implements Replier {
  readonly kind = 'x-api'

  /**
   * ⚠⚠ Posting is a user-context action. An app-only bearer token reads mentions perfectly well and
   * is rejected by `POST /2/tweets`, so this needs an OAuth 2.0 user access token for the account
   * itself. That is why a deploy can legitimately read through this provider and reply through
   * another.
   */
  constructor(
    private readonly userAccessToken: string,
    /** Only needed by `check:reply`, to find something of the account's own to reply to. */
    private readonly userId = '',
  ) {}

  async post(text: string): Promise<string | null> {
    return this.create({ text })
  }

  async reply(inReplyToId: string, text: string): Promise<string | null> {
    return this.create({ text, reply: { in_reply_to_tweet_id: inReplyToId } })
  }

  private async create(payload: unknown): Promise<string | null> {
    const res = await fetch(`${BASE}/tweets`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.userAccessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!res.ok) throw new Error(`x-api reply returned ${res.status} ${await res.text().catch(() => '')}`)
    const body = (await res.json()) as { data?: { id?: string } }
    return body.data?.id ?? null
  }

  /** `GET /2/users/:id/tweets`, newest first. Used only by `check:reply`. */
  async latestOwnTweet(): Promise<string | null> {
    if (!this.userId) return null

    const url = new URL(`${BASE}/users/${this.userId}/tweets`)
    url.searchParams.set('max_results', '5')

    const res = await fetch(url, { headers: { authorization: `Bearer ${this.userAccessToken}` } })
    if (!res.ok) throw new Error(`x-api user tweets returned ${res.status}`)

    const body = (await res.json()) as { data?: { id?: string }[] }
    return body.data?.[0]?.id ?? null
  }

  /** `DELETE /2/tweets/:id`. Used only by `check:reply`. */
  async deleteTweet(id: string): Promise<boolean> {
    const res = await fetch(`${BASE}/tweets/${id}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${this.userAccessToken}` },
    })
    if (!res.ok) return false
    const body = (await res.json()) as { data?: { deleted?: boolean } }
    return body.data?.deleted === true
  }
}
