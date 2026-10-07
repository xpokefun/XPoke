/**
 * Signing in with X, and staying signed in.
 *
 * OAuth 2.0 authorization code flow with PKCE, against endpoints read from X's own documentation:
 *
 * - authorize `https://x.com/i/oauth2/authorize`
 * - token     `https://api.x.com/2/oauth2/token`
 * - identity  `GET https://api.x.com/2/users/me`
 *
 * Signing in proves which X account somebody is, so /me shows their Pokémon and lets them manage
 * boxes, trades and wagers. It never moves tokens: payouts go to the address a payment came from.
 *
 * ⚠ The account id is the identity, never the handle. Handles can be changed and re-registered.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
export interface Store {
  putOAuthPending(state: string, verifier: string, ttlSeconds: number): void
  takeOAuthPending(state: string): { state: string; verifier: string } | null
  putSession(id: string, user: XUser, ttlSeconds: number): void
}

const AUTHORIZE_URL = 'https://x.com/i/oauth2/authorize'
const TOKEN_URL = 'https://api.x.com/2/oauth2/token'
const ME_URL = 'https://api.x.com/2/users/me'

/**
 * ⚠ `users.read` is what identifies the account, and X requires `tweet.read` alongside it.
 * `offline.access` is deliberately absent: XPoke never acts on a user's behalf, so a refresh token
 * would be a credential held for no reason.
 */
const SCOPES = 'users.read tweet.read'

export const SESSION_COOKIE = 'xpoke_session'
/** Thirty days. Long enough not to nag, short enough that a forgotten session expires. */
export const SESSION_TTL_SECONDS = 30 * 24 * 3600
/** A login has ten minutes to complete before its state is useless. */
const PENDING_TTL_SECONDS = 600

export type XUser = {
  id: string
  handle: string
  name: string
  avatar: string | null
}

/** URL-safe randomness for state, verifier and session ids. */
function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

/** PKCE S256: the challenge is the SHA-256 of the verifier, base64url encoded. */
export function codeChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url')
}

/**
 * ⚠ Constant time, and length-checked first because `timingSafeEqual` throws on a length mismatch.
 * The state is a CSRF defence, and comparing it with `===` leaks how much of it a guess got right.
 */
export function safeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

export type AuthConfig = {
  clientId: string
  clientSecret: string
  /** Must match the callback registered on the X app exactly, character for character. */
  redirectUri: string
}

export class XAuth {
  constructor(
    private readonly config: AuthConfig,
    private readonly store: Store,
  ) {}

  get configured(): boolean {
    return Boolean(this.config.clientId && this.config.redirectUri)
  }

  /**
   * Begins a login.
   *
   * ⚠⚠ The verifier is kept **server side**, keyed by the state, and never sent to the browser.
   * Putting it in a cookie would hand the second half of PKCE to anyone who could read one.
   */
  begin(): { url: string; state: string } {
    const state = randomToken()
    const verifier = randomToken(48)

    this.store.putOAuthPending(state, verifier, PENDING_TTL_SECONDS)

    const url = new URL(AUTHORIZE_URL)
    url.searchParams.set('response_type', 'code')
    url.searchParams.set('client_id', this.config.clientId)
    url.searchParams.set('redirect_uri', this.config.redirectUri)
    url.searchParams.set('scope', SCOPES)
    url.searchParams.set('state', state)
    url.searchParams.set('code_challenge', codeChallengeOf(verifier))
    url.searchParams.set('code_challenge_method', 'S256')

    return { url: url.toString(), state }
  }

  /**
   * Completes a login and returns who signed in.
   *
   * ⚠ The state is consumed whatever happens next, so a code cannot be replayed against it and a
   * pending login cannot be reused.
   */
  async complete(code: string, state: string): Promise<{ user: XUser; sessionId: string }> {
    const pending = this.store.takeOAuthPending(state)
    if (!pending) throw new Error('that sign in link has expired or was already used')
    if (!safeEquals(pending.state, state)) throw new Error('sign in state did not match')

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      code_verifier: pending.verifier,
    })

    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
    /*
      ⚠ A confidential client authenticates with HTTP Basic. X rejects the secret in the body, so
      apps configured as confidential fail with an unhelpful `invalid_client` if it is put there.
      An app with no secret is a public client and relies on PKCE alone, which is why PKCE is not
      optional here.
    */
    if (this.config.clientSecret) {
      const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString('base64')
      headers.authorization = `Basic ${basic}`
    }

    const tokenRes = await fetch(TOKEN_URL, { method: 'POST', headers, body })
    if (!tokenRes.ok) {
      throw new Error(`X refused the sign in (${tokenRes.status}) ${await tokenRes.text().catch(() => '')}`)
    }

    const token = (await tokenRes.json()) as { access_token?: string }
    if (!token.access_token) throw new Error('X returned no access token')

    const meRes = await fetch(`${ME_URL}?user.fields=profile_image_url`, {
      headers: { authorization: `Bearer ${token.access_token}` },
    })
    if (!meRes.ok) throw new Error(`could not read the X account (${meRes.status})`)

    const me = (await meRes.json()) as {
      data?: { id?: string; username?: string; name?: string; profile_image_url?: string }
    }
    if (!me.data?.id || !me.data.username) throw new Error('X returned an account with no id')

    const user: XUser = {
      id: me.data.id,
      handle: me.data.username,
      name: me.data.name ?? me.data.username,
      /*
        ⚠ `_normal` is 48 pixels. Fine beside a menu item, and the same rewrite the logo path uses.
      */
      avatar: me.data.profile_image_url?.replace(/_normal\.(jpg|jpeg|png|gif|webp)$/i, '_400x400.$1') ?? null,
    }

    /*
      ⚠⚠ The access token is used once, here, and then dropped. XPoke has no reason to act as the
      user afterwards, and a stored token is a credential that can leak. Only the identity is kept.
    */
    const sessionId = randomToken()
    this.store.putSession(sessionId, user, SESSION_TTL_SECONDS)

    return { user, sessionId }
  }
}

/**
 * Reads a cookie header.
 *
 * ⚠ Splits on the first `=` only. A cookie value can contain `=` (base64url does not, but the next
 * value stored here might), and splitting on every one silently truncates it.
 */
export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null
  for (const part of header.split(';')) {
    const trimmed = part.trim()
    const eq = trimmed.indexOf('=')
    if (eq < 1) continue
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1))
  }
  return null
}

/**
 * The `Set-Cookie` for a session.
 *
 * - `HttpOnly` so script cannot read it, which is what stops an XSS from becoming a stolen account.
 * - `SameSite=Lax` so it survives the redirect back from X but is not sent on cross-site posts.
 * - `Secure` whenever the site is served over https.
 */
export function sessionCookie(sessionId: string | null, secure: boolean): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', ...(secure ? ['Secure'] : [])]
  return sessionId
    ? `${SESSION_COOKIE}=${sessionId}; ${flags.join('; ')}; Max-Age=${SESSION_TTL_SECONDS}`
    : `${SESSION_COOKIE}=; ${flags.join('; ')}; Max-Age=0`
}
