import { Link } from 'react-router-dom'
import { useApi, useApp } from '../lib/hooks.ts'

const SECTIONS: [string, string][] = [
  ['quick-start', '1. Quick Start'],
  ['agent', 'The Agent & Platforms'],
  ['commands', '2. All Commands'],
  ['pokeballs', '3. Pokeball System'],
  ['catching', '4. Catching Pokémon'],
  ['feeding', '5. Feeding System'],
  ['evolution', '6. Evolution System'],
  ['boxes', '7. Box System'],
  ['battles', '8. Battle System (Real Stats)'],
  ['pvp', '9. PvP Challenges'],
  ['gyms', '10. Gym Battles + Medals'],
  ['wagers', '11. Wager System'],
  ['wallet', '12. Your Wallet'],
  ['trading', '13. Trading Pokémon'],
  ['tournament', '14. Tournament'],
  ['shiny', '15. Shiny Pokémon'],
  ['trainer-level', '16. Trainer Level'],
  ['cooldowns', '17. Cooldown Reference'],
  ['growth', '18. Growth & Leveling'],
  ['team', '19. Managing Your Team'],
  ['website', '20. Website Features'],
  ['tips', '21. Tips & Tricks'],
  ['open-source', '22. Open Source'],
  ['soon', '23. Coming Soon'],
]

function Cmd({ name, desc, eg }: { name: string; desc: string; eg: string[] }) {
  return (
    <div className="cmd">
      <div className="name">{name}</div>
      <div>{desc}</div>
      <div className="small faint">{eg.map((e) => `"${e}"`).join(' / ')}</div>
    </div>
  )
}

export default function Docs() {
  const { config } = useApp()
  const dex = useApi<{ total: number }>('/api/pokedex')
  const h = `@${config?.handle ?? 'xpokefun'}`
  const sym = `$${config?.token.symbol ?? 'XPOKE'}`
  const n = dex.data?.total ?? 471
  const host = typeof window !== 'undefined' ? window.location.host : ''

  return (
    <>
      <h1 className="page-title">How to Play XPoke</h1>
      <p className="page-sub">
        Catch Pokémon, train them, become a Pokémon Master. Everything happens on X by talking to{' '}
        <a href={`https://x.com/${config?.handle ?? ''}`} target="_blank" rel="noreferrer">
          {h}
        </a>
        .
      </p>
      <div className="docs">
        <nav>
          <div className="small faint" style={{ marginBottom: 6 }}>
            CONTENTS
          </div>
          {SECTIONS.map(([id, label]) => (
            <a key={id} href={`#${id}`}>
              {label}
            </a>
          ))}
        </nav>
        <div style={{ minWidth: 0 }}>
          <section id="quick-start">
            <h2>1. Quick Start</h2>
            <h3>Step 1: Find an XPoke post</h3>
            <p>Go to {h} on X and find any post.</p>
            <h3>Step 2: Say "catch"</h3>
            <p>Reply to the post with "catch" or "catch pokemon" or anything like that.</p>
            <h3>Step 3: Done</h3>
            <p>
              A free pokeball is thrown (40% catch chance). If it succeeds you get a random Pokémon with unique stats. If it breaks free, just try
              again.
            </p>
            <p>
              No slash commands needed. Just talk naturally: <code>catch pokemon</code>, <code>throw pokeball</code> or just <code>catch</code> all
              work.
            </p>
          </section>

          <section id="agent">
            <h2>The Agent & Platforms</h2>
            <p>
              XPoke is run by an AI agent. You play by mentioning it and typing a command in plain language. The agent reads it, runs the game logic
              and updates your account instantly.
            </p>
            <h3>Reply limit (3 per hour per user)</h3>
            <p>
              To keep the account healthy the agent posts at most <b>3 public replies per hour per user</b>. If you are over that limit, your
              command still runs and your game still updates. It just won't post a public reply. Nothing is lost.
            </p>
            <h3>Agent log (commands vs replies)</h3>
            <p>
              Every command the agent processes is listed at <Link to="/agent">{host}/agent</Link> and on the home page. Each one is tagged{' '}
              <span className="badge green">Replied</span> (the agent answered you on the platform) or <span className="badge grey">Command</span>{' '}
              (processed silently because it was over the hourly reply limit). So even when the agent stays quiet, you can always see your result
              there.
            </p>
            <h3>Platforms</h3>
            <p>X is the main platform and is live now: mention {h} to play.</p>
            <p>
              Reddit support is planned with the same commands (catch, check, feed, battle, evolve and the rest). It is offline for now and will be
              switched on in a later update. The live online / offline status of each platform is on the home page.
            </p>
          </section>

          <section id="commands">
            <h2>2. All Commands</h2>
            <p>Reply to any {h} post on X. No special format, just talk naturally.</p>
            <Cmd name="catch" desc="Catch a wild base-form Pokémon with a pokeball. Party max 3, overflow goes to your Box." eg={['catch', 'catch pokemon', 'throw pokeball']} />
            <Cmd name="check" desc='See your Pokémon stats. Say a name or number to check one, or just "check" for all.' eg={['check', 'check pikachu', 'how is my first']} />
            <Cmd name="feed" desc="Feed your Pokémon anything. 60-minute cooldown per Pokémon." eg={['feed', 'feed my second berries', 'give charizard pizza']} />
            <Cmd name="battle" desc="Battle a random trainer or a Gym Bot. 30-minute cooldown per Pokémon after each battle." eg={['battle', 'fight', '1v1', 'send charizard']} />
            <Cmd name="evolve" desc="Evolve your Pokémon once it hits the required level. Check the site to see if it's ready." eg={['evolve', 'evolve pikachu', 'evolve my first']} />
            <Cmd
              name="swap [name]"
              desc='Move a Pokémon from your Box into your active party. Party full? Say "swap [boxname] for [partyname]" to swap them.'
              eg={['swap gastly', 'swap gastly for pikachu']}
            />
            <Cmd name="release [name] confirm" desc='Permanently release a Pokémon. Must include "confirm" to prevent accidents.' eg={['release pikachu confirm', 'release my first confirm']} />
            <Cmd name="challenge @trainer (PvP)" desc='Challenge a specific trainer to a direct 1v1. They reply "accept" to battle.' eg={['challenge @trainer', 'pvp @trainer', 'battle @trainer']} />
            <Cmd
              name="accept / decline / cancel"
              desc='"accept" accepts your oldest pending PvP challenge. A wager is accepted with "accept" only when it is the only thing pending; otherwise say "accept wager" to confirm it and lock in your team of 3. "decline" refuses challenges, "decline wager" refuses a wager. "cancel" withdraws your own outgoing challenge, wager or trade.'
              eg={['accept', 'accept wager', 'decline', 'decline wager', 'cancel']}
            />
            <Cmd
              name="wager @trainer AMOUNT"
              desc={`Challenge a trainer to a ${sym}-staked 3v3 battle. Both must have 3 wager-eligible party Pokémon. Your opponent replies "accept wager", then both send the exact token amount shown at ${host}/me.`}
              eg={['wager @rival_gary 1000']}
            />
            <Cmd
              name="trade @trainer [your pokemon] for [their pokemon]"
              desc={`Propose a Pokémon trade. The other trainer accepts or declines at ${host}/me. Omit "for" to gift your Pokémon without asking for anything back.`}
              eg={['trade @rival_gary pikachu for charizard', 'trade @rival_gary eevee']}
            />
            <Cmd name="tournament join" desc="Join the current open tournament. 8-player single-elimination bracket." eg={['tournament join', `${h} tournament join`]} />
            <Cmd name="activity" desc="Send your Pokémon on an adventure with another trainer's Pokémon. 2-hour cooldown." eg={['walk', 'explore', 'take pikachu for a walk']} />
            <Cmd name="wallet" desc="See which Solana wallet is linked to your X account; wager winnings and refunds go there. Link or change it on the website." eg={['wallet', 'where do i get paid']} />
            <Cmd name="help" desc="Show a quick command list in the reply." eg={['help', 'commands', 'how do i play']} />
            <Cmd name="chat" desc="Ask anything about Pokémon or the game and XPoke will talk back." eg={['whats the best fire type?', 'tell me about ghost pokemon']} />
          </section>

          <section id="pokeballs">
            <h2>3. Pokeball System</h2>
            <p>
              Three pokeball tiers. Better balls mean a higher catch rate and shiny rate. Buy them at <Link to="/shop">{host}/shop</Link> or from
              your profile.
            </p>
            <ul>
              <li>
                <b>Pokeball (free)</b>: 40% catch rate, 1% shiny. You get 5 free pokeballs every day at midnight UTC. Purchased pokeballs stack on top
                of your free ones.
              </li>
              <li>
                <b>Ultra Ball (2,000 {sym})</b>: 65% catch rate, 4% shiny. Best value for shiny hunters: 4x the shiny odds of a regular pokeball.
              </li>
              <li>
                <b>Master Ball (5,000 {sym})</b>: 85% catch rate, 8% shiny. Pity system: after 10 failed throws in a row, the next master ball throw
                is guaranteed to succeed. The counter resets on any successful catch.
              </li>
            </ul>
            <h3>Using balls on X</h3>
            <ul>
              <li>Default: "catch" uses a regular pokeball (free daily stock first)</li>
              <li>Ultra Ball: "catch ultra ball" or "ultra ball catch"</li>
              <li>Master Ball: "catch master ball" or "master ball catch"</li>
              <li>The bot tells you how many of that type you have left after each throw</li>
            </ul>
            <h3>Buying pokeballs</h3>
            <pre>{`go to ${host}/shop or click "Buy Pokeballs" on your profile
select ball type and quantity
get a unique ${sym} amount (e.g. 2000.000243)
send exactly that amount to the pool wallet on Solana (or tap "Pay with wallet" / "Open in wallet")
balls are added automatically as soon as the transfer lands (or click confirm)
every ${sym} paid for balls is then burned: 100% of it, the supply goes down`}</pre>
          </section>

          <section id="catching">
            <h2>4. Catching Pokémon</h2>
            <p>
              Only base-form (stage 1) Pokémon can be caught in the wild: <b>{n} species</b> across all 8 generations. Higher evolutions must be
              reached through evolution.
            </p>
            <ul>
              <li>
                <b>Catch rate</b>: set by the ball you throw (40% / 65% / 85%).
              </li>
              <li>
                <b>Party limit</b>: max 3 Pokémon in your active party.
              </li>
              <li>
                <b>Overflow</b>: if your party is full, the caught Pokémon goes straight to Box 1.
              </li>
              <li>
                <b>Stage 1 only</b>: all wild Pokémon are base-form. No evolved forms in the wild.
              </li>
              <li>
                <b>Rarity</b>: common Pokémon turn up most, legendaries and mythicals rarely.
              </li>
              <li>
                <b>Shiny chance</b>: 1% to 8% depending on the ball. The bot says "a shiny one!" if you hit it.
              </li>
            </ul>
            <pre>{`you: "catch pokemon"
xpoke: "gotcha! you caught Bulbasaur the Grass/Poison type.
        feed them, check on them or battle anytime"`}</pre>
          </section>

          <section id="feeding">
            <h2>5. Feeding System</h2>
            <p>Feed your Pokémon to keep them happy, grow them and increase their feed count.</p>
            <ul>
              <li>"feed" feeds your first Pokémon</li>
              <li>"feed my second berries" picks which Pokémon and what food</li>
              <li>You can give them anything: pizza, ramen, berries...</li>
              <li>
                <b>Cooldown</b>: 60 minutes per Pokémon between feeds.
              </li>
              <li>
                <b>Growth</b>: feed count raises the growth stage (Baby → Teen → Adult).
              </li>
            </ul>
            <p>Hungry Pokémon are unhappy Pokémon. Feed them regularly.</p>
          </section>

          <section id="evolution">
            <h2>6. Evolution System</h2>
            <p>Train your Pokémon through battles to hit the required level, then evolve them into their next form.</p>
            <h3>How to evolve</h3>
            <ol>
              <li>Battle to earn XP and level up your Pokémon</li>
              <li>
                Check <Link to="/me">{host}/me</Link>: a green <span className="badge green">Ready to Evolve</span> badge appears when it's time
              </li>
              <li>Reply to an {h} post with "evolve" or "evolve [name]"</li>
              <li>Your Pokémon transforms and its sprite updates on the site</li>
            </ol>
            <p>
              <b>Branching evolutions</b>: some Pokémon have several paths (Slowpoke → Slowbro or Slowking, Eevee → 8 forms). The first branch is used
              for now.
            </p>
            <p>
              <b>Level requirements vary</b>: Caterpie → Metapod at Lv.7, Bulbasaur → Ivysaur at Lv.16, Magikarp → Gyarados at Lv.20. Evolutions that
              normally need a stone, trade or friendship evolve by level here (Lv.20 into a second stage, Lv.36 into a third). Check the{' '}
              <Link to="/pokedex">Pokédex</Link> for any Pokémon's evolution level.
            </p>
            <p>Stage 1 = base form (catchable in the wild) · Stage 2 = first evolution · Stage 3 = final evolution. Stages 2 and 3 only via evolve.</p>
          </section>

          <section id="boxes">
            <h2>7. Box System (Box 1 & Box 2)</h2>
            <p>Your party holds 3 active Pokémon. Extra Pokémon are stored in Box 1 and Box 2.</p>
            <ul>
              <li>
                <b>Active party (max 3)</b>: can battle, feed, evolve and be used in PvP and wagers
              </li>
              <li>
                <b>Box 1 & Box 2</b>: storage, no active actions
              </li>
              <li>
                <b>Overflow</b>: when your party is full and you catch a new Pokémon, it goes to Box 1 automatically
              </li>
            </ul>
            <h3>Swap via X</h3>
            <ul>
              <li>"swap gastly" moves Gastly from your box into your party (if there is space)</li>
              <li>"swap gastly for pikachu" swaps them when your party is full</li>
            </ul>
            <h3>Manage on the website</h3>
            <ul>
              <li>Log in with your X account</li>
              <li>
                Go to <Link to="/me">My Pokémon (/me)</Link> to see Party, Box 1 and Box 2
              </li>
              <li>Click "→ Party" on a box card to bring it into your party, "Send to Box" on a party card to store it, "→ Box 2" to move between boxes</li>
            </ul>
            <p>
              <b>Battle lock</b>: a Pokémon with a pending PvP challenge or wager is locked and cannot be swapped until it resolves or expires (30
              min for challenges). A Pokémon in a pending wager can't be evolved or battled either: the opponent agreed to the team as shown. A
              Pokémon in a pending trade is locked too (no swap, box, release, evolve or wager) until the trade resolves.
            </p>
            <p>
              <b>Wager eligibility</b>: only party Pokémon (not boxed) are used in wagers. Your active team of 3 is locked in when you challenge or
              accept.
            </p>
          </section>

          <section id="battles">
            <h2>8. Battle System (Real Stats)</h2>
            <p>Every Pokémon has real base stats from the official Pokédex. Species matters: a Mewtwo at Lv.1 is genuinely stronger than a Rattata at Lv.1.</p>
            <ul>
              <li>Each species has real HP, Attack, Defense and Speed from the Pokédex, plus its own unique IVs.</li>
              <li>Effective stats scale with level. Attack grows faster than defense, so higher levels hit harder.</li>
              <li>Speed decides who attacks first each round: the faster Pokémon always goes first.</li>
              <li>
                Level also improves speed: <code>effectiveSpeed = baseSpeed + level × 2</code>.
              </li>
              <li>Type advantages apply: Fire beats Grass, Psychic beats Fighting, and so on.</li>
              <li>10 rounds max. If both are standing, the winner is whoever has more HP% left.</li>
            </ul>
            <h3>Species tiers (same level)</h3>
            <p>Legendary (Mewtwo, Rayquaza) beats pseudo-legendary (Dragonite, Salamence) beats fully evolved starters (Charizard, Blastoise) beats base stage (Pikachu, Eevee, Rattata).</p>
            <h3>Level gap</h3>
            <p>Pikachu crosses over a Lv.1 Mewtwo at about Lv.52. A Lv.100 Rattata beats a Lv.1 Mewtwo: grind matters.</p>
            <h3>XP</h3>
            <ul>
              <li>Win vs player = +25 XP · Lose vs player = -25 XP (protected at Lv.1–2)</li>
              <li>Win vs Gym Bot = +25 XP · Lose vs Gym Bot = -50 XP</li>
              <li>XP never goes below 0. Level never decreases.</li>
            </ul>
            <p>
              <b>30-minute battle cooldown per Pokémon.</b> Rotate your 3 party Pokémon to battle every ~10 minutes.
            </p>
          </section>

          <section id="pvp">
            <h2>9. PvP Challenges</h2>
            <p>Call out a specific trainer on X for a direct 1v1 Pokémon battle.</p>
            <ol>
              <li>You: "challenge @rival": challenge sent, your Pokémon is locked</li>
              <li>Rival: "accept": the battle resolves automatically</li>
              <li>Both trainers get the XP result posted on X</li>
              <li>Your Pokémon unlocks after the battle</li>
            </ol>
            <ul>
              <li>"challenge @trainer" / "pvp @trainer" / "battle @trainer" sends a challenge</li>
              <li>"accept" accepts the oldest pending challenge</li>
              <li>"decline" declines all incoming</li>
              <li>"cancel" cancels your outgoing challenge (unlocks your Pokémon)</li>
              <li>Challenges expire after 30 minutes and the Pokémon unlocks automatically</li>
              <li>Several trainers can challenge you; they queue up</li>
            </ul>
            <p>Win = +25 XP · Lose = -25 XP (never below 0).</p>
          </section>

          <section id="gyms">
            <h2>10. Gym Battles + Medals</h2>
            <p>
              When no real opponent is within ±5 levels, XPoke sends in a Gym Bot. Beat them to earn a medal on your profile. 13 gyms scale from Lv.3
              to Lv.200.
            </p>
            <pre>{`1. Cheren (Rattata Lv.3)         2. Skyla (Pidgeot Lv.10)
3. Elesa (Raichu Lv.18)          4. Shauntal (Gengar Lv.28)
5. Drayden (Dragonite Lv.40)     6. Caitlin (Mewtwo Lv.55)
7. Marlon (Gyarados Lv.70)       8. Grimsley (Mega Houndoom Lv.90)
9. Iris (Salamence Lv.110)      10. Colress (Metagross Lv.130)
11. N (Rayquaza Lv.150)         12. Ghetsis (Mega Mewtwo X Lv.175)
13. Alder (Kyogre Lv.200)`}</pre>
            <ul>
              <li>Beat a Gym Leader to earn that gym's medal on your /me profile.</li>
              <li>Each medal is awarded once: you can't farm the same gym.</li>
              <li>Gym Bots are stronger than average players (more power, more HP).</li>
              <li>Losing to a gym costs 50 XP vs 25 for a player loss.</li>
            </ul>
          </section>

          <section id="wagers">
            <h2>11. Wager System (Solana)</h2>
            <p>
              Stake {sym} on a 3v3 Pokémon battle. Both trainers bring a full team of 3. {sym} is an SPL token on Solana and payments come from any
              Solana wallet (Phantom, Solflare, Backpack...), with the network fee paid in SOL. No account linking is needed: send the exact amount
              shown to the pool wallet, tap "Pay with wallet", or open the Solana Pay link.
            </p>
            <p>
              <b>Eligibility</b>: you and your opponent each need exactly 3 wager-eligible party Pokémon. The challenger's team locks when the wager is sent, the opponent's when they reply "accept wager".
            </p>
            <h3>How to start a wager</h3>
            <ol>
              <li>Reply "{h} wager @opponent 1000" on any post (amount in {sym})</li>
              <li>The bot confirms your team of 3 and tags your opponent</li>
              <li>Your opponent replies "accept wager" to lock in their team (a plain "accept" also works when the wager is the only thing pending)</li>
              <li>
                Log in at <Link to="/me">{host}/me</Link> to see your unique payment amount
              </li>
              <li>Send the exact amount (e.g. 1000.000243) to the pool wallet on Solana, manually or with "Pay with wallet"</li>
              <li>Click "Check Payment". Once both sides have paid, the battle runs automatically</li>
            </ol>
            <p>
              <b>With a wager allowance</b> (see <a href="#wallet">Your Wallet</a>), "accept wager" is all it takes: XPoke takes each side's exact
              stake from their linked wallet the moment the wager is accepted. Without one, both sides pay by hand within 15 minutes.
            </p>
            <h3>3v3 battle format</h3>
            <ul>
              <li>Pokémon fight one on one in sequence: first vs first, and so on.</li>
              <li>HP carry-over: the winner of each duel keeps its remaining HP into the next fight.</li>
              <li>The first trainer to knock out all 3 of the opponent's Pokémon wins.</li>
            </ul>
            <ul>
              <li>
                <b>Unique amounts</b>: each side gets a unique fractional amount (e.g. 1000.000243 {sym}) so the system knows which payment belongs to
                whom. Do not round it.
              </li>
              <li>
                <b>15-minute window</b>: both trainers must pay within 15 minutes of accepting. Miss it and the wager cancels; anyone who paid is
                refunded automatically.
              </li>
              <li>
                <b>Fee</b>: 1% of the total pot is burned on chain, removed from supply forever. The winner takes 99% of what both sides sent. Every
                payment, payout, refund and burn is listed with its Solana signature at <Link to="/stats">/stats</Link>. Winnings and refunds go to your linked wallet as it was when the wager was accepted, or, with no linked wallet, back to the wallet that paid.
              </li>
              <li>
                <b>Cancel</b>: always available before acceptance and for accepted wagers where nobody has paid yet. Once a payment is made, cancel
                opens only after the 15-minute deadline. Unaccepted wagers auto-cancel after 24 hours.
              </li>
              <li>
                <b>Battle lock</b>: your team is locked while a wager is pending and released when it completes or cancels. Locked Pokémon can't be
                swapped, boxed, released, evolved or battled: the opponent agreed to the team as shown.
              </li>
              <li>
                <b>Wallet</b>: link a wallet at <Link to="/wallet">/wallet</Link> first (see <a href="#wallet">Your Wallet</a>). Without one, pay
                from a wallet you control (Phantom, Solflare, Backpack…), never from an exchange: payouts and refunds go back to the wallet that paid.
              </li>
            </ul>
            <pre>{`Example, a 1000 ${sym} wager:
Alice sends 1000.000243, Bob sends 1000.000571
the pool holds 2000.000814
Alice's team wins the 3v3
Alice's paying wallet receives ~1,980 ${sym} (99%)
~20 ${sym} is burned with an SPL burn, so total supply drops`}</pre>
            <div className="kv" style={{ marginTop: 10 }}>
              <span>Token mint</span>
              <span className="mono break">{config?.token.mint ?? 'announced soon'}</span>
              <span>Pool wallet</span>
              <span className="mono break">{config?.pool ?? 'announced with the token'}</span>
              <span>Network</span>
              <span>Solana mainnet · SPL token · fees in SOL</span>
              <span>Explorer</span>
              <a href="https://solscan.io" target="_blank" rel="noreferrer">
                solscan.io
              </a>
            </div>
            <p>One active wager per trainer at a time. Minimum 1 {sym}.</p>
          </section>

          <section id="wallet">
            <h2>12. Your Wallet</h2>
            <p>
              Link a Solana wallet to your X account and every wager payout and refund goes there, whichever wallet you pay from. That makes paying
              from an exchange safe.
            </p>
            <h3>How to link</h3>
            <ol>
              <li>
                Log in at <Link to="/wallet">/wallet</Link> with your X account
              </li>
              <li>Click "Connect wallet" and pick Phantom, Solflare, Backpack or another Solana wallet</li>
              <li>Sign the message. It is one free signature: no transaction, no fee, nothing moves</li>
            </ol>
            <ul>
              <li>
                <b>Snapshot at acceptance</b>: a wager pays the wallet that was linked when it was accepted. Changing or unlinking later never redirects
                a wager that is already running.
              </li>
              <li>You can still pay from any wallet; only where the money comes back is fixed.</li>
              <li>No wallet linked: winnings and refunds go back to the wallet you paid from.</li>
              <li>On X, say "wallet" and the agent replies with the wallet linked to your account.</li>
              <li>Change or unlink it anytime at /wallet.</li>
            </ul>
            <h3>Wager allowance</h3>
            <p>
              Skip paying by hand: on <Link to="/wallet">/wallet</Link>, approve XPoke to take up to an amount of {sym} from your linked wallet. When a
              wager you made or accepted on X is accepted, XPoke takes exactly that wager's stake, nothing else.
            </p>
            <ul>
              <li>Your tokens stay in your wallet until a wager is accepted. Approving is one transaction from the linked wallet; revoking is another.</li>
              <li>Revoke anytime on /wallet. If the allowance is too small, revoked or replaced, you just pay by hand within the 15 minutes.</li>
              <li>Solana allows one approval per token account, so approving another app replaces XPoke's.</li>
              <li>The key that uses the allowance lives on XPoke's server: only approve what you're comfortable wagering.</li>
            </ul>
          </section>

          <section id="trading">
            <h2>13. Trading Pokémon</h2>
            <p>Propose a swap with any trainer on X. The other trainer accepts or declines on the website.</p>
            <ol>
              <li>Reply "trade @trainer [your pokemon] for [their pokemon]"</li>
              <li>The bot posts a confirmation tagging both trainers</li>
              <li>
                The other trainer logs in at <Link to="/me">{host}/me</Link> and sees Accept / Decline
              </li>
              <li>Accept: both Pokémon swap owners instantly</li>
              <li>Decline: the trade is cancelled and nothing moves</li>
            </ol>
            <p>Gift: "trade @trainer [pokemon]" sends it without asking for anything back.</p>
            <p>Only active party Pokémon can be traded. One pending trade per trainer at a time. Offers expire after 24 hours. Both Pokémon are locked while the trade is pending: no swap, box, release, evolve or wager until it resolves.</p>
            <pre>{`you: "trade @rival_gary pikachu for charizard"
xpoke: "@trainer_ash @rival_gary trade offer: trainer_ash's Pikachu for
        rival_gary's Charizard. rival_gary, login at ${host}/me and accept or decline"`}</pre>
          </section>

          <section id="tournament">
            <h2>14. Tournament</h2>
            <p>
              8-player single elimination. Join on X, battles run automatically, the bracket is public at <Link to="/tournament">{host}/tournament</Link>.
            </p>
            <ul>
              <li>When a tournament is open, reply "tournament join" to any {h} post, or click "Join Tournament" on the site</li>
              <li>The first 8 trainers to sign up are seeded 1–8 by wins</li>
              <li>Quarterfinals → Semifinals → Final, seeded 1 vs 8, 2 vs 7, 3 vs 6, 4 vs 5</li>
              <li>Each match uses both trainers' strongest-level party Pokémon, with real species stats and the level formula</li>
              <li>Results are posted publicly on X</li>
              <li>Prize: set by the organizer ({sym}, bragging rights, or both)</li>
              <li>
                Token prizes are paid automatically to the champion's wallet as it was linked when they joined. A linked wallet is needed to join a
                prize tournament (link one at <Link to="/wallet">/wallet</Link>).
              </li>
            </ul>
          </section>

          <section id="shiny">
            <h2>15. Shiny Pokémon</h2>
            <p>Rare variants of any catchable Pokémon with a different coloured sprite and a purple <span className="badge purple">shiny</span> badge.</p>
            <ul>
              <li>Chance: 1% with a pokeball, 4% with an ultra ball, 8% with a master ball.</li>
              <li>Same stats as the normal form: shiny is bragging rights, not a boost.</li>
              <li>Shinies are rarer than legendaries in practice, so they carry high trade and wager value.</li>
            </ul>
          </section>

          <section id="trainer-level">
            <h2>16. Trainer Level</h2>
            <p>Your own level as a trainer, separate from Pokémon levels, based on total battle wins and shown as "Trainer Lv.X" on your profile.</p>
            <pre>{`Lv.1 = 0 wins    Lv.2 = 2 wins    Lv.3 = 4 wins    Lv.4 = 7 wins    Lv.5 = 12 wins
Lv.6 = 20 wins   Lv.7 = 35 wins   Lv.8 = 60 wins   Lv.9 = 100 wins  Lv.10 = 200 wins`}</pre>
            <ul>
              <li>Releasing a Pokémon does not reset your trainer level: wins are yours forever.</li>
              <li>The leaderboard ranks trainers by total wins.</li>
              <li>Every battle type counts: PvP, gym bots, random battles, wagers and tournaments.</li>
            </ul>
          </section>

          <section id="cooldowns">
            <h2>17. Cooldown Reference</h2>
            <p>All cooldowns are per Pokémon, not per trainer. Rotate your party to keep playing.</p>
            <pre>{`battle    30 min per pokemon (regular and PvP)
feed      60 min per pokemon
activity  2 hrs per pokemon
pvp lock  30 min (auto-expires if not accepted)`}</pre>
          </section>

          <section id="growth">
            <h2>18. Growth & Leveling</h2>
            <p>Two separate systems: growth stage (from feeding) and level (from battles).</p>
            <ul>
              <li>Baby: 0–2 feeds · Teen: 3–5 feeds · Adult: 6+ feeds</li>
              <li>Every win earns +25 XP. 100 XP fills the bar and the Pokémon levels up.</li>
              <li>Higher level means better battle stats and unlocks evolution.</li>
            </ul>
            <h3>XP protection for new Pokémon</h3>
            <ul>
              <li>Lv.1–2: no XP lost on defeat</li>
              <li>Lv.3–4: reduced loss (-10 vs player, -20 vs gym)</li>
              <li>Lv.5+: full XP stakes</li>
            </ul>
          </section>

          <section id="team">
            <h2>19. Managing Your Team</h2>
            <ul>
              <li>By name: "feed charizard", "battle pikachu"</li>
              <li>By number: "check my first", "battle my 2nd"</li>
              <li>No pick: the first Pokémon in your party (for battles, the first one that is rested)</li>
              <li>"release pikachu confirm" frees a slot. It must include "confirm", and the Pokémon is gone for good.</li>
            </ul>
            <p>Keep varied types for type advantages, and use your boxes for Pokémon you want to keep but aren't training.</p>
          </section>

          <section id="website">
            <h2>20. Website Features</h2>
            <ul>
              <li>
                <b>Login with X → My Pokémon (/me)</b>: party and both boxes, Ready to Evolve badges, swap buttons, red locked banners, trades,
                wagers and ball balances.
              </li>
              <li>
                <b>Pokédex (/pokedex)</b>: all {n} catchable base forms. Filter by type or rarity, search by name, sort A–Z, by most owned or by
                rarity, and see how many trainers own each one. Rarity tiers: Common → Uncommon → Rare → Legendary → Mythical.
              </li>
              <li>
                <b>Leaderboard</b> (home page): top trainers by total wins, live.
              </li>
              <li>
                <b>Leaderboards (/leaderboards)</b>: five boards, trainers by wins, gym medals, highest-level Pokémon, shiny collectors and wager
                winners, refreshed every 30 seconds.
              </li>
              <li>
                <b>Shop, Tournament, Agent log and on-chain Stats</b> pages.
              </li>
            </ul>
          </section>

          <section id="tips">
            <h2>21. Tips & Tricks</h2>
            <ul>
              <li>Rotate your 3 party Pokémon to battle every 10 minutes instead of waiting 30</li>
              <li>Check /me: green badge = ready to evolve, don't wait</li>
              <li>Use type advantages in PvP: Psychic beats Fighting, Water beats Fire</li>
              <li>Legendaries (Mewtwo, Rayquaza) are genuinely stronger: hunt or trade for them</li>
              <li>Wager only when your team of 3 is strong: all 3 fight with HP carry-over</li>
              <li>Never round wager or shop amounts: the decimals fingerprint your payment</li>
              <li>Trainer level persists even if you release Pokémon: grind wins, not Pokémon count</li>
            </ul>
            <pre>{`"catch pokemon" / "throw pokeball" / "catch"      = catch
"how is pikachu" / "check my first" / "status"     = check
"give berries" / "feed ramen" / "feed"            = feed
"lets fight" / "1v1" / "battle my second"         = battle
"evolve" / "evolve pikachu" / "make it evolve"    = evolve
"swap gastly" / "bring gastly out"                = swap from box
"wager @rival_gary 1000"                          = a 1000 ${sym} wager
"trade @rival_gary pikachu for charizard"         = propose a trade
"tournament join"                                 = join the open tournament`}</pre>
          </section>

          <section id="open-source">
            <h2>22. Open Source</h2>
            <p>
              XPoke is open source under the MIT license: the X agent, the game engine, the Solana payment and payout code, and this website.
              Read it, run it locally, or review how player money is handled at{' '}
              <a href="https://github.com/xpokefun/XPoke" target="_blank" rel="noreferrer">
                github.com/xpokefun/XPoke
              </a>
              .
            </p>
            <ul>
              <li>Every payment, payout, refund and burn checks a solvency rule before it is sent, and is listed with its Solana signature on /stats.</li>
              <li>There is no on-chain program: the server holds the pool wallet and acts as escrow. The README explains exactly what that means.</li>
              <li>Found a security problem? Please report it privately (see SECURITY.md in the repo), not in a public issue.</li>
            </ul>
          </section>

          <section id="soon">
            <h2>23. Coming Soon</h2>
            <ul>
              <li>
                <b>Quests</b>: daily and weekly quests for {sym} rewards, rare Pokémon and badges.
              </li>
              <li>
                <b>Clans</b>: form clans, clan battles, shared leaderboards, group tournaments.
              </li>
              <li>
                <b>Trainer shipments</b>: gift starter packages to bring new trainers in.
              </li>
            </ul>
            <p>Follow {h} on X for every update.</p>
          </section>
        </div>
      </div>
    </>
  )
}
