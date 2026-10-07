import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCommand } from '../src/llm.ts'

const base = { pokemon: null, slot: null, other_pokemon: null, food: null, ball: null, target_handle: null, amount: null, reply: null }

test('release from the model still needs the literal word confirm', () => {
  assert.deepEqual(toCommand({ ...base, kind: 'release', pokemon: 'pikachu' }, 'please let pikachu go').command, {
    kind: 'release',
    pick: { name: 'Pikachu' },
    confirm: false,
  })
})

test('a wager amount or handle the post never wrote is refused', () => {
  assert.equal(toCommand({ ...base, kind: 'wager', target_handle: 'gary', amount: 5000 }, 'bet @gary 50 tokens').command, null)
  assert.equal(toCommand({ ...base, kind: 'wager', target_handle: 'misty', amount: 50 }, 'bet @gary 50 tokens').command, null)
  assert.deepEqual(toCommand({ ...base, kind: 'wager', target_handle: 'gary', amount: 50 }, 'bet @gary 50 tokens').command, {
    kind: 'wager',
    target: 'gary',
    amount: 50,
  })
  assert.deepEqual(toCommand({ ...base, kind: 'wager', target_handle: '@gary', amount: 2000 }, 'run it back @gary for 2k').command, {
    kind: 'wager',
    target: 'gary',
    amount: 2000,
  })
})

test('unknown species names are dropped, slots map to indexes', () => {
  assert.deepEqual(toCommand({ ...base, kind: 'feed', pokemon: 'notamon', slot: 2, food: 'tacos' }, 'x').command, {
    kind: 'feed',
    pick: { index: 1 },
    food: 'tacos',
  })
})

test('chat carries the answer, ignore stays silent', () => {
  const r = toCommand({ ...base, kind: 'chat', reply: 'charizard and arcanine are top picks' }, 'best fire type?')
  assert.equal(r.chat, 'charizard and arcanine are top picks')
  assert.deepEqual(toCommand({ ...base, kind: 'ignore' }, 'gm').command, { kind: 'none' })
})

test('model text is scrubbed of handles, links and tags before it can be posted', () => {
  const r = toCommand({ ...base, kind: 'chat', reply: 'ask @victim, see https://x.yz/scam #airdrop $XPOKE now' }, 'hi')
  assert.equal(r.chat, 'ask , see now')
  const f = toCommand({ ...base, kind: 'feed', food: 'pizza from @victim www.spam.io' }, 'feed pizza')
  assert.deepEqual(f.command, { kind: 'feed', pick: undefined, food: 'pizza from' })
})
