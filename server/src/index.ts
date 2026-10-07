/**
 * XPoke server: the X agent, the chain watcher, the payout sender, housekeeping, and the site.
 */
import { join } from 'node:path'
import { loadConfig, type Config } from './config.ts'
import { openDb, tx, now } from './db.ts'
import { FixtureSource, MemoryReplier } from './x/fixture.ts'
import { XApiReplier, XApiSource } from './x/official.ts'
import { TwitterApiIoReplier, TwitterApiIoSource } from './x/twitterapiio.ts'
import { NoReplier, type MentionSource, type Replier } from './x/types.ts'
import { Agent } from './llm.ts'
import { announce, startPolling, startReplyLoop, type Deps } from './agent.ts'
import { startApi } from './api.ts'
import { chainStatus, makeSolana, resolveToken, scanOnce, sendOnce } from './pay/solana.ts'
import { pullOnce } from './pay/pull.ts'
import { expireChallenges } from './game/engine.ts'
import { expireWagers } from './game/wager.ts'
import { expireTrades } from './game/trade.ts'

function buildSource(cfg: Config): MentionSource {
  switch (cfg.source) {
    case 'twitterapi.io':
      return new TwitterApiIoSource(cfg.twitterApiIoKey, cfg.handle, 10)
    case 'x-api':
      return new XApiSource(cfg.xBearerToken, cfg.xUserId)
    default:
      return new FixtureSource(join(cfg.dataDir, 'mentions.json'))
  }
}

function buildReplier(cfg: Config): Replier {
  if (cfg.dryRun) return new MemoryReplier()
  switch (cfg.reply) {
    case 'twitterapi.io':
      return new TwitterApiIoReplier(cfg.twitterApiIoKey, cfg.twitterApiIoLoginCookie, cfg.twitterApiIoProxy, cfg.handle)
    case 'x-api':
      return new XApiReplier(cfg.xBearerToken, cfg.xUserId)
    default:
      return new NoReplier()
  }
}

const cfg = loadConfig()
const db = openDb(cfg.dataDir)
const chain = makeSolana(cfg)
chainStatus.pool = chain.pool
chainStatus.token = cfg.tokenMint
chainStatus.enabled = Boolean(cfg.tokenMint && chain.pool)
chainStatus.payouts = Boolean(cfg.payoutsEnabled && chain.keypair && cfg.tokenMint)
if (chainStatus.enabled) resolveToken(chain).catch((e) => (chainStatus.lastError = `token: ${(e as Error).message}`))

const deps: Deps = {
  db,
  cfg,
  source: buildSource(cfg),
  replier: buildReplier(cfg),
  agent: cfg.llmEnabled ? new Agent({ apiKey: cfg.llmKey || undefined, authToken: cfg.llmAuthToken || undefined, baseURL: cfg.llmBaseUrl || undefined, model: cfg.llmModel }) : null,
}

console.log(`[xpoke] @${cfg.handle} · source ${deps.source.kind} · replies ${deps.replier.kind} · mint ${cfg.tokenMint || 'unset'} · pool ${chain.pool || 'unset'} · payouts ${cfg.payoutsEnabled ? 'ON' : 'off'}`)

startApi(deps, chain)
if (cfg.source !== 'fixture' || process.env.POLL_FIXTURE === '1') startPolling(deps)
startReplyLoop(deps)

// housekeeping: expiries every 30s
setInterval(() => {
  try {
    tx(db, () => {
      expireChallenges(db)
      expireWagers(db)
      expireTrades(db)
      db.prepare("update orders set status = 'expired' where status = 'pending' and expires_at <= ?").run(now())
      db.prepare('delete from sessions where expires_at <= ?').run(now())
    })
  } catch (e) {
    console.error('[housekeeping]', e)
  }
}, 30_000)

// Solana: scan the pool's token account, send queued payouts one at a time
if (chainStatus.enabled) {
  // A cheap 2 s heartbeat decides when to touch the chain: scan every 10 s while somebody owes a payment
  // (so a new order or an accepted wager is picked up within seconds, not after an idle sleep), otherwise
  // every 2 minutes; send whenever something is queued, back to back while there is more.
  const owed = () =>
    Boolean(
      db.prepare("select 1 from orders where status = 'pending' limit 1").get() ||
        db.prepare("select 1 from wagers where status = 'awaiting_payment' limit 1").get(),
    )
  const queued = () => Boolean(db.prepare("select 1 from ledger where status in ('pending','signed') and kind != 'payment' limit 1").get())
  const pulling = () => Boolean(db.prepare("select 1 from pulls where status in ('pending','signed') limit 1").get())
  let lastScan = 0
  let lastSend = 0
  let busy = false
  setInterval(async () => {
    if (busy) return
    busy = true
    try {
      const t = Date.now()
      if (t - lastScan >= (owed() ? 10_000 : 120_000)) {
        lastScan = t
        try {
          for (const line of await scanOnce(db, cfg, chain)) await announce(deps, line)
        } catch (e) {
          chainStatus.lastError = (e as Error).message.slice(0, 200)
        }
      }
      if (pulling() && cfg.payoutsEnabled) {
        try {
          let moved = false
          for (let i = 0; i < 10 && (await pullOnce(db, cfg, chain)); i++) moved = true
          if (moved) lastScan = 0 // a pull just landed or was skipped: look for it right away
        } catch (e) {
          chainStatus.lastError = `pull: ${(e as Error).message.slice(0, 200)}`
        }
      }
      if (queued() && Date.now() - lastSend >= 2_000) {
        lastSend = Date.now()
        try {
          // drain: keep sending while each call made progress, up to ~20 s per beat
          for (let i = 0; i < 10 && (await sendOnce(db, cfg, chain)); i++);
        } catch (e) {
          chainStatus.lastError = `send: ${(e as Error).message.slice(0, 200)}`
        }
      }
    } catch (e) {
      console.error('[chain] heartbeat', e)
    } finally {
      busy = false
    }
  }, 2_000)
}
