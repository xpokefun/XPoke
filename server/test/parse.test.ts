import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from '../src/game/parse.ts'

const p = (t: string) => parseCommand(`@xpokebot ${t}`, 'xpokebot')

test('every phrasing the docs list', () => {
  const cases: [string, unknown][] = [
    ['catch', { kind: 'catch', ball: 'poke' }],
    ['catch pokemon', { kind: 'catch', ball: 'poke' }],
    ['throw pokeball', { kind: 'catch', ball: 'poke' }],
    ['catch ultra ball', { kind: 'catch', ball: 'ultra' }],
    ['ultra ball catch', { kind: 'catch', ball: 'ultra' }],
    ['catch master ball', { kind: 'catch', ball: 'master' }],
    ['master ball catch', { kind: 'catch', ball: 'master' }],
    ['check', { kind: 'check', pick: undefined }],
    ['check pikachu', { kind: 'check', pick: { name: 'Pikachu' } }],
    ['how is my first', { kind: 'check', pick: { index: 0 } }],
    ['how is pikachu', { kind: 'check', pick: { name: 'Pikachu' } }],
    ['check my first', { kind: 'check', pick: { index: 0 } }],
    ['status', { kind: 'check', pick: undefined }],
    ['feed', { kind: 'feed', pick: undefined, food: undefined }],
    ['feed my second berries', { kind: 'feed', pick: { index: 1 }, food: 'berries' }],
    ['give charizard pizza', { kind: 'feed', pick: { name: 'Charizard' }, food: 'pizza' }],
    ['feed ramen', { kind: 'feed', pick: undefined, food: 'ramen' }],
    ['give berries', { kind: 'feed', pick: undefined, food: 'berries' }],
    ['feed charizard', { kind: 'feed', pick: { name: 'Charizard' }, food: undefined }],
    ['battle', { kind: 'battle', pick: undefined }],
    ['fight', { kind: 'battle', pick: undefined }],
    ['1v1', { kind: 'battle', pick: undefined }],
    ['send charizard', { kind: 'battle', pick: { name: 'Charizard' } }],
    ['lets fight', { kind: 'battle', pick: undefined }],
    ['battle my second', { kind: 'battle', pick: { index: 1 } }],
    ['battle my 2nd', { kind: 'battle', pick: { index: 1 } }],
    ['battle pikachu', { kind: 'battle', pick: { name: 'Pikachu' } }],
    ['evolve', { kind: 'evolve', pick: undefined }],
    ['evolve pikachu', { kind: 'evolve', pick: { name: 'Pikachu' } }],
    ['evolve my first', { kind: 'evolve', pick: { index: 0 } }],
    ['make it evolve', { kind: 'evolve', pick: undefined }],
    ['swap gastly', { kind: 'swap', box: 'Gastly' }],
    ['swap gastly for pikachu', { kind: 'swap', box: 'Gastly', party: 'Pikachu' }],
    ['bring gastly out', { kind: 'swap', box: 'Gastly' }],
    ['release pikachu confirm', { kind: 'release', pick: { name: 'Pikachu' }, confirm: true }],
    ['release my first confirm', { kind: 'release', pick: { index: 0 }, confirm: true }],
    ['release pikachu', { kind: 'release', pick: { name: 'Pikachu' }, confirm: false }],
    ['challenge @rival', { kind: 'challenge', target: 'rival', pick: undefined }],
    ['pvp @rival', { kind: 'challenge', target: 'rival', pick: undefined }],
    ['battle @rival', { kind: 'challenge', target: 'rival', pick: undefined }],
    ['accept', { kind: 'accept', pick: undefined }],
    ['decline', { kind: 'decline' }],
    ['cancel', { kind: 'cancel' }],
    ['wager @rival_gary 1000', { kind: 'wager', target: 'rival_gary', amount: 1000 }],
    ['wager @rival_gary 1,500', { kind: 'wager', target: 'rival_gary', amount: 1500 }],
    ['trade @rival_gary pikachu for charizard', { kind: 'trade', target: 'rival_gary', offer: 'Pikachu', want: 'Charizard' }],
    ['trade @rival_gary eevee', { kind: 'trade', target: 'rival_gary', offer: 'Eevee' }],
    ['tournament join', { kind: 'tournament_join' }],
    ['walk', { kind: 'activity', pick: undefined }],
    ['explore', { kind: 'activity', pick: undefined }],
    ['take pikachu for a walk', { kind: 'activity', pick: { name: 'Pikachu' } }],
    ['help', { kind: 'help' }],
    ['commands', { kind: 'help' }],
    ['how do i play', { kind: 'help' }],
  ]
  const failures: string[] = []
  for (const [text, want] of cases) {
    try {
      assert.deepEqual(p(text), want)
    } catch {
      failures.push(`${text} → ${JSON.stringify(p(text))}`)
    }
  }
  assert.deepEqual(failures, [])
})

test('reply-chain prefix is not a target', () => {
  assert.deepEqual(parseCommand('@xpokebot @alice battle', 'xpokebot'), { kind: 'battle', pick: undefined })
  assert.deepEqual(parseCommand('@alice @xpokebot catch', 'xpokebot'), { kind: 'catch', ball: 'poke' })
})

test('free text falls through to the model', () => {
  assert.equal(p('whats the best fire type?'), null)
  assert.equal(p('tell me about ghost pokemon'), null)
})

test('a target command under somebody\'s post targets them; a plain battle does not', () => {
  assert.deepEqual(parseCommand('@bob @xpokebot challenge', 'xpokebot'), { kind: 'challenge', target: 'bob', pick: undefined })
  assert.deepEqual(parseCommand('@bob @xpokebot wager 500', 'xpokebot'), { kind: 'wager', target: 'bob', amount: 500 })
  assert.deepEqual(parseCommand('@bob @xpokebot trade pikachu for eevee', 'xpokebot'), { kind: 'trade', target: 'bob', offer: 'Pikachu', want: 'Eevee' })
  assert.deepEqual(parseCommand('@bob @xpokebot battle', 'xpokebot'), { kind: 'battle', pick: undefined })
  assert.deepEqual(parseCommand('@bob @xpokebot challenge @carol', 'xpokebot'), { kind: 'challenge', target: 'carol', pick: undefined })
})

test('accept/decline carry the wager flag only when the post says so', () => {
  assert.deepEqual(parseCommand('@xpokebot accept', 'xpokebot'), { kind: 'accept', pick: undefined })
  assert.deepEqual(parseCommand('@xpokebot accept wager', 'xpokebot'), { kind: 'accept', pick: undefined, wager: true })
  assert.deepEqual(parseCommand('@xpokebot decline the bet', 'xpokebot'), { kind: 'decline', wager: true })
})
