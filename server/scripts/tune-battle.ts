import { speciesByName, FORMS } from '../src/game/data.ts'
import { duel, type Fighter } from '../src/game/battle.ts'
const iv0 = { hp: 7, atk: 7, def: 7, spe: 7 }
const f = (n: string, level: number, gym = false): Fighter => ({
  label: n, species: speciesByName(n) ?? (FORMS as any)[n], level, ivs: iv0,
  ...(gym ? { powerMult: 1.15, hpMult: 1.25 } : {}),
})
function winRate(a: Fighter, b: Fighter, n = 400) {
  let w = 0
  for (let i = 0; i < n; i++) if (duel(a, b).winner === 0) w++
  return w / n
}
function crossover(name: string, vs: Fighter) {
  for (let L = 1; L <= 200; L++) if (winRate(f(name, L), vs) > 0.5) return L
  return null
}
const m1 = f('mewtwo', 1)
console.log('pikachu x mewtwo1', crossover('pikachu', m1))
console.log('raichu x mewtwo1', crossover('raichu', m1))
console.log('rattata x mewtwo1', crossover('rattata', m1))
console.log('raichu58 vs mewtwo1', winRate(f('raichu', 58), m1))
console.log('rattata100 vs mewtwo1', winRate(f('rattata', 100), m1))
console.log('same level 10: mewtwo vs rattata', winRate(f('mewtwo', 10), f('rattata', 10)))
console.log('rayquaza vs dragonite L50', winRate(f('rayquaza', 50), f('dragonite', 50)))
console.log('dragonite vs charizard L50', winRate(f('dragonite', 50), f('charizard', 50)))
console.log('charizard vs pikachu L50', winRate(f('charizard', 50), f('pikachu', 50)))
console.log('charizard vs venusaur L36 (type)', winRate(f('charizard', 36), f('venusaur', 36)))
const r = duel(f('bulbasaur', 5), f('charmander', 5))
console.log('rounds equalish', r.rounds, r.decidedBy, r.hits.length)
// gym gate: what level of a typical starter-line mon beats each gym
const gyms: [string, number][] = [['rattata',3],['pidgeot',10],['raichu',18],['gengar',28],['dragonite',40],['mewtwo',55],['gyarados',70],['houndoom-mega',90],['salamence',110],['metagross',130],['rayquaza',150],['mewtwo-mega-x',175],['kyogre',200]]
for (const [g, L] of gyms) console.log('gym', g, L, 'beaten by charizard at', crossover('charizard', f(g, L, true)), 'pikachu at', crossover('pikachu', f(g, L, true)))
