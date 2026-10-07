/**
 * twitterapi.io, the cheap read path.
 *
 * Endpoints and field names below come from that service's own OpenAPI documents, read on
 * 12 Aug 2026, not from memory:
 *
 * - `GET  /twitter/user/mentions` — `userName`, `sinceTime`, `untilTime`, `cursor`; returns
 *   `{ tweets[], has_next_page, next_cursor, status, message }`
 * - `POST /twitter/create_tweet_v2` — `login_cookies`, `tweet_text`, `reply_to_tweet_id`, `proxy`
 *
 * ⚠ Authentication is an `X-API-Key` header, not a bearer token.
 */
import type { Mention, MentionSource, Replier } from './types.ts'
import { parseXDate } from './types.ts'

const BASE = 'https://api.twitterapi.io'

type RawUser = {
  userName?: string
  id?: string
  name?: string
  followers?: number
  createdAt?: string
  profilePicture?: string
}

type RawTweet = {
  id?: string
  url?: string
  text?: string
  createdAt?: string
  author?: RawUser
  retweeted_tweet?: unknown
  inReplyToId?: string
  entities?: { media?: { media_url_https?: string; type?: string }[] }
  extendedEntities?: { media?: { media_url_https?: string; type?: string }[] }
}

/**
 * Pulls the best image out of a tweet.
 *
 * ⚠ Media lives under `extendedEntities` on tweets with more than one attachment and under
 * `entities` on some single-image tweets, and the documented Tweet schema names neither as
 * guaranteed. Both are checked, and a tweet with no image is a tweet with no image rather than an
 * error: the launcher falls back to the author's avatar.
 *
 * ⚠ Video and GIF entries are skipped. Their `media_url_https` is a thumbnail, which is fine to
 * show but is not what somebody attaching a GIF is asking for, so XPoke takes photos only and
 * treats the rest as no image.
 */
function pickMedia(t: RawTweet): string | null {
  const pools = [t.extendedEntities?.media, t.entities?.media]
  for (const pool of pools) {
    if (!Array.isArray(pool)) continue
    for (const m of pool) {
      if (m?.media_url_https && (!m.type || m.type === 'photo')) return m.media_url_https
    }
  }
  return null
}

function toMention(t: RawTweet): Mention | null {
  if (!t?.id || typeof t.text !== 'string') return null
  const author = t.author ?? {}
  const handle = author.userName ?? ''
  if (!handle) return null

  return {
    id: String(t.id),
    text: t.text,
    createdAt: parseXDate(t.createdAt) ?? new Date(),
    authorHandle: handle,
    authorId: author.id ? String(author.id) : '',
    authorName: author.name ?? handle,
    authorFollowers: Number.isFinite(author.followers) ? Number(author.followers) : 0,
    authorCreatedAt: parseXDate(author.createdAt),
    authorAvatar: author.profilePicture ?? null,
    mediaUrl: pickMedia(t),
    inReplyToId: t.inReplyToId ? String(t.inReplyToId) : null,
    isRetweet: Boolean(t.retweeted_tweet),
    url: t.url ?? `https://x.com/${handle}/status/${t.id}`,
  }
}

export class TwitterApiIoSource implements MentionSource {
  readonly kind = 'twitterapi.io'

  constructor(
    private readonly apiKey: string,
    private readonly handle: string,
    /** ⚠ One page is 20 mentions. XPoke reads a couple so a burst is not silently truncated. */
    private readonly maxPages = 3,
  ) {}

  async fetchMentions(sinceUnix: number | null): Promise<Mention[]> {
    const out: Mention[] = []
    let cursor = ''

    for (let page = 0; page < this.maxPages; page += 1) {
      const url = new URL('/twitter/user/mentions', BASE)
      url.searchParams.set('userName', this.handle)
      if (sinceUnix) url.searchParams.set('sinceTime', String(sinceUnix))
      if (cursor) url.searchParams.set('cursor', cursor)

      const res = await fetch(url, { headers: { 'X-API-Key': this.apiKey } })
      if (!res.ok) throw new Error(`twitterapi.io mentions returned ${res.status} ${await res.text().catch(() => '')}`)

      const body = (await res.json()) as {
        tweets?: RawTweet[]
        has_next_page?: boolean
        next_cursor?: string
        status?: string
        message?: string
      }
      if (body.status === 'error') throw new Error(`twitterapi.io: ${body.message ?? 'unknown error'}`)

      for (const raw of body.tweets ?? []) {
        const m = toMention(raw)
        if (m) out.push(m)
      }

      /*
        ⚠ The provider documents that `has_next_page` can read true when no further data exists,
        so the empty-cursor check is what actually ends the loop rather than the flag alone.
      */
      if (!body.has_next_page || !body.next_cursor) break
      cursor = body.next_cursor
    }

    return out
  }

  /** `GET /twitter/tweets`, which returns the same Tweet shape the mentions endpoint does. */
  async fetchTweetMedia(tweetId: string): Promise<string | null> {
    return (await this.fetchTweet(tweetId))?.mediaUrl ?? null
  }

  /**
   * One post, by id, as a full mention.
   *
   * ⭐ The same `GET /twitter/tweets` lookup and the same mapper the mentions index goes through, so
   * a post named by hand becomes exactly the row polling would have produced. That is the point:
   * naming a post is a different way of *finding* it, not a different way of handling it.
   */
  async fetchMentionById(tweetId: string): Promise<Mention | null> {
    const url = new URL('/twitter/tweets', BASE)
    url.searchParams.set('tweet_ids', tweetId)

    const res = await fetch(url, { headers: { 'X-API-Key': this.apiKey } })
    if (!res.ok) throw new Error(`twitterapi.io tweets returned ${res.status}`)

    const body = (await res.json()) as { tweets?: RawTweet[]; data?: RawTweet[]; status?: string; message?: string }
    if (body.status === 'error') throw new Error(`twitterapi.io: ${body.message ?? 'unknown error'}`)

    const tweet = (body.tweets ?? body.data ?? [])[0]
    return tweet ? toMention(tweet) : null
  }

  /**
   * One post, by id. `GET /twitter/tweets`, which returns the same Tweet shape mentions arrive in.
   *
   * ⭐ The picture and the author come back in the same response, so a launch that replies to
   * somebody's post pays for one read rather than two: the picture becomes the token's logo and the
   * author's handle builds the link the token carries.
   */
  async fetchTweet(tweetId: string): Promise<{ mediaUrl: string | null; authorHandle: string | null } | null> {
    const url = new URL("/twitter/tweets", BASE)
    url.searchParams.set("tweet_ids", tweetId)

    const res = await fetch(url, { headers: { "X-API-Key": this.apiKey } })
    if (!res.ok) return null

    const body = (await res.json()) as { tweets?: RawTweet[]; status?: string }
    if (body.status === "error") return null

    const tweet = body.tweets?.[0]
    if (!tweet) return null

    return { mediaUrl: pickMedia(tweet), authorHandle: tweet.author?.userName ? String(tweet.author.userName) : null }
  }
}

export class TwitterApiIoReplier implements Replier {
  readonly kind = 'twitterapi.io'

  constructor(
    private readonly apiKey: string,
    /** The blob from `/twitter/user_login_v2`. Held only in memory, never logged. */
    private readonly loginCookie: string,
    private readonly proxy: string,
    /** Only needed by `check:reply`, to find something of the account's own to reply to. */
    private readonly handle = '',
  ) {}

  /**
   * The account's own most recent post.
   *
   * `GET /twitter/user/last_tweets`, which pages 20 at a time newest first.
   *
   * ⚠ The response has carried the array at two different depths across versions of this API, so
   * both are read rather than the one that happened to be documented today.
   *
   * ⚠⚠ An empty timeline does **not** mean the account has never posted. `last_tweets` lags badly
   * on a small account — an account that had posted once, and pinned it, still came
   * back empty a day later. That reads as "you have nothing to reply to" and stops `check:reply`
   * dead, which is a false negative on the one check that stands between a working reply path and
   * launches that tell nobody. So a blank timeline falls through to the profile below.
   */
  async latestOwnTweet(): Promise<string | null> {
    if (!this.handle) return null

    const url = new URL('/twitter/user/last_tweets', BASE)
    url.searchParams.set('userName', this.handle)

    const res = await fetch(url, { headers: { 'X-API-Key': this.apiKey } })
    if (!res.ok) throw new Error(`twitterapi.io last_tweets returned ${res.status}`)

    const body = (await res.json()) as { data?: { tweets?: RawTweet[] }; tweets?: RawTweet[]; status?: string; message?: string }
    if (body.status === 'error') throw new Error(`twitterapi.io: ${body.message ?? 'unknown error'}`)

    const tweets = body.data?.tweets ?? body.tweets ?? []
    if (tweets[0]?.id) return String(tweets[0].id)

    return await this.pinnedTweet()
  }

  /**
   * The account's pinned post, read off the profile.
   *
   * ⭐ The profile is indexed immediately where the timeline is not, and it carries the pinned id
   * outright, so this answers for an account whose only post went up minutes ago.
   *
   * ⚠ It returns null rather than throwing on a bad response. It is a fallback for a path that has
   * already come up empty, and turning that into an error would replace a soft "nothing found"
   * with a hard failure on the primary check.
   */
  private async pinnedTweet(): Promise<string | null> {
    const url = new URL('/twitter/user/info', BASE)
    url.searchParams.set('userName', this.handle)

    try {
      const res = await fetch(url, { headers: { 'X-API-Key': this.apiKey } })
      if (!res.ok) return null

      const body = (await res.json()) as { data?: { pinnedTweetIds?: unknown[] } }
      const pinned = body.data?.pinnedTweetIds?.[0]
      return pinned ? String(pinned) : null
    } catch {
      return null
    }
  }

  /**
   * Who wrote one post. `GET /twitter/tweets`, the same lookup the parent-image path uses.
   *
   * ⭐ Reads by id rather than from a timeline, which is the point: a post is retrievable this way
   * within seconds of going up, while `last_tweets` can lag it by hours on a small account.
   */
  async tweetAuthor(id: string): Promise<string | null> {
    const url = new URL('/twitter/tweets', BASE)
    url.searchParams.set('tweet_ids', id)

    const res = await fetch(url, { headers: { 'X-API-Key': this.apiKey } })
    if (!res.ok) throw new Error(`twitterapi.io tweets returned ${res.status}`)

    const body = (await res.json()) as { tweets?: RawTweet[]; data?: RawTweet[]; status?: string; message?: string }
    if (body.status === 'error') throw new Error(`twitterapi.io: ${body.message ?? 'unknown error'}`)

    const tweet = (body.tweets ?? body.data ?? [])[0]
    return tweet?.author?.userName ? String(tweet.author.userName) : null
  }

  /** `POST /twitter/delete_tweet_v2`. Used only by `check:reply`. */
  async deleteTweet(id: string): Promise<boolean> {
    const res = await fetch(`${BASE}/twitter/delete_tweet_v2`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ login_cookies: this.loginCookie, tweet_id: id, proxy: this.proxy }),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { status?: string }
    return body.status !== 'error'
  }

  async post(text: string): Promise<string | null> {
    return this.create(text, null)
  }

  async reply(inReplyToId: string, text: string): Promise<string | null> {
    return this.create(text, inReplyToId)
  }

  private async create(text: string, inReplyToId: string | null): Promise<string | null> {
    const res = await fetch(`${BASE}/twitter/create_tweet_v2`, {
      method: 'POST',
      headers: { 'X-API-Key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        login_cookies: this.loginCookie,
        tweet_text: text,
        ...(inReplyToId ? { reply_to_tweet_id: inReplyToId } : {}),
        proxy: this.proxy,
      }),
    })

    if (!res.ok) throw new Error(`twitterapi.io reply returned ${res.status} ${await res.text().catch(() => '')}`)

    const body = (await res.json()) as { status?: string; message?: string; data?: { create_tweet?: { tweet_id?: string } }; tweet_id?: string }
    if (body.status === 'error') throw new Error(`twitterapi.io reply: ${body.message ?? 'unknown error'}`)

    // ⚠ The id's position in the response has moved between versions of this API, so both known
    // shapes are read and a missing id is reported as "posted, id unknown" rather than as a failure.
    return body.data?.create_tweet?.tweet_id ?? body.tweet_id ?? null
  }
}
