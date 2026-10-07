/**
 * SQLite (node:sqlite) — one file, every write synchronous, so a command is applied atomically
 * before its reply is composed.
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type DB = DatabaseSync

const SCHEMA = `
pragma journal_mode = wal;
pragma foreign_keys = on;

create table if not exists meta (k text primary key, v text not null);

create table if not exists trainers (
  id text primary key,                 -- X user id
  handle text not null unique collate nocase,
  name text,
  avatar text,
  wins integer not null default 0,
  losses integer not null default 0,
  free_balls integer not null default 5,
  free_balls_day text,                 -- UTC yyyy-mm-dd the free stock belongs to
  ultra_balls integer not null default 0,
  master_balls integer not null default 0,
  bought_pokeballs integer not null default 0,
  fail_streak integer not null default 0,
  created_at integer not null
);

create table if not exists pokemon (
  id integer primary key autoincrement,
  trainer_id text not null references trainers(id),
  species_id integer not null,
  shiny integer not null default 0,
  level integer not null default 1,
  xp integer not null default 0,
  iv_hp integer not null, iv_atk integer not null, iv_def integer not null, iv_spe integer not null,
  feeds integer not null default 0,
  last_food text,
  last_fed_at integer,
  last_battle_at integer,
  last_activity_at integer,
  last_activity text,
  wins integer not null default 0,
  losses integer not null default 0,
  location text not null,              -- party | box1 | box2 | released
  slot integer not null default 0,     -- order inside its location
  wager_eligible integer not null default 1,
  caught_at integer not null,
  released_at integer
);
create index if not exists pokemon_trainer on pokemon(trainer_id, location, slot);

create table if not exists medals (
  trainer_id text not null references trainers(id),
  gym integer not null,
  earned_at integer not null,
  primary key (trainer_id, gym)
);

create table if not exists battles (
  id integer primary key autoincrement,
  kind text not null,                  -- random | gym | pvp | wager | tournament
  a_trainer text not null, a_pokemon integer,
  b_trainer text, b_pokemon integer,
  gym integer,
  winner integer not null,             -- 0 = side a, 1 = side b
  xp_a integer, xp_b integer,
  detail text not null,
  at integer not null
);
create index if not exists battles_at on battles(at);

create table if not exists challenges (
  id integer primary key autoincrement,
  challenger_id text not null, target_id text not null,
  challenger_pokemon integer not null,
  target_pokemon integer,
  status text not null,                -- pending | done | declined | cancelled | expired
  created_at integer not null, expires_at integer not null,
  battle_id integer
);

create table if not exists wagers (
  id integer primary key autoincrement,
  challenger_id text not null, target_id text not null,
  amount text not null,                -- whole tokens requested, as wei string
  status text not null,                -- pending_accept | awaiting_payment | complete | cancelled
  team_a text, team_b text,            -- json arrays of pokemon ids, locked at accept
  pay_a text, pay_b text,              -- unique wei amounts each side must send
  paid_a_tx text, paid_b_tx text,
  paid_a_from text, paid_b_from text,
  paid_a_amount text, paid_b_amount text,
  created_at integer not null,
  accepted_at integer, pay_deadline integer,
  winner integer, battle_id integer,
  cancel_reason text,
  finished_at integer
);

create table if not exists trades (
  id integer primary key autoincrement,
  from_id text not null, to_id text not null,
  offer_pokemon integer not null, want_pokemon integer,
  status text not null,                -- pending | accepted | declined | cancelled | expired
  created_at integer not null, resolved_at integer
);

create table if not exists tournaments (
  id integer primary key autoincrement,
  name text not null,
  prize text,
  status text not null,                -- open | done | cancelled
  created_at integer not null, finished_at integer,
  winner_id text,
  bracket text                          -- json
);
create table if not exists tournament_entries (
  tournament_id integer not null references tournaments(id),
  trainer_id text not null references trainers(id),
  joined_at integer not null,
  seed integer,
  primary key (tournament_id, trainer_id)
);

create table if not exists orders (
  id integer primary key autoincrement,
  trainer_id text not null,
  ball text not null,                  -- ultra | master
  qty integer not null,
  amount text not null,                -- unique wei amount
  status text not null,                -- pending | paid | expired
  created_at integer not null, expires_at integer not null,
  paid_tx text, paid_from text, paid_at integer
);

-- every token transfer INTO the pool wallet we have seen, matched or not
create table if not exists transfers (
  tx_hash text not null, log_index integer not null,
  from_addr text not null, amount text not null, block integer not null,
  matched_kind text, matched_id integer,
  seen_at integer not null,
  primary key (tx_hash, log_index)
);

-- every movement OUT of the pool, and every payment in, with its hash (the /stats page)
create table if not exists ledger (
  id integer primary key autoincrement,
  kind text not null,                  -- payment | payout | refund | burn
  ref_kind text not null,              -- wager | order | transfer
  ref_id integer not null,
  to_addr text, from_addr text,
  amount text not null,
  status text not null,                -- pending | sent | confirmed | failed | dry
  tx_hash text,
  raw_tx text,                         -- signed before broadcast, so a crash can never send twice
  nonce integer,
  tries integer not null default 0,
  error text,
  created_at integer not null, updated_at integer not null,
  unique (kind, ref_kind, ref_id, to_addr, amount)
);

create table if not exists mentions (
  id text primary key,                 -- post id, the idempotency key
  platform text not null,
  author_id text not null,
  handle text not null,
  text text not null,
  created_at integer not null,
  processed_at integer,
  command text,
  reply text,
  status text,                         -- replied | command | ignored | failed
  reply_id text,
  model integer not null default 0,    -- 1 when this mention cost a model call
  replied_at integer                   -- when the reply was actually posted (the hourly budget counts these)
);
create index if not exists mentions_processed on mentions(processed_at);
create index if not exists mentions_author on mentions(author_id, status, processed_at);

create table if not exists sessions (id text primary key, user text not null, expires_at integer not null);

-- a wallet link request: the exact message the trainer must sign, valid 10 minutes, used once
create table if not exists wallet_challenges (
  nonce text primary key,
  trainer_id text not null,
  address text not null,
  message text not null,
  expires_at integer not null
);
create table if not exists oauth_pending (state text primary key, verifier text not null, expires_at integer not null);
`

export function openDb(dataDir: string): DB {
  mkdirSync(dataDir, { recursive: true })
  const db = new DatabaseSync(join(dataDir, 'xpoke.db'))
  db.exec(SCHEMA)
  // columns added after the first schema: every table that lacks them gets them
  const cols = (t: string) => (db.prepare(`pragma table_info(${t})`).all() as { name: string }[]).map((c) => c.name)
  if (!cols('mentions').includes('model')) db.exec('alter table mentions add column model integer not null default 0')
  if (!cols('mentions').includes('replied_at')) {
    db.exec('alter table mentions add column replied_at integer')
    db.exec("update mentions set replied_at = processed_at where status = 'replied'")
  }
  if (!cols('ledger').includes('raw_tx')) db.exec('alter table ledger add column raw_tx text; alter table ledger add column nonce integer')
  if (!cols('ledger').includes('tries')) db.exec('alter table ledger add column tries integer not null default 0')
  // linked wallets: one per trainer, and a wallet belongs to at most one trainer
  if (!cols('trainers').includes('wallet')) db.exec('alter table trainers add column wallet text; alter table trainers add column wallet_linked_at integer')
  db.exec('create unique index if not exists trainers_wallet on trainers(wallet) where wallet is not null')
  // where each side of a wager is paid: the linked wallet at the moment the wager was accepted (null = the paying wallet)
  if (!cols('wagers').includes('payout_a')) db.exec('alter table wagers add column payout_a text; alter table wagers add column payout_b text')
  // token prizes: the amount (base units) paid automatically to the champion's wallet linked at join
  if (!cols('tournaments').includes('prize_amount')) db.exec('alter table tournaments add column prize_amount text')
  if (!cols('tournament_entries').includes('wallet')) db.exec('alter table tournament_entries add column wallet text')
  // wager allowance pulls: one per wager side, signed before sending like every outgoing transaction
  db.exec(`create table if not exists pulls (
    id integer primary key autoincrement,
    wager_id integer not null,
    side text not null,
    owner text not null,
    amount text not null,
    status text not null,              -- pending | signed | confirmed | skipped | failed
    raw_tx text, sig text, last_valid integer,
    error text,
    created_at integer not null, updated_at integer not null,
    unique (wager_id, side)
  )`)
  return db
}

export function now(): number {
  return Date.now()
}

/** Runs fn inside a transaction; nested calls join the outer one. */
let depth = 0
export function tx<T>(db: DB, fn: () => T): T {
  if (depth > 0) return fn()
  depth++
  db.exec('begin immediate')
  try {
    const r = fn()
    db.exec('commit')
    return r
  } catch (e) {
    db.exec('rollback')
    throw e
  } finally {
    depth--
  }
}

export function getMeta(db: DB, k: string): string | null {
  const r = db.prepare('select v from meta where k = ?').get(k) as { v: string } | undefined
  return r?.v ?? null
}
export function setMeta(db: DB, k: string, v: string): void {
  db.prepare('insert into meta (k, v) values (?, ?) on conflict(k) do update set v = excluded.v').run(k, v)
}
