/**
 * Plain-language commands → Command.
 *
 * Rules first: every phrasing the docs list is matched here without a model call. Anything the rules
 * do not recognise goes to the LLM (llm.ts), which either maps it to a command or answers it as chat.
 */
import { speciesByName, normName } from './data.ts'
import type { Command, Pick } from './commands.ts'

const ORDINALS: [RegExp, number][] = [
  [/\b(first|1st|one|#1|number 1|no\.? ?1|slot 1)\b/, 0],
  [/\b(second|2nd|two|#2|number 2|no\.? ?2|slot 2)\b/, 1],
  [/\b(third|3rd|three|#3|number 3|no\.? ?3|slot 3)\b/, 2],
]

const HANDLE = /@([A-Za-z0-9_]{1,15})/g

export type Parsed = { command: Command; targets: string[] } | null

export function handlesIn(text: string, bot: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(HANDLE)) {
    const h = m[1]!
    if (h.toLowerCase() !== bot.toLowerCase() && !out.some((o) => o.toLowerCase() === h.toLowerCase())) out.push(h)
  }
  return out
}

/**
 * Handles in the reply-chain prefix ("@bob @xpokefun challenge" posted under bob's post), without the bot.
 * They are who the thread is with, so a command that needs a target but names none falls back to them.
 */
export function threadHandles(text: string, bot: string): string[] {
  const m = /^(\s*@[A-Za-z0-9_]{1,15})+/.exec(text.replace(/https?:\/\/\S+/g, ' '))
  return m ? handlesIn(m[0], bot) : []
}

/** Strips the reply-chain prefix ("@a @b ...") and the bot's own handle. */
export function cleanText(text: string, bot: string): string {
  let t = text.replace(/https?:\/\/\S+/g, ' ')
  // the reply-chain prefix ("@playpokex @alice ...") names who is in the thread, not a target
  t = t.replace(/^(\s*@[A-Za-z0-9_]{1,15})+/, ' ')
  t = t.replace(new RegExp(`@${bot}\\b`, 'gi'), ' ')
  return t.replace(/\s+/g, ' ').trim()
}

/** First species name mentioned, checking two-word names before single words. */
export function speciesIn(text: string): string | null {
  const words = text
    .toLowerCase()
    .replace(/@[a-z0-9_]+/g, ' ')
    .split(/[^a-z0-9.'♀♂:-]+/)
    .filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const two = words[i + 1] ? speciesByName(`${words[i]} ${words[i + 1]}`) : null
    if (two) return two.name
    const one = speciesByName(words[i]!)
    if (one && normName(words[i]!).length >= 3) return one.name
  }
  return null
}

/** Every species name in order of appearance (for "swap gastly for pikachu"). */
function speciesList(text: string): string[] {
  const out: string[] = []
  const words = text.toLowerCase().replace(/@[a-z0-9_]+/g, ' ').split(/[^a-z0-9.'♀♂:-]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const two = words[i + 1] ? speciesByName(`${words[i]} ${words[i + 1]}`) : null
    if (two) {
      out.push(two.name)
      i++
      continue
    }
    const one = speciesByName(words[i]!)
    if (one && normName(words[i]!).length >= 3) out.push(one.name)
  }
  return out
}

function pickFrom(text: string): Pick | undefined {
  const name = speciesIn(text)
  if (name) return { name }
  const lower = text.toLowerCase()
  for (const [re, i] of ORDINALS) if (re.test(lower)) return { index: i }
  return undefined
}

function amountIn(text: string): number | null {
  const m = text.replace(/@[A-Za-z0-9_]+/g, ' ').match(/(\d[\d,]*(?:\.\d+)?)\s*(k|m)?\b/i)
  if (!m) return null
  let n = Number(m[1]!.replace(/,/g, ''))
  const suffix = m[2]?.toLowerCase()
  if (suffix === 'k') n *= 1_000
  if (suffix === 'm') n *= 1_000_000
  return Number.isFinite(n) ? n : null
}

const FOOD_STOP = new Set(
  'feed give gave my the a an some to it them him her his their pokemon pokémon poke please pls plz with and eat eats food snack snacks this that our your yummy delicious lunch dinner breakfast hungry is are who for of on in now'.split(
    ' ',
  ),
)

function foodIn(text: string, pick: Pick | undefined): string | undefined {
  let t = text.toLowerCase().replace(/@[a-z0-9_]+/g, ' ')
  if (pick?.name) t = t.replace(new RegExp(pick.name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), ' ')
  for (const [re] of ORDINALS) t = t.replace(new RegExp(re.source, 'g'), ' ')
  const words = t
    .split(/[^a-z0-9' -]+|\s+/)
    .map((w) => w.trim())
    .filter((w) => w && !FOOD_STOP.has(w))
  const food = words.join(' ').trim()
  return food ? food.slice(0, 40) : undefined
}

export function parseCommand(raw: string, bot: string): Command | null {
  const text = cleanText(raw, bot)
  const lower = text.toLowerCase()
  // handles written in the command itself; a target command with none falls back to the thread's handles
  const inline = handlesIn(text, bot)
  const targets = inline.length ? inline : threadHandles(raw, bot)
  // a bare tag or a lone link: not a command (the agent answers those with help at most once a day)
  if (!lower.replace(/@[a-z0-9_]+/g, '').trim()) return null

  const has = (re: RegExp) => re.test(lower)

  // wager @x 1000
  if (has(/\b(wager|bet|stake)\b/) && targets.length) {
    const amount = amountIn(text)
    if (amount !== null) return { kind: 'wager', target: lastTargetAfter(text, /\b(wager|bet|stake)\b/i, targets), amount }
  }

  // trade @x pikachu for charizard  /  trade @x eevee
  if (has(/\b(trade|gift|send)\b/) && targets.length && has(/\b(trade|gift)\b/)) {
    const target = lastTargetAfter(text, /\b(trade|gift)\b/i, targets)
    const after = text.slice(text.toLowerCase().indexOf(`@${target.toLowerCase()}`) + target.length + 1)
    const [left, right] = after.split(/\bfor\b/i)
    const offer = speciesIn(left ?? '')
    const want = right !== undefined ? speciesIn(right) : null
    if (offer) return { kind: 'trade', target, offer, ...(want ? { want } : {}) }
  }

  if (has(/\btournament\b/) && has(/\b(join|enter|register|sign|in)\b/)) return { kind: 'tournament_join' }

  if (has(/\brelease\b/)) return { kind: 'release', pick: pickFrom(text.replace(/\brelease\b/i, '')), confirm: has(/\bconfirm(ed)?\b/) }

  if (has(/\b(swap|switch)\b/) || has(/\bbring\b.*\bout\b/)) {
    const names = speciesList(text)
    if (names[0]) return { kind: 'swap', box: names[0], ...(names[1] ? { party: names[1] } : {}) }
  }

  // challenge @trainer / pvp @trainer / battle @trainer ("challenge" alone under somebody's post targets them)
  if ((targets.length && has(/\b(challenge|challenges|pvp)\b/)) || (inline.length && has(/\b(battle|fight|duel|1v1|vs)\b/))) {
    return {
      kind: 'challenge',
      target: lastTargetAfter(text, /\b(challenge|pvp|battle|fight|duel|1v1|vs)\b/i, targets),
      pick: pickFrom(text.replace(/@[A-Za-z0-9_]+/g, ' ')),
    }
  }

  if (has(/^(i )?(accept|accepted|accepting)\b/) || has(/\baccept\b/))
    return { kind: 'accept', pick: pickFrom(text), ...(has(/\b(wager|bet|stake)\b/) ? { wager: true } : {}) }
  if (has(/\b(decline|declined|reject|no thanks)\b/)) return { kind: 'decline', ...(has(/\b(wager|bet|stake)\b/) ? { wager: true } : {}) }
  if (has(/\b(cancel|withdraw|nevermind|never mind)\b/)) return { kind: 'cancel' }

  if (has(/\b(catch|throw|pokeball|poke ball|pokéball|ultra ball|master ball|ultraball|masterball)\b/)) {
    const ball = has(/\bmaster ?ball\b|\bmaster\b/) ? 'master' : has(/\bultra ?ball\b|\bultra\b/) ? 'ultra' : 'poke'
    return { kind: 'catch', ball }
  }

  if (has(/\bevol(ve|ution|ving)\b/)) return { kind: 'evolve', pick: pickFrom(text) }

  if (has(/\b(feed|give|eat|snack)\b/)) {
    const pick = pickFrom(text)
    return { kind: 'feed', pick, food: foodIn(text, pick) }
  }

  if (has(/\b(walk|explore|adventure|stroll|hike|outing|wander)\b/)) return { kind: 'activity', pick: pickFrom(text) }

  if (has(/\b(battle|fight|1v1|duel|spar|send|attack|train)\b/)) return { kind: 'battle', pick: pickFrom(text) }

  if (has(/\b(help|commands|how do i play|how to play)\b/)) return { kind: 'help' }

  if (has(/\b(wallet|address|payout|payouts|where do i get paid|link)\b/)) return { kind: 'wallet' }

  if (has(/\b(check|status|stats|how is|how's|hows|how are|team|party|my pokemon|show|inventory|balls)\b/))
    return { kind: 'check', pick: pickFrom(text) }

  return null
}

/** The handle that follows a keyword, else the first non-bot handle. */
function lastTargetAfter(text: string, keyword: RegExp, targets: string[]): string {
  const m = keyword.exec(text)
  if (m) {
    const rest = text.slice(m.index)
    const after = rest.match(/@([A-Za-z0-9_]{1,15})/)
    if (after && targets.some((t) => t.toLowerCase() === after[1]!.toLowerCase())) return after[1]!
  }
  return targets[0]!
}
