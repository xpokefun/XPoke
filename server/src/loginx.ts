/**
 * Mints the login cookie that lets XPoke reply as its own account, and writes it to `.env`.
 *
 * ```
 * npm run login:x
 * ```
 *
 * ## Why this is a script rather than a curl command
 *
 * twitterapi.io's `/twitter/user_login_v2` wants the account's email, password and 2FA secret. Typed
 * into a terminal those land in shell history; pasted into a chat they land in a transcript. Here
 * they are prompted for, sent once, and never written anywhere: only the **cookie** that comes back
 * is stored, and that is the thing XPoke actually needs.
 *
 * ⚠ The password is read with echo off, so it does not appear on screen either.
 *
 * ⚠⚠ The cookie expires. When replies stop (the agent log shows Command instead of Replied for everyone) and
 * running this again is the fix.
 */
import { createInterface } from 'node:readline/promises'
import { readFile, writeFile } from 'node:fs/promises'
import { stdin, stdout } from 'node:process'

const BASE = 'https://api.twitterapi.io'
const ENV_PATH = '.env'

/** Reads a line without echoing it. */
async function secret(prompt: string): Promise<string> {
  stdout.write(prompt)

  const wasRaw = stdin.isRaw
  stdin.setRawMode?.(true)
  stdin.resume()

  let value = ''
  await new Promise<void>((resolve) => {
    const onData = (chunk: Buffer) => {
      const char = chunk.toString('utf8')
      // Enter, or Ctrl-C / Ctrl-D.
      if (char === '\r' || char === '\n') {
        stdin.removeListener('data', onData)
        resolve()
        return
      }
      // ⚠ Escaped, never literal: a raw control byte in a source file is invisible in an editor
      // and does not survive copy-paste intact.
      if (char === '\u0003' || char === '\u0004') {
        stdout.write('\n')
        process.exit(1)
      }
      if (char === '\u007f' || char === '\b') {
        value = value.slice(0, -1)
        return
      }
      value += char
    }
    stdin.on('data', onData)
  })

  stdin.setRawMode?.(Boolean(wasRaw))
  stdin.pause()
  stdout.write('\n')
  return value
}

/**
 * Replaces one line in `.env`, leaving every other line exactly as it was.
 *
 * ⚠ Rewritten by line rather than parsed and re-serialised. A parser would drop the comments, and
 * the comments in that file are the only place several of these settings are explained.
 */
async function setEnv(key: string, value: string) {
  let text = ''
  try {
    text = await readFile(ENV_PATH, 'utf8')
  } catch {
    throw new Error(`${ENV_PATH} not found. Run this from the server directory.`)
  }

  const lines = text.split('\n')
  const index = lines.findIndex((l) => l.startsWith(`${key}=`))

  if (index >= 0) lines[index] = `${key}=${value}`
  else lines.push(`${key}=${value}`)

  await writeFile(ENV_PATH, lines.join('\n'))
}

async function main() {
  const apiKey = process.env.TWITTERAPI_IO_KEY?.trim()
  if (!apiKey) {
    console.error('\nTWITTERAPI_IO_KEY is not set in .env. Add it first, then run this again.\n')
    process.exit(1)
  }

  console.log('\nMinting a reply cookie for XPoke (@xpokefun)\n')
  console.log('  This signs in to your account through twitterapi.io so XPoke can reply as it.')
  console.log('  Nothing you type here is stored or logged. Only the cookie that comes back is kept.\n')

  const rl = createInterface({ input: stdin, output: stdout })
  const userName = (await rl.question('  handle, without the @  : ')).trim().replace(/^@/, '')
  const email = (await rl.question('  email                  : ')).trim()
  rl.close()

  const password = await secret('  password               : ')
  /*
    ⚠ The base32 seed from the authenticator app, not the six digits it is showing. twitterapi.io
    is explicit that a login without 2FA often yields a cookie that cannot post, which surfaces much
    later as replies silently failing.
  */
  const totpSecret = await secret('  2FA secret, base32     : ')
  const proxy = (process.env.TWITTERAPI_IO_PROXY ?? '').trim()

  if (!proxy) {
    console.log('\n  ⚠ TWITTERAPI_IO_PROXY is empty. Their reply endpoint requires a residential proxy,')
    console.log('    so replies will fail until it is set. The login itself may still work.\n')
  }

  console.log('\n  signing in\n')

  const res = await fetch(`${BASE}/twitter/user_login_v2`, {
    method: 'POST',
    headers: { 'X-API-Key': apiKey, 'content-type': 'application/json' },
    body: JSON.stringify({ user_name: userName, email, password, totp_secret: totpSecret, proxy }),
  })

  if (!res.ok) {
    console.error(`  the login was refused (${res.status}) ${await res.text().catch(() => '')}\n`)
    process.exit(1)
  }

  const body = (await res.json()) as { status?: string; message?: string; login_cookies?: string; login_cookie?: string }
  if (body.status === 'error') {
    console.error(`  the login was refused: ${body.message ?? 'unknown error'}\n`)
    process.exit(1)
  }

  // ⚠ Both spellings are read: the field has been named each way across versions of this API.
  const cookie = body.login_cookies ?? body.login_cookie
  if (!cookie) {
    console.error('  no cookie came back. The response shape may have moved.\n')
    process.exit(1)
  }

  await setEnv('TWITTERAPI_IO_LOGIN_COOKIE', cookie)
  await setEnv('X_REPLY', 'twitterapi.io')

  console.log(`  ok. Wrote a ${cookie.length} character cookie to .env and set X_REPLY=twitterapi.io.`)
  console.log('\n  Now: systemctl restart xpoke, then reply "help" to an @xpokefun post and watch https://xpoke.fun/agent\n')
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
