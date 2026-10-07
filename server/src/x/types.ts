/**
 * The shape XPoke works in, and the two interfaces every X provider implements.
 *
 * ⭐ Why an interface rather than a client: X's own API went pay-per-use in February 2026 with no
 * free tier, at roughly $0.005 a read and a repriced $0.20 for a post carrying a URL, while
 * third-party mirrors sell the same reads for a fraction of that. Which one XPoke runs on is an
 * operating decision that will change, so it is a setting rather than a rewrite. The `fixture`
 * provider then makes the whole pipeline testable with no account, no key and no spend.
 */

export type Mention = {
  /** X's tweet id. The idempotency key for the entire system. */
  id: string
  text: string
  createdAt: Date
  authorHandle: string
  authorId: string
  authorName: string
  authorFollowers: number
  authorCreatedAt: Date | null
  authorAvatar: string | null
  /** Direct image URL from any media attached to the tweet, before XPoke mirrors it. */
  mediaUrl: string | null
  /**
   * The post this one replies to, if any.
   *
   * ⭐ Load-bearing for logos. The common way to use a bot like this is to find an image somebody
   * else posted and reply to it, so the picture that should become the token is usually on the
   * PARENT post rather than on the mention itself.
   */
  inReplyToId: string | null
  isRetweet: boolean
  url: string
}

export interface MentionSource {
  readonly kind: string
  /**
   * Newest-first mentions of the account.
   *
   * @param sinceUnix only mentions at or after this second, when the provider supports it.
   *
   * ⚠ Implementations return what they get and do no deduplication. The caller owns that, because
   * the caller is the only layer that knows what has already been launched.
   */
  fetchMentions(sinceUnix: number | null): Promise<Mention[]>

  /**
   * The image attached to one specific post.
   *
   * ⚠ Optional, and called only when a mention replies to something and carries no image of its
   * own, so it costs one extra read on exactly the posts that need it and nothing on the rest.
   */
  fetchTweetMedia?(tweetId: string): Promise<string | null>

  /**
   * One post, by id: its picture and who wrote it.
   *
   * ⭐ One read for both, because both are wanted about the same post. A launch that replies to
   * somebody's picture takes the picture from it *and* links the token to it, and asking twice
   * would bill twice for one answer.
   *
   * ⚠ Optional. A source that cannot do this falls back to {@link fetchTweetMedia}, and the token
   * links to the mention itself rather than to the post it replied to.
   */
  fetchTweet?(tweetId: string): Promise<{ mediaUrl: string | null; authorHandle: string | null } | null>

  /**
   * One post, by id, as a full mention.
   *
   * ⭐⭐ The reliable way to find a post. The mentions index is not complete: a launch request posted
   * as a reply from a small account was absent from both `user/mentions` and advanced search fifteen
   * minutes later, while this lookup returned it immediately. That gap is somebody asking XPoke for a
   * token and hearing nothing, so `npm run ingest` exists to name a post directly — and everything
   * after the lookup is the ordinary path, guards included.
   *
   * ⚠ Optional, like the rest. A source that cannot do this simply has no ingest command.
   */
  fetchMentionById?(tweetId: string): Promise<Mention | null>
}

export interface Replier {
  readonly kind: string
  /** @returns the new tweet's id, or null when the provider posted nothing. */
  reply(inReplyToId: string, text: string): Promise<string | null>

  /** A standalone post (tournament results). Optional: a provider without it simply skips them. */
  post?(text: string): Promise<string | null>

  /**
   * The account's own most recent post.
   *
   * ⚠ Optional, and used only by `check:reply`. XPoke itself never needs this: it replies to
   * mentions, which arrive with their own ids.
   */
  latestOwnTweet?(): Promise<string | null>

  /**
   * Removes a post.
   *
   * ⚠⚠ Optional, and used only by `check:reply`, which posts a probe and takes it down again.
   * **Nothing in XPoke's running path deletes anything**, deliberately: a bot that can delete is a
   * bot whose bug can delete, and there is no reason for the launcher to hold that power.
   */
  deleteTweet?(id: string): Promise<boolean>

  /**
   * Who posted one specific post, as a handle without the `@`.
   *
   * ⚠ Optional, and used only by `check:reply --to`, to prove a named post belongs to the account
   * before replying to it. A provider that cannot answer this makes `--to` unavailable rather than
   * unchecked: the probe posts publicly, and "probably ours" is not good enough for that.
   */
  tweetAuthor?(id: string): Promise<string | null>
}

/** Used when XPoke runs without write access to the account. Replies are recorded, not posted. */
export class NoReplier implements Replier {
  readonly kind = 'none'
  async reply(): Promise<string | null> {
    return null
  }
}

/**
 * X serves dates as `Tue Dec 10 07:00:30 +0000 2024`, which `new Date()` parses, and ISO 8601,
 * which it also parses. Anything else becomes null rather than an Invalid Date that survives
 * several layers before failing somewhere unrelated.
 */
export function parseXDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !value.trim()) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}
