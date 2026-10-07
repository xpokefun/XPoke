/**
 * The website's API, plus X sign-in and the built site itself.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { type DB, getMeta, now, tx } from './db.ts'
import { XAuth, readCookie, safeEquals, sessionCookie, SESSION_COOKIE, type Store, type XUser } from './auth.ts'
import { CATCHABLE, SPECIES, species, spriteId } from './game/data.ts'
import {
  allMons,
  ensureTrainer,
  getMon,
  getTrainer,
  lockedIds,
  monView,
  moveMon,
  refreshFreeBalls,
  monsAt,
  party,
  sp,
  trainerByHandle,
  type Mon,
  type Trainer,
} from './game/store.ts'
import { BALLS, GYMS, PARTY_MAX, ORDER_WINDOW, TOURNAMENT_SIZE, trainerLevel, TRAINER_LEVELS } from './game/rules.ts'
import { gymFighter } from './game/engine.ts'
import { activeWagerOf, cancelWagerBy, getWager, wagerView, TOKEN, type Wager } from './game/wager.ts'
import { resolveTrade, expireTrades, type Trade } from './game/trade.ts'
import { createTournament, entries, joinTournament, openTournament, type Tournament } from './game/tournament.ts'
import { roundAmount, showAmount, toWei, uniqueAmount, TOKEN_DECIMALS } from './pay/amounts.ts'
import { buildAllowance, buildPayment, chainStatus, checkTx, EXPLORER, isAddress, isSignature, poolBalances, resolveToken, scanOnce, type Sol } from './pay/solana.ts'
import { xStatus, processMention, announce, usage, type Deps } from './agent.ts'
import { completeLink, createChallenge, unlink, WalletError } from './wallet.ts'
import { allowanceOf } from './pay/pull.ts'

type Req = IncomingMessage & { body?: unknown }
type Handler = (req: Req, res: ServerResponse, params: Record<string, string>, url: URL) => Promise<unknown> | unknown

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

export function sessionStore(db: DB): Store & { getSession(id: string): XUser | null; dropSession(id: string): void } {
  return {
    putOAuthPending(state, verifier, ttl) {
      db.prepare('insert or replace into oauth_pending (state, verifier, expires_at) values (?,?,?)').run(state, verifier, now() + ttl * 1000)
    },
    takeOAuthPending(state) {
      const r = db.prepare('select * from oauth_pending where state = ? and expires_at > ?').get(state, now()) as
        | { state: string; verifier: string }
        | undefined
      db.prepare('delete from oauth_pending where state = ?').run(state)
      return r ?? null
    },
    putSession(id, user, ttl) {
      db.prepare('insert or replace into sessions (id, user, expires_at) values (?,?,?)').run(id, JSON.stringify(user), now() + ttl * 1000)
    },
    getSession(id) {
      const r = db.prepare('select user from sessions where id = ? and expires_at > ?').get(id, now()) as { user: string } | undefined
      return r ? (JSON.parse(r.user) as XUser) : null
    },
    dropSession(id) {
      db.prepare('delete from sessions where id = ?').run(id)
    },
  }
}

function intParam(url: URL, name: string, dflt: number, max: number): number {
  const n = Number(url.searchParams.get(name))
  return Number.isInteger(n) && n > 0 ? Math.min(max, n) : dflt
}

/** Remembers a value for `ms`; expensive reads behind public endpoints go through this. */
function memo<T>(ms: number, fn: () => Promise<T>): () => Promise<T> {
  let at = 0
  let value: Promise<T> | null = null
  return () => {
    if (!value || Date.now() - at > ms) {
      at = Date.now()
      value = fn().catch((e) => {
        value = null // a failure is not cached
        throw e
      })
    }
    return value
  }
}

/**
 * GET endpoints whose answer is the same for every visitor, and for how long (ms) it may be shared.
 * ⛔ Never list anything that reads the session (/api/me, /auth/*) or takes an action.
 */
const PUBLIC_TTL: [RegExp, number][] = [
  [/^\/api\/(leaderboard|trainers|tournament)$/, 5_000],
  [/^\/api\/leaderboards\/[a-z]+$/, 5_000],
  [/^\/api\/trainer\/[^/]+$/, 5_000],
  [/^\/api\/(pokedex|gym)$/, 30_000],
  [/^\/api\/(agent\/activity|agent\/status|pvp\/recent|pvp\/pending)$/, 3_000],
  [/^\/api\/battle\/\d+$/, 60_000],
  [/^\/api\/(stats|shop)$/, 10_000],
]
const publicCache = new Map<string, { at: number; body: Promise<string> }>()

export function startApi(d: Deps, chain: Sol) {
  const { db, cfg } = d
  const store = sessionStore(db)
  const auth = new XAuth(
    { clientId: cfg.xClientId, clientSecret: cfg.xClientSecret, redirectUri: `${cfg.publicUrl}/auth/x/callback` },
    store,
  )
  const secure = cfg.publicUrl.startsWith('https://')
  const routes: { method: string; pattern: RegExp; keys: string[]; h: Handler }[] = []
  const route = (method: string, path: string, h: Handler) => {
    const keys: string[] = []
    const pattern = new RegExp(`^${path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)'))}$`)
    routes.push({ method, pattern, keys, h })
  }

  const userOf = (req: Req): XUser | null => {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE)
    return sid ? store.getSession(sid) : null
  }
  /**
   * The signed-in trainer, by account id. ⚠ The handle in a session is up to 30 days old, so it is used
   * only to create a trainer that does not exist yet; an existing one keeps the handle the agent or the
   * latest login saw, otherwise a stale session would rename whoever holds the handle now.
   */
  const sessionTrainer = (u: XUser): Trainer => {
    const existing = getTrainer(db, u.id)
    return existing ? refreshFreeBalls(db, existing) : ensureTrainer(db, { id: u.id, handle: u.handle, name: u.name, avatar: u.avatar })
  }
  const trainerOf = (req: Req): Trainer => {
    const u = userOf(req)
    if (!u) throw new HttpError(401, 'login with X first')
    return sessionTrainer(u)
  }

  /* -------------------------------------------------------------- public reads */

  route('GET', '/api/config', () => ({
    name: 'XPoke',
    handle: cfg.handle,
    chain: 'solana',
    token: { symbol: TOKEN, mint: cfg.tokenMint || null, decimals: TOKEN_DECIMALS },
    pool: chain.pool || null,
    poolTokenAccount: chain.poolAta || null,
    explorer: EXPLORER,
    loginWithX: auth.configured,
    devLogin: cfg.dev,
    balls: BALLS,
    trainerLevels: TRAINER_LEVELS,
  }))

  route('GET', '/api/agent/status', () => ({
    platforms: [
      { platform: 'x', online: xStatus.online && d.source.kind !== 'fixture', lastPollAt: xStatus.lastPollAt, source: d.source.kind },
      { platform: 'reddit', online: false, lastPollAt: null, source: null },
    ],
    chain: {
      ...chainStatus,
      enabled: Boolean(cfg.tokenMint && chain.pool),
      // read from the settings, not from the last send: true from the moment payouts are switched on
      payouts: Boolean(cfg.payoutsEnabled && chain.keypair && cfg.tokenMint) && getMeta(db, 'payouts_paused') !== '1',
      failedPayouts: (db.prepare("select count(*) as n from ledger where status = 'failed'").get() as { n: number }).n,
      queued: (db.prepare("select count(*) as n from ledger where status in ('pending','signed') and kind != 'payment'").get() as { n: number }).n,
    },
    usage: usage(db, 7),
  }))

  /**
   * One look on launch day: every part that must be working, with a reason when it is not.
   * 200 when all is well, 503 otherwise (usable by an uptime monitor).
   */
  route('GET', '/api/health', (_req, res) => {
    const t = now()
    const problems: string[] = []
    if (d.source.kind !== 'fixture') {
      if (!xStatus.online) problems.push(`X reading is down: ${xStatus.lastError ?? 'no successful poll yet'}`)
      else if (xStatus.lastPollAt && t - xStatus.lastPollAt > 5 * 60_000) problems.push('no X poll for over 5 minutes')
    }
    const running = (db.prepare("select count(*) as n from mentions where status = 'running' and processed_at < ?").get(t - 5 * 60_000) as { n: number }).n
    if (running) problems.push(`${running} mention(s) stuck mid-command (a crash): see /agent`)
    const backlog = (db.prepare("select count(*) as n from mentions where status = 'queued' and processed_at < ?").get(t - 5 * 60_000) as { n: number }).n
    if (backlog) problems.push(`${backlog} reply(ies) queued for over 5 minutes: is posting to X failing?`)
    const recentFail = (db.prepare("select count(*) as n from mentions where status = 'failed' and processed_at > ?").get(t - 3600_000) as { n: number }).n
    if (recentFail) problems.push(`${recentFail} command(s) failed in the last hour`)
    if (chainStatus.enabled) {
      if (chainStatus.lastError) problems.push(`payment watcher: ${chainStatus.lastError}`)
      if (!chainStatus.lastScanAt || t - chainStatus.lastScanAt > 5 * 60_000) problems.push('payment watcher has not scanned for over 5 minutes')
      const solWait = (db.prepare("select count(*) as n from pulls where status = 'pending' and error like 'pool wallet needs SOL%'").get() as { n: number }).n
      if (solWait) problems.push(`the pool wallet is out of SOL for fees: ${solWait} allowance payment(s) waiting. send it SOL`)
      const held = (db.prepare("select count(*) as n from ledger where status in ('held','failed')").get() as { n: number }).n
      if (held) problems.push(`${held} payout(s) held or failed: npm run admin -- held`)
      const stale = (db.prepare("select count(*) as n from ledger where status in ('pending','signed') and kind != 'payment' and created_at < ?").get(t - 15 * 60_000) as { n: number }).n
      if (stale) problems.push(`${stale} payout(s) waiting over 15 minutes`)
    }
    if (getMeta(db, 'payouts_paused') === '1') problems.push('payouts are paused (npm run admin -- resume-payouts)')
    res.statusCode = problems.length ? 503 : 200
    return { ok: !problems.length, problems, x: xStatus, chain: chainStatus, at: t }
  })

  route('GET', '/api/agent/activity', (_req, _res, _p, url) => {
    const limit = intParam(url, 'limit', 50, 200)
    const handle = url.searchParams.get('handle')
    const rows = (
      handle
        ? db
            .prepare("select * from mentions where processed_at is not null and status != 'ignored' and handle = ? collate nocase order by processed_at desc limit ?")
            .all(handle, limit)
        : db.prepare("select * from mentions where processed_at is not null and status != 'ignored' order by processed_at desc limit ?").all(limit)
    ) as { id: string; handle: string; text: string; command: string; reply: string; status: string; processed_at: number; platform: string; author_id: string }[]
    return {
      items: rows.map((r) => ({
        id: r.id,
        platform: r.platform,
        handle: r.handle,
        avatar: getTrainer(db, r.author_id)?.avatar ?? null,
        text: r.text,
        command: r.command,
        reply: r.reply,
        status: r.status === 'replied' ? 'Replied' : r.status === 'queued' ? 'Replying' : r.status === 'failed' ? 'Failed' : 'Command',
        at: r.processed_at,
        url: r.platform === 'x' && !r.id.startsWith('dev-') ? `https://x.com/${r.handle}/status/${r.id}` : null,
      })),
      announcements: JSON.parse(getMeta(db, 'announcements') ?? '[]'),
    }
  })

  const battleRow = (b: { id: number; kind: string; a_trainer: string; b_trainer: string | null; gym: number | null; winner: number; xp_a: number | null; xp_b: number | null; detail: string; at: number }) => {
    const detail = JSON.parse(b.detail)
    const a = getTrainer(db, b.a_trainer)
    const bt = b.b_trainer ? getTrainer(db, b.b_trainer) : null
    const gym = b.gym ? GYMS[b.gym - 1] : null
    return {
      id: b.id,
      kind: b.kind,
      a: { handle: a?.handle ?? '?', avatar: a?.avatar ?? null },
      b: bt ? { handle: bt.handle, avatar: bt.avatar } : gym ? { handle: gym.leader, avatar: null, gym: gym.n } : null,
      winner: b.winner,
      xpA: b.xp_a,
      xpB: b.xp_b,
      detail,
      at: b.at,
    }
  }

  route('GET', '/api/pvp/recent', (_req, _res, _p, url) => {
    const kinds = (url.searchParams.get('kinds') ?? 'pvp,wager,tournament,gym,random').split(',')
    const rows = db
      .prepare(`select * from battles where kind in (${kinds.map(() => '?').join(',')}) order by id desc limit ?`)
      .all(...kinds, intParam(url, 'limit', 20, 100)) as never[]
    return { items: rows.map(battleRow) }
  })

  route('GET', '/api/battle/:id', (_req, _res, p) => {
    const b = db.prepare('select * from battles where id = ?').get(Number(p.id))
    if (!b) throw new HttpError(404, 'no such battle')
    return battleRow(b as never)
  })

  route('GET', '/api/pvp/pending', () => {
    const challenges = db
      .prepare("select * from challenges where status = 'pending' and expires_at > ? order by created_at desc limit 50")
      .all(now()) as { id: number; challenger_id: string; target_id: string; challenger_pokemon: number; created_at: number; expires_at: number }[]
    const wagers = db.prepare("select * from wagers where status in ('pending_accept','awaiting_payment') order by id desc").all() as Wager[]
    return {
      challenges: challenges.map((c) => {
        const m = getMon(db, c.challenger_pokemon)
        return {
          id: c.id,
          challenger: getTrainer(db, c.challenger_id)?.handle,
          target: getTrainer(db, c.target_id)?.handle,
          pokemon: m ? { name: sp(m).name, level: m.level, sprite: spriteId(sp(m)), shiny: Boolean(m.shiny) } : null,
          createdAt: c.created_at,
          expiresAt: c.expires_at,
        }
      }),
      wagers: wagers.map((w) => wagerView(db, w)),
    }
  })

  const leaderboard = (limit: number) => {
    const rows = db
      .prepare(
        `select t.*, (select max(level) from pokemon p where p.trainer_id = t.id and p.location != 'released') as best,
                (select count(*) from pokemon p where p.trainer_id = t.id and p.location = 'party') as party_n,
                (select count(*) from pokemon p where p.trainer_id = t.id and p.location != 'released') as total_n,
                (select count(*) from medals m where m.trainer_id = t.id) as medals
         from trainers t where exists (select 1 from pokemon p where p.trainer_id = t.id)
         order by t.wins desc, best desc, t.created_at asc limit ?`,
      )
      .all(limit) as (Trainer & { best: number | null; party_n: number; total_n: number; medals: number })[]
    return rows.map((t, i) => ({
      rank: i + 1,
      handle: t.handle,
      name: t.name,
      avatar: t.avatar,
      wins: t.wins,
      losses: t.losses,
      trainerLevel: trainerLevel(t.wins),
      bestLevel: t.best ?? 0,
      party: t.party_n,
      total: t.total_n,
      medals: t.medals,
    }))
  }

  route('GET', '/api/leaderboard', (_req, _res, _p, url) => ({ items: leaderboard(intParam(url, 'limit', 100, 500)) }))

  /**
   * The Leaderboards page: one board at a time.
   *  trainers  most battle wins            medals   most gym medals
   *  pokemon   highest-level Pokémon       shinies  most shiny Pokémon owned
   *  wagers    most wagers won, and $XPOKE won (99% of each pot won)
   */
  route('GET', '/api/leaderboards/:board', (_req, _res, p, url) => {
    const limit = intParam(url, 'limit', 50, 100)
    const who = (id: string) => {
      const t = getTrainer(db, id)
      return { handle: t?.handle ?? '?', avatar: t?.avatar ?? null, trainerLevel: trainerLevel(t?.wins ?? 0) }
    }
    switch (p.board) {
      case 'trainers':
        return {
          board: 'trainers',
          items: leaderboard(limit).map((r) => ({ rank: r.rank, handle: r.handle, avatar: r.avatar, trainerLevel: r.trainerLevel, value: r.wins, detail: { wins: r.wins, losses: r.losses, bestLevel: r.bestLevel, medals: r.medals, pokemon: r.total } })),
        }
      case 'medals': {
        const rows = db
          .prepare('select m.trainer_id, count(*) as n, max(m.gym) as top, t.wins from medals m join trainers t on t.id = m.trainer_id group by m.trainer_id order by n desc, top desc, t.wins desc limit ?')
          .all(limit) as { trainer_id: string; n: number; top: number; wins: number }[]
        return { board: 'medals', items: rows.map((r, i) => ({ rank: i + 1, ...who(r.trainer_id), value: r.n, detail: { highestGym: GYMS[r.top - 1]?.leader ?? null, wins: r.wins } })) }
      }
      case 'pokemon': {
        const rows = db
          .prepare("select * from pokemon where location != 'released' order by level desc, xp desc, wins desc, id asc limit ?")
          .all(limit) as Mon[]
        return {
          board: 'pokemon',
          items: rows.map((m, i) => ({
            rank: i + 1,
            ...who(m.trainer_id),
            value: m.level,
            detail: { name: sp(m).name, sprite: spriteId(sp(m)), shiny: Boolean(m.shiny), types: sp(m).types, rarity: sp(m).rarity, wins: m.wins, losses: m.losses, xp: m.xp },
          })),
        }
      }
      case 'shinies': {
        const rows = db
          .prepare("select trainer_id, count(*) as n, max(level) as best from pokemon where shiny = 1 and location != 'released' group by trainer_id order by n desc, best desc limit ?")
          .all(limit) as { trainer_id: string; n: number; best: number }[]
        return {
          board: 'shinies',
          items: rows.map((r, i) => {
            const top = db.prepare("select * from pokemon where trainer_id = ? and shiny = 1 and location != 'released' order by level desc limit 1").get(r.trainer_id) as Mon
            return { rank: i + 1, ...who(r.trainer_id), value: r.n, detail: { best: { name: sp(top).name, sprite: spriteId(sp(top)), level: top.level } } }
          }),
        }
      }
      case 'wagers': {
        const won = new Map<string, { n: number; tokens: bigint }>()
        for (const w of db.prepare("select challenger_id, target_id, winner, paid_a_amount, paid_b_amount from wagers where status = 'complete'").all() as {
          challenger_id: string
          target_id: string
          winner: number
          paid_a_amount: string
          paid_b_amount: string
        }[]) {
          const id = w.winner === 0 ? w.challenger_id : w.target_id
          const pot = BigInt(w.paid_a_amount) + BigInt(w.paid_b_amount)
          const e = won.get(id) ?? { n: 0, tokens: 0n }
          e.n++
          e.tokens += pot - pot / 100n
          won.set(id, e)
        }
        const rows = [...won.entries()].sort((a, b) => (b[1].tokens > a[1].tokens ? 1 : b[1].tokens < a[1].tokens ? -1 : b[1].n - a[1].n)).slice(0, limit)
        return { board: 'wagers', items: rows.map(([id, e], i) => ({ rank: i + 1, ...who(id), value: e.n, detail: { tokensWon: roundAmount(e.tokens) } })) }
      }
      default:
        throw new HttpError(404, 'unknown board: trainers, medals, pokemon, shinies or wagers')
    }
  })

  route('GET', '/api/gym', () => ({
    gyms: GYMS.map((g) => {
      const f = gymFighter(g)
      const medals = (db.prepare('select count(*) as n from medals where gym = ?').get(g.n) as { n: number }).n
      return { n: g.n, leader: g.leader, pokemon: f.species.name, sprite: spriteId(f.species), types: f.species.types, level: g.level, medals }
    }),
  }))

  let ranksAt = 0
  let ranksCache = new Map<string, number>()
  const rankMap = () => {
    if (now() - ranksAt > 10_000) {
      ranksCache = new Map(leaderboard(10_000).map((r) => [r.handle, r.rank]))
      ranksAt = now()
    }
    return ranksCache
  }
  route('GET', '/api/trainers', (_req, _res, _p, url) => {
    const q = (url.searchParams.get('q') ?? '').replace(/^@/, '')
    const limit = intParam(url, 'limit', 60, 200)
    const rows = db
      .prepare(
        `select * from trainers t where exists (select 1 from pokemon p where p.trainer_id = t.id and p.location != 'released')
         ${q ? 'and handle like ?' : ''} order by wins desc, created_at asc limit ?`,
      )
      .all(...(q ? [`%${q}%`, limit] : [limit])) as Trainer[]
    const locks = lockedIds(db)
    const ranks = rankMap()
    return {
      items: rows.map((t) => ({
        handle: t.handle,
        name: t.name,
        avatar: t.avatar,
        wins: t.wins,
        trainerLevel: trainerLevel(t.wins),
        rank: ranks.get(t.handle) ?? null,
        party: party(db, t.id).map((m) => monView(db, m, locks)),
        total: allMons(db, t.id).length,
      })),
    }
  })

  route('GET', '/api/trainer/:handle', (_req, _res, p) => {
    const t = trainerByHandle(db, p.handle!)
    if (!t) throw new HttpError(404, 'no such trainer')
    return trainerView(t, false)
  })

  const pokedex = () => {
    const owned = new Map(
      (db.prepare("select species_id, count(distinct trainer_id) as n from pokemon where location != 'released' group by species_id").all() as {
        species_id: number
        n: number
      }[]).map((r) => [r.species_id, r.n]),
    )
    return CATCHABLE.map((s) => {
      const chain: { name: string; id: number; level: number | null }[] = []
      let cur = s
      while (cur.evolvesTo?.length) {
        const next = species(cur.evolvesTo[0]!)
        chain.push({ name: next.name, id: next.id, level: next.evolveLevel ?? null })
        cur = next
      }
      // owners of the whole evolution line count toward the base form
      const line = [s.id, ...chain.map((c) => c.id), ...(s.evolvesTo ?? []).slice(1)]
      return {
        id: s.id,
        name: s.name,
        types: s.types,
        rarity: s.rarity,
        gen: s.gen,
        stats: { hp: s.hp, atk: s.atk, def: s.def, spa: s.spa, spd: s.spd, spe: s.spe },
        bst: s.bst,
        owners: line.reduce((n, id) => n + (owned.get(id) ?? 0), 0),
        evolutions: chain,
        branches: (s.evolvesTo ?? []).map((id) => species(id).name),
      }
    })
  }
  route('GET', '/api/pokedex', () => ({ items: pokedex(), total: CATCHABLE.length }))

  route('GET', '/api/tournament', () => {
    const open = openTournament(db)
    const last = db.prepare("select * from tournaments where status = 'done' order by id desc limit 1").get() as Tournament | undefined
    const view = (t: Tournament | undefined | null) => {
      if (!t) return null
      const list = entries(db, t.id).map((e) => {
        const tr = getTrainer(db, e.trainer_id)
        return { handle: tr?.handle, avatar: tr?.avatar, wins: tr?.wins ?? 0, seed: e.seed, joinedAt: e.joined_at }
      })
      const bracket = t.bracket ? JSON.parse(t.bracket) : null
      if (bracket) {
        for (const m of bracket.matches) {
          m.a = getTrainer(db, m.a)?.handle
          m.b = getTrainer(db, m.b)?.handle
          m.winner = getTrainer(db, m.winner)?.handle
        }
        bracket.seeds = bracket.seeds.map((id: string) => getTrainer(db, id)?.handle)
      }
      return {
        id: t.id,
        name: t.name,
        prize: t.prize,
        status: t.status,
        createdAt: t.created_at,
        finishedAt: t.finished_at,
        winner: t.winner_id ? getTrainer(db, t.winner_id)?.handle : null,
        prizeAmount: t.prize_amount ? showAmount(t.prize_amount) : null,
        walletRequired: Boolean(t.prize_amount),
        prizePayout: t.prize_amount
          ? ((db.prepare("select status, tx_hash as tx, to_addr as wallet, error from ledger where ref_kind = 'tournament' and ref_id = ?").get(t.id) as Record<string, unknown> | undefined) ?? null)
          : null,
        entries: list,
        size: TOURNAMENT_SIZE,
        bracket,
      }
    }
    return { open: view(open), last: view(last) }
  })

  route('GET', '/api/shop', () => ({
    balls: Object.entries(BALLS).map(([k, b]) => ({ key: k, ...b })),
    token: cfg.tokenMint || null,
    symbol: TOKEN,
    pool: chain.pool || null,
    enabled: Boolean(cfg.tokenMint && chain.pool),
  }))

  const cachedBalances = memo(30_000, () => poolBalances(chain))
  route('GET', '/api/stats', async () => {
    const ledger = db.prepare('select * from ledger order by id desc limit 300').all() as {
      id: number
      kind: string
      ref_kind: string
      ref_id: number
      to_addr: string | null
      from_addr: string | null
      amount: string
      status: string
      tx_hash: string | null
      error: string | null
      created_at: number
    }[]
    const sum = (kind: string, statuses: string[]) =>
      (db.prepare(`select amount from ledger where kind = ? and status in (${statuses.map(() => '?').join(',')})`).all(kind, ...statuses) as { amount: string }[]).reduce(
        (a, r) => a + BigInt(r.amount),
        0n,
      )
    let balances: { token: string | null; supply: string | null } = { token: null, supply: null }
    try {
      balances = await cachedBalances()
    } catch {
      /* chain read failed: totals still render */
    }
    const counts = db
      .prepare(
        `select (select count(*) from trainers) as trainers, (select count(*) from pokemon where location != 'released') as pokemon,
                (select count(*) from battles) as battles, (select count(*) from pokemon where shiny = 1 and location != 'released') as shinies,
                (select count(*) from wagers where status = 'complete') as wagers, (select count(*) from mentions where processed_at is not null) as commands`,
      )
      .get()
    return {
      token: cfg.tokenMint || null,
      symbol: TOKEN,
      pool: chain.pool || null,
      explorer: EXPLORER,
      poolBalance: balances.token ? showAmount(balances.token) : null,
      totalSupply: balances.supply ? showAmount(balances.supply) : null,
      totals: {
        paidIn: showAmount(sum('payment', ['confirmed'])),
        paidOut: showAmount(sum('payout', ['confirmed'])),
        refunded: showAmount(sum('refund', ['confirmed'])),
        burned: showAmount(sum('burn', ['confirmed'])),
        queued: showAmount(sum('payout', ['pending', 'signed']) + sum('refund', ['pending', 'signed']) + sum('burn', ['pending', 'signed'])),
      },
      counts,
      chain: chainStatus,
      ledger: ledger.map((r) => ({
        id: r.id,
        kind: r.kind,
        ref: `${r.ref_kind} #${r.ref_id}`,
        to: r.to_addr,
        from: r.from_addr,
        amount: showAmount(r.amount),
        status: r.status,
        tx: r.tx_hash,
        error: r.error,
        at: r.created_at,
      })),
    }
  })

  /* -------------------------------------------------------------- the signed-in trainer */

  function trainerView(t: Trainer, mine: boolean) {
    const locks = lockedIds(db)
    const medals = db.prepare('select gym, earned_at from medals where trainer_id = ? order by gym').all(t.id) as { gym: number; earned_at: number }[]
    const base = {
      id: mine ? t.id : undefined,
      handle: t.handle,
      name: t.name,
      avatar: t.avatar,
      wins: t.wins,
      losses: t.losses,
      trainerLevel: trainerLevel(t.wins),
      nextLevelAt: TRAINER_LEVELS[trainerLevel(t.wins)] ?? null,
      medals: medals.map((m) => ({ ...GYMS[m.gym - 1]!, earnedAt: m.earned_at })),
      party: party(db, t.id).map((m) => monView(db, m, locks)),
      box1: monsAt(db, t.id, 'box1').map((m) => monView(db, m, locks)),
      box2: monsAt(db, t.id, 'box2').map((m) => monView(db, m, locks)),
    }
    if (!mine) return base
    expireTrades(db)
    const trades = (db.prepare("select * from trades where status = 'pending' and (from_id = ? or to_id = ?)").all(t.id, t.id) as Trade[]).map((tr) => {
      const offer = getMon(db, tr.offer_pokemon)
      const want = tr.want_pokemon ? getMon(db, tr.want_pokemon) : null
      return {
        id: tr.id,
        incoming: tr.to_id === t.id,
        from: getTrainer(db, tr.from_id)?.handle,
        to: getTrainer(db, tr.to_id)?.handle,
        offer: offer ? monView(db, offer, locks) : null,
        want: want ? monView(db, want, locks) : null,
        createdAt: tr.created_at,
      }
    })
    const w = activeWagerOf(db, t.id)
    const recentWagers = (db.prepare('select * from wagers where challenger_id = ? or target_id = ? order by id desc limit 10').all(t.id, t.id) as Wager[]).map((x) =>
      wagerView(db, x, t.id),
    )
    const orders = db.prepare('select * from orders where trainer_id = ? order by id desc limit 10').all(t.id) as {
      id: number
      ball: string
      qty: number
      amount: string
      status: string
      created_at: number
      expires_at: number
      paid_tx: string | null
    }[]
    return {
      ...base,
      balls: { poke: t.free_balls + t.bought_pokeballs, free: t.free_balls, ultra: t.ultra_balls, master: t.master_balls, failStreak: t.fail_streak },
      wallet: t.wallet ? { address: t.wallet, linkedAt: t.wallet_linked_at } : null,
      trades,
      wager: w ? wagerView(db, w, t.id) : null,
      wagers: recentWagers,
      orders: orders.map((o) => ({ id: o.id, ball: o.ball, qty: o.qty, amount: showAmount(o.amount), amountWei: o.amount, status: o.status, createdAt: o.created_at, expiresAt: o.expires_at, tx: o.paid_tx })),
    }
  }

  route('GET', '/api/me', (req) => {
    const u = userOf(req)
    if (!u) return { user: null }
    const t = sessionTrainer(u)
    return { user: { ...u, handle: t.handle }, trainer: trainerView(t, true) }
  })

  /* -------------------------------------------------------------- linked wallet */

  /** Step 1: the exact message to sign for this wallet (valid 10 minutes, used once). */
  route('POST', '/api/me/wallet/challenge', (req) => {
    const t = trainerOf(req)
    const { address } = req.body as { address: string }
    try {
      return createChallenge(db, t, String(address ?? ''))
    } catch (e) {
      if (e instanceof WalletError) throw new HttpError(400, e.message)
      throw e
    }
  })

  /** Step 2: the wallet's signature over that message links it. */
  route('POST', '/api/me/wallet/link', (req) => {
    const t = trainerOf(req)
    const { nonce, signature } = req.body as { nonce: string; signature: string }
    try {
      const address = completeLink(db, t, String(nonce ?? ''), String(signature ?? ''))
      return { ok: true, address }
    } catch (e) {
      if (e instanceof WalletError) throw new HttpError(409, e.message)
      throw e
    }
  })

  /**
   * A transaction for the LINKED wallet to sign: approve XPoke (the pool) as delegate for up to `amount`
   * $XPOKE, or revoke it with amount 0. The wallet signs and sends it; the server never holds the key.
   */
  route('POST', '/api/me/wallet/allowance', async (req) => {
    const t = trainerOf(req)
    if (!cfg.tokenMint || !chain.pool) throw new HttpError(409, 'wager allowances open when $' + TOKEN + ' is live')
    if (!t.wallet) throw new HttpError(409, 'link a wallet first')
    const { amount } = req.body as { amount: string | number }
    const s = String(amount ?? '').trim()
    if (!/^\d+(\.\d{1,6})?$/.test(s)) throw new HttpError(400, 'amount must be a number of tokens, up to 6 decimals')
    const wei = toWei(s)
    if (wei > 10n ** 18n) throw new HttpError(400, 'that amount is too large')
    return { tx: await buildAllowance(chain, t.wallet, wei), amount: wei === 0n ? '0' : showAmount(wei) }
  })

  route('POST', '/api/me/wallet/unlink', (req) => {
    const t = trainerOf(req)
    unlink(db, t)
    return { ok: true, note: 'unlinked. wagers already accepted still pay the wallet that was linked when they were accepted' }
  })

  /** The linked wallet's $XPOKE and SOL balance and allowance (cached 10 s per wallet). */
  const balanceCache = new Map<string, { at: number; v: Promise<{ token: string | null; sol: number }> }>()
  route('GET', '/api/me/wallet/balance', async (req) => {
    const t = trainerOf(req)
    if (!t.wallet) return { token: null, sol: null, allowance: null, tokenAccount: false }
    const hit = balanceCache.get(t.wallet)
    if (hit && now() - hit.at < 10_000) return await hit.v
    const v = (async () => {
      const sol = (await chain.rpc.call<{ value: number }>('getBalance', [t.wallet, { commitment: 'confirmed' }])).value / 1e9
      if (!cfg.tokenMint) return { token: null, sol, allowance: null, tokenAccount: false }
      const accts = await chain.rpc.call<{ value: { account: { data: { parsed: { info: { tokenAmount: { amount: string } } } } } }[] }>(
        'getTokenAccountsByOwner',
        [t.wallet, { mint: cfg.tokenMint }, { encoding: 'jsonParsed', commitment: 'confirmed' }],
      )
      const raw = accts.value.reduce((a, x) => a + BigInt(x.account.data.parsed.info.tokenAmount.amount), 0n)
      const al = await allowanceOf(chain, t.wallet!)
      return { token: showAmount(raw), sol, allowance: showAmount(al.allowance), allowanceWei: al.allowance.toString(), tokenAccount: al.exists }
    })()
    balanceCache.set(t.wallet, { at: now(), v })
    v.catch(() => balanceCache.delete(t.wallet!))
    if (balanceCache.size > 5000) balanceCache.delete(balanceCache.keys().next().value!)
    try {
      return await v
    } catch {
      throw new HttpError(503, 'could not read the balance right now')
    }
  })

  route('POST', '/api/me/move', (req) => {
    const t = trainerOf(req)
    const { id, to } = req.body as { id: number; to: string }
    if (!['party', 'box1', 'box2'].includes(to)) throw new HttpError(400, 'unknown destination')
    return tx(db, () => {
      const m = getMon(db, Number(id))
      if (!m || m.trainer_id !== t.id || m.location === 'released') throw new HttpError(404, 'not your pokemon')
      if (m.location === to) return { ok: true }
      const lock = lockedIds(db).get(m.id)
      if (lock) throw new HttpError(409, `locked by a pending ${lock === 'pvp' ? 'challenge' : 'wager'}`)
      if (to === 'party' && party(db, t.id).length >= PARTY_MAX) throw new HttpError(409, 'your party is full, send one to a box first')
      moveMon(db, m, to)
      return { ok: true }
    })
  })

  route('POST', '/api/me/trade/:id', (req, _res, p) => {
    const t = trainerOf(req)
    const { accept } = req.body as { accept: boolean }
    const r = resolveTrade(db, Number(p.id), t.id, Boolean(accept))
    if (!r.ok) throw new HttpError(409, r.message)
    return r
  })

  route('POST', '/api/me/wager/:id/cancel', (req, _res, p) => {
    const t = trainerOf(req)
    return tx(db, () => {
      const w = getWager(db, Number(p.id))
      if (!w) throw new HttpError(404, 'no such wager')
      return { message: cancelWagerBy(db, w, t.id, 'cancelled on the website') }
    })
  })

  /** "Check Payment" / "confirm": scan now, and read a pasted tx hash directly. */
  /** One chain check per trainer every 10 s: each one costs RPC calls that the sender shares. */
  const lastCheck = new Map<string, number>()
  const checkPayment = async (body: { tx?: string }, trainerId: string) => {
    const t0 = lastCheck.get(trainerId) ?? 0
    if (now() - t0 < 10_000) throw new HttpError(429, 'checked a moment ago, try again in a few seconds')
    lastCheck.set(trainerId, now())
    if (lastCheck.size > 5000) lastCheck.delete(lastCheck.keys().next().value!)
    if (cfg.tokenMint) await resolveToken(chain)
    const out: string[] = []
    if (!cfg.tokenMint) throw new HttpError(409, 'payments are not switched on yet')
    if (body?.tx) {
      if (!isSignature(body.tx)) throw new HttpError(400, 'that is not a Solana transaction signature')
      try {
        out.push(...(await checkTx(db, cfg, chain, body.tx)))
      } catch (e) {
        // a just-sent transfer that is not confirmed yet, or one the RPC cannot find: the caller's answer is
        // "not yet", not a server error (the watcher credits it on its own as soon as it confirms)
        throw new HttpError(409, /not confirmed/.test((e as Error).message) ? (e as Error).message : 'that transaction could not be read yet, it is credited automatically once it confirms')
      }
    }
    out.push(...(await scanOnce(db, cfg, chain)))
    for (const line of out) await announce(d, line)
  }

  route('POST', '/api/me/wager/:id/check', async (req, _res, p) => {
    const t = trainerOf(req)
    const mine = getWager(db, Number(p.id))
    if (!mine || (mine.challenger_id !== t.id && mine.target_id !== t.id)) throw new HttpError(404, 'no such wager')
    await checkPayment(req.body as { tx?: string }, t.id)
    return wagerView(db, getWager(db, mine.id)!, t.id)
  })

  route('POST', '/api/shop/order', (req) => {
    const t = trainerOf(req)
    if (!cfg.tokenMint || !chain.pool) throw new HttpError(409, 'the shop opens when $' + TOKEN + ' is live')
    const { ball, qty } = req.body as { ball: string; qty: number }
    if (ball !== 'ultra' && ball !== 'master') throw new HttpError(400, 'pick ultra or master')
    const n = Math.floor(Number(qty))
    if (!(n >= 1 && n <= 100)) throw new HttpError(400, 'quantity 1 to 100')
    return tx(db, () => {
      // one trainer keeps at most 3 open orders; opening a 4th closes the oldest (its amount frees up)
      const open = db.prepare("select id from orders where trainer_id = ? and status = 'pending' order by id desc").all(t.id) as { id: number }[]
      for (const o of open.slice(2)) db.prepare("update orders set status = 'expired' where id = ?").run(o.id)
      const whole = toWei(BALLS[ball].price * n)
      const amount = uniqueAmount(db, whole)
      const r = db
        .prepare("insert into orders (trainer_id, ball, qty, amount, status, created_at, expires_at) values (?,?,?,?,'pending',?,?)")
        .run(t.id, ball, n, amount, now(), now() + ORDER_WINDOW)
      return { id: Number(r.lastInsertRowid), ball, qty: n, amount: showAmount(amount), amountWei: amount, pool: chain.pool, poolTokenAccount: chain.poolAta, mint: cfg.tokenMint, expiresAt: now() + ORDER_WINDOW }
    })
  })

  route('POST', '/api/shop/order/:id/check', async (req, _res, p) => {
    const t = trainerOf(req)
    if (!db.prepare('select 1 from orders where id = ? and trainer_id = ?').get(Number(p.id), t.id)) throw new HttpError(404, 'no such order')
    await checkPayment(req.body as { tx?: string }, t.id)
    const o = db.prepare('select * from orders where id = ? and trainer_id = ?').get(Number(p.id), t.id) as { status: string; paid_tx: string | null }
    return { status: o.status, tx: o.paid_tx }
  })

  /**
   * An unsigned payment for the connected wallet to sign and send: the exact unique amount of one of
   * the signed-in trainer's own orders or wager sides, into the pool. Nothing else can be built here.
   */
  route('POST', '/api/pay/build', async (req) => {
    const t = trainerOf(req)
    const { kind, id, payer } = req.body as { kind: 'order' | 'wager'; id: number; payer: string }
    if (!cfg.tokenMint || !chain.pool) throw new HttpError(409, 'payments are not switched on yet')
    if (!isAddress(String(payer))) throw new HttpError(400, 'that is not a Solana wallet address')
    let amount: string | null = null
    if (kind === 'order') {
      const o = db.prepare("select amount from orders where id = ? and trainer_id = ? and status = 'pending'").get(Number(id), t.id) as { amount: string } | undefined
      amount = o?.amount ?? null
    } else if (kind === 'wager') {
      const w = getWager(db, Number(id))
      if (w && w.status === 'awaiting_payment') {
        if (w.challenger_id === t.id && !w.paid_a_tx) amount = w.pay_a
        if (w.target_id === t.id && !w.paid_b_tx) amount = w.pay_b
      }
    }
    if (!amount) throw new HttpError(409, 'nothing to pay for that')
    return { tx: await buildPayment(chain, payer, BigInt(amount)), amount: showAmount(amount) }
  })

  route('POST', '/api/tournament/join', async (req) => {
    const t = trainerOf(req)
    const out = tx(db, () => joinTournament({ db, actor: t, site: cfg.publicUrl }))
    for (const line of out.announce ?? []) await announce(d, line)
    return { message: out.reply }
  })

  /* -------------------------------------------------------------- sign in */

  route('GET', '/auth/x/login', (_req, res) => {
    if (!auth.configured) throw new HttpError(503, 'login with X is not configured')
    const { url, state } = auth.begin()
    // the state also travels in a short cookie, so a callback link can only finish a sign-in that
    // THIS browser started: nobody can log a visitor into an account by handing them a callback URL
    res.writeHead(302, {
      location: url,
      'set-cookie': `xpoke_oauth=${state}; Path=/auth/x; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}; Max-Age=600`,
    })
    res.end()
  })

  route('GET', '/auth/x/callback', async (_req, res, _p, url) => {
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    if (!code || !state) throw new HttpError(400, 'missing code')
    const started = readCookie(_req.headers.cookie, 'xpoke_oauth')
    if (!started || !safeEquals(started, state)) throw new HttpError(400, 'this sign-in was not started in this browser. go back and press Login with X again')
    const { user, sessionId } = await auth.complete(code, state)
    ensureTrainer(db, { id: user.id, handle: user.handle, name: user.name, avatar: user.avatar })
    res.writeHead(302, {
      location: '/me',
      'set-cookie': [sessionCookie(sessionId, secure), `xpoke_oauth=; Path=/auth/x; HttpOnly; SameSite=Lax; Max-Age=0`],
    })
    res.end()
  })

  route('POST', '/auth/logout', (req, res) => {
    const sid = readCookie(req.headers.cookie, SESSION_COOKIE)
    if (sid) store.dropSession(sid)
    res.setHeader('set-cookie', sessionCookie(null, secure))
    return { ok: true }
  })

  /* -------------------------------------------------------------- dev console (DEV_MODE=1 only) */

  if (cfg.dev) {
    route('POST', '/api/dev/login', (_req, res, _p) => {
      const { handle } = (_req.body ?? {}) as { handle?: string }
      const h = String(handle ?? '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 15)
      if (!h) throw new HttpError(400, 'handle?')
      const user: XUser = { id: `h:${h.toLowerCase()}`, handle: h, name: h, avatar: null }
      ensureTrainer(db, user)
      const sid = `dev-${h}-${now()}`
      store.putSession(sid, user, 86400)
      res.setHeader('set-cookie', sessionCookie(sid, secure))
      return { ok: true }
    })
    route('POST', '/api/dev/mention', async (req) => {
      const { handle, text } = req.body as { handle: string; text: string }
      const h = String(handle).replace(/^@/, '')
      const r = await processMention(d, {
        id: `dev-${now()}-${Math.random().toString(36).slice(2, 8)}`,
        text: `@${cfg.handle} ${text}`,
        createdAt: new Date(),
        authorHandle: h,
        authorId: `h:${h.toLowerCase()}`,
        authorName: h,
        authorFollowers: 100,
        authorCreatedAt: null,
        authorAvatar: null,
        mediaUrl: null,
        inReplyToId: null,
        isRetweet: false,
        url: '',
      })
      return r ?? { reply: '', status: 'ignored' }
    })
    /** Simulates a confirmed transfer into the pool (no chain). */
    route('POST', '/api/dev/transfer', async (req) => {
      const { from, amount } = req.body as { from: string; amount: string }
      const { handleTransfer } = await import('./pay/match.ts')
      const r = handleTransfer(db, { txHash: `dev-${now()}`, logIndex: 0, from, amount: String(amount), block: 0 })
      if (r?.announce) await announce(d, r.announce)
      return r
    })
  }

  /* -------------------------------------------------------------- admin */

  route('POST', '/api/admin/tournament', (req) => {
    const given = String(req.headers['x-admin-token'] ?? '')
    if (!cfg.adminToken || given.length !== cfg.adminToken.length || !timingSafeEqual(Buffer.from(given), Buffer.from(cfg.adminToken)))
      throw new HttpError(403, 'forbidden')
    const { name, prize, prizeAmount } = req.body as { name: string; prize?: string; prizeAmount?: string }
    try {
      const amt = prizeAmount !== undefined && prizeAmount !== null && String(prizeAmount) !== '' ? String(prizeAmount) : null
      if (amt !== null && !/^\d+(\.\d{1,6})?$/.test(amt)) throw new HttpError(400, 'prizeAmount must be a number of tokens')
      return createTournament(db, String(name || 'XPoke Cup').slice(0, 60), prize ? String(prize).slice(0, 80) : amt ? `${amt} $${TOKEN}` : null, amt ? toWei(amt).toString() : null)
    } catch (e) {
      throw new HttpError(409, (e as Error).message)
    }
  })

  /* -------------------------------------------------------------- serve */

  const dist = resolve(cfg.webDist)
  const TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.json': 'application/json',
    '.woff2': 'font/woff2',
    '.webp': 'image/webp',
  }

  async function serveStatic(path: string, res: ServerResponse): Promise<boolean> {
    let decoded: string
    try {
      decoded = decodeURIComponent(path)
    } catch {
      return false
    }
    const file = normalize(join(dist, decoded))
    if (file !== dist && !file.startsWith(dist + sep)) return false
    try {
      const s = await stat(file)
      if (!s.isFile()) return false
      const ext = extname(file)
      res.writeHead(200, {
        'content-type': TYPES[ext] ?? 'application/octet-stream',
        // hashed bundles are forever; everything else revalidates
        'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : path.startsWith('/sprites/') ? 'public, max-age=604800' : 'no-cache',
      })
      res.end(await readFile(file))
      return true
    } catch {
      return false
    }
  }

  const server = createServer(async (req: Req, res) => {
    const url = new URL(req.url ?? '/', 'http://x')
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue
        const m = r.pattern.exec(url.pathname)
        if (!m) continue
        if (req.method === 'POST') {
          const chunks: Buffer[] = []
          let size = 0
          for await (const c of req) {
            size += (c as Buffer).length
            if (size > 64_000) throw new HttpError(413, 'too large')
            chunks.push(c as Buffer)
          }
          try {
            req.body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}
          } catch {
            throw new HttpError(400, 'body is not valid JSON')
          }
          if (typeof req.body !== 'object' || req.body === null) throw new HttpError(400, 'body must be a JSON object')
        }
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1]!)]))
        // public read-only answers are shared for a few seconds: a launch crowd refreshing the home page
        // costs one query per endpoint per window, not one per visitor (in-flight requests share too)
        const ttl = req.method === 'GET' ? PUBLIC_TTL.find(([re]) => re.test(url.pathname))?.[1] : undefined
        let body: string
        if (ttl) {
          // only parameters the handlers read form the key: random query strings cannot bypass or flood it
          const params2 = ['limit', 'handle', 'q', 'kinds'].map((k) => `${k}=${url.searchParams.get(k) ?? ''}`).join('&')
          const key = `${url.pathname}?${params2}`
          if (publicCache.size > 500) for (const [k, v] of publicCache) if (now() - v.at > 60_000) publicCache.delete(k)
          const hit = publicCache.get(key)
          if (hit && now() - hit.at < ttl) body = await hit.body
          else {
            const p = Promise.resolve(r.h(req, res, params, url)).then((out) => JSON.stringify(out ?? {}))
            publicCache.set(key, { at: now(), body: p })
            p.catch(() => publicCache.delete(key))
            if (publicCache.size > 2000) publicCache.delete(publicCache.keys().next().value!)
            body = await p
          }
        } else {
          const out = await r.h(req, res, params, url)
          if (res.headersSent) return
          body = JSON.stringify(out ?? {})
        }
        if (!res.headersSent) {
          // a handler may set its own status (health answers 503); default 200
          res.writeHead(res.statusCode && res.statusCode !== 200 ? res.statusCode : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(body)
        }
        return
      }
      if (url.pathname.startsWith('/api/')) throw new HttpError(404, 'not found')
      // HEAD is answered like GET (node drops the body): link-preview bots and monitors use it
      const read = req.method === 'GET' || req.method === 'HEAD'
      if (read && (await serveStatic(url.pathname, res))) return
      // SPA: any page path gets index.html, never a stale bundle
      if (read && !extname(url.pathname) && (await serveStatic('/index.html', res))) return
      res.writeHead(404).end('not found')
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500
      if (status === 500) console.error('[api]', req.method, url.pathname, e)
      if (!res.headersSent) {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: e instanceof HttpError ? e.message : 'something went wrong' }))
      }
    }
  })
  server.listen(cfg.port, '127.0.0.1', () => console.log(`[api] http://127.0.0.1:${cfg.port}`))
  return server
}

export { SPECIES }
