# XPoke

**Catch, train & battle Pokémon on X.** Live at [xpoke.fun](https://xpoke.fun) · played by mentioning [@xpokefun](https://x.com/xpokefun).

XPoke is a Pokémon game that runs entirely through X posts. You reply `@xpokefun catch` to get your first
Pokémon, then feed it, battle trainers and gym leaders, evolve it, trade it, enter tournaments, and wager
**$XPOKE** (an SPL token on Solana) on 3v3 battles. The website shows your team, the Pokédex, live battles,
tournaments and every on-chain movement.

This repository is the whole thing: the X agent, the game engine, the Solana payment and payout code, and the
website. It is published so anyone can review how it works, and in particular how player money is handled.

---

## How it works

```
 X mentions ──► agent (rules parser, LLM fallback) ──► game engine ──► SQLite
                                        │                    │
                                        ▼                    ▼
                                 reply queue ──► X     Solana watcher / sender ◄──► pool wallet
                                                             ▲
 website (React) ◄──► HTTP API ──────────────────────────────┘
```

- **`server/src/agent.ts`**: polls mentions of the bot, runs each one as a command (one trainer's commands in
  order, different trainers in parallel), and queues replies. Replies leave through a paced queue with an hourly
  budget, so a new X account is never flooded; over the budget a command still runs and shows on `/agent`.
- **`server/src/game/`**: everything the game does. `parse.ts` understands every phrasing in the docs
  (`catch`, `feed my second berries`, `wager @rival 1000`…) without a model; `rules.ts` holds every number;
  `battle.ts` is the stat-based battle engine; `engine.ts`, `wager.ts`, `trade.ts`, `tournament.ts` the commands.
- **`server/src/llm.ts`**: only for posts the rules don't understand, and for chat. Its output is validated
  against a schema, re-checked against the post's own words (a wager amount or target must actually be written
  there; release needs the word "confirm"), and scrubbed of handles and links before anything is posted.
- **`server/src/pay/`**: Solana. Payment matching, the pool watcher, payouts, refunds, burns, wager allowances.
- **`web/`**: the website (Vite + React).

### The money

| What | Where it goes |
|---|---|
| **Ball purchases** (shop) | Paid into the pool wallet, then **100% burned** (SPL `burn`, total supply goes down). |
| **Wagers** (3v3) | Both stakes go into the pool; the winner receives **99%**, **1% is burned**. Refunded in full if a wager is cancelled. |
| **Tournament prizes** | Sent to the pool by the organiser, paid automatically to the champion. |

**Payments** are plain SPL transfers to the pool wallet. Each payment gets a unique amount (e.g. `1000.000243`)
so the watcher knows whose it is; wallets connect through the [Wallet Standard](https://github.com/wallet-standard/wallet-standard)
(Phantom, Solflare, Backpack…), and the site builds the exact transaction for the wallet to sign.

**Linked wallets**: a player can link a wallet to their X account by signing a plain message (free, no
transaction). Wager winnings and refunds then go to that wallet, whatever wallet paid. The payout address of a
wager is fixed **when the wager is accepted**, so changing the linked wallet later, or a stolen session, can
never redirect a running wager.

**Wager allowances** (optional): a player approves the pool as a delegate for up to an amount they choose. When
a wager they made or accepted on X starts, the server takes exactly that wager's stake, once, from their linked
wallet; the battle then runs with no website visit. Tokens stay in the player's wallet until then, and an
allowance can be revoked at any time.

### What protects player funds, and what it relies on

There is **no on-chain program**. The server is the escrow, and the pool wallet's key lives on the server.
That makes XPoke simple and cheap to run, and it means:

- **Every outgoing transaction passes a solvency check** (`solvencyProblem` in `pay/solana.ts`): what leaves for a
  wager can never exceed what that wager's players paid in; a shop order can only ever be burned, never paid to
  anyone; a refund can never exceed the transfer it refunds; a prize never exceeds the prize, and is only paid
  from what is left after every running wager's escrow. A row that fails the check is parked as `held`, not sent.
- **Every outgoing transaction is signed and stored before it is sent**, so a crash or restart can only ever
  re-send the same bytes, never pay twice. A transaction is only rebuilt once its blockhash has expired.
- **Payments are read from the chain, never trusted from the client.** The watcher reads the pool's token
  account history with an `until` cursor, never skips a transaction it cannot read, and drains bursts larger than
  one page.
- **Go-live refuses unsafe tokens**: a mint with a transfer fee, transfer hook, permanent delegate, default-frozen
  accounts or a freeze authority is rejected (`server/src/golive.ts`).
- **Trade-offs to know**: whoever controls the server key can move what is in the pool (running wager stakes,
  unpaid prizes) and draw up to each player's approved allowance. That is why allowances are capped by the player,
  revocable, and only ever used for the exact stake of a wager the player started or accepted.

Every payment, payout, refund and burn is listed with its Solana signature on [xpoke.fun/stats](https://xpoke.fun/stats).

---

## Running it locally

Requirements: Node 22.5+ (uses the built-in `node:sqlite`), npm. For the on-chain tests: the Solana CLI
(`solana-test-validator`, `spl-token`).

```bash
# the game server (fixture X source, no model, dev console on)
cd server && npm install
cp .env.example .env            # optional for local dev; the defaults run offline
DEV_MODE=1 LLM_ENABLED=0 npm run dev        # http://127.0.0.1:5340

# the website (proxies /api and /auth to :5340)
cd web && npm install && npm run dev

# the Pokémon sprites (not in this repo: Nintendo artwork)
scripts/fetch-sprites.sh

# play as anyone, exactly as a mention on X would arrive (DEV_MODE only)
server/scripts/play.sh ash "catch"
server/scripts/play.sh ash "wager @gary 1000"
```

With `DEV_MODE=1` the site has a `/dev` console to send mentions as any handle and a dev login. **Never run
production with `DEV_MODE=1`** (the deploy script refuses to).

## Tests

```bash
cd server
npm test                 # unit tests: parser (every docs phrasing), engine, wagers, locks, wallets, money rules
npx tsc --noEmit
```

On a local Solana validator (refuses any non-localhost RPC):

```bash
solana-test-validator --rpc-port 8961 --faucet-port 8964 --dynamic-port-range 9200-9230 --reset

SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/e2e-solana.ts        # pay, settle, payout, burn, refunds, 150-tx burst
SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/e2e-golive.ts        # the real go-live, unsafe-mint refusals
SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/e2e-allowance.ts     # wallets, allowances, prizes
SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/rehearse-launch.ts   # 600 mentions, shop, wagers, load
```

## Deploying

`deploy/` has a systemd unit, an hourly backup timer, a Caddy snippet and three scripts:

- `XPOKE_HOST=root@your-server deploy/deploy.sh`: runs the tests, builds the site, ships and restarts.
- `XPOKE_HOST=… deploy/go-ca.sh <MINT> --dry`, then without `--dry`: launch day, points XPoke at the token.
- `XPOKE_HOST=… deploy/restore.sh <snapshot>`: restores the database from a backup.

Configuration is `server/.env` (see `server/.env.example`); it holds secrets and is never committed.

---

## Credits & disclaimer

- Pokémon data (species, stats, types, evolutions) from [PokeAPI](https://pokeapi.co); sprites are fetched from
  [PokeAPI/sprites](https://github.com/PokeAPI/sprites) and are not included here.
- Pokémon and all related names are trademarks of Nintendo, Creatures Inc. and GAME FREAK inc. XPoke is a fan
  project and is not affiliated with, endorsed by or sponsored by them.
- XPoke takes inspiration from the game design of [poke-x.xyz](https://poke-x.xyz).
- $XPOKE is a community token with no promise of value. Wagers involve real tokens: only wager what you can afford to lose.

The code is released under the [MIT License](LICENSE). Found a security problem? See [SECURITY.md](SECURITY.md).
