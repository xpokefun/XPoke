/** Reactions and adventure stories. Picked at random, never decisive for anything. */
const FEED = [
  '{p} gobbled up the {f} and did a happy little spin',
  '{p} sniffed the {f}, then ate every last crumb',
  '{p} loved the {f} and wants seconds already',
  '{p} munched the {f} and settled in for a nap',
  '{p} shared a bite of {f} with a passing Pidgey',
  '{p} was suspicious of the {f} at first, but it was a hit',
  '{p} ate the {f} so fast it got the hiccups',
  "{p} tried the {f} and gave it a solid 8/10",
]
const STORIES = [
  '{a} and {b} explored a misty forest and found a hidden berry patch',
  '{a} and {b} raced along the beach until sunset',
  '{a} and {b} went cave diving and came back covered in glowing dust',
  '{a} and {b} climbed Mt. Coronet and watched the clouds roll by',
  '{a} and {b} got lost in the Safari Zone, then found the way out together',
  '{a} and {b} trained under a waterfall for an hour',
  '{a} and {b} helped a lost Togepi find its way home',
  '{a} and {b} had a picnic and split a giant sandwich',
  '{a} and {b} snuck into the Pokémon Center and got free snacks',
  '{a} and {b} stargazed on Route 1 and spotted a shooting star',
  '{a} and {b} dug for fossils and found something shiny',
  '{a} and {b} entered a dance contest and came second',
]

function pick<T>(list: T[], rand: () => number): T {
  return list[Math.floor(rand() * list.length)]!
}

export function feedReaction(p: string, food: string, rand: () => number = Math.random): string {
  return pick(FEED, rand).replace('{p}', p).replace('{f}', food)
}

export function adventure(a: string, b: string, rand: () => number = Math.random): string {
  return pick(STORIES, rand).replace('{a}', a).replace('{b}', b)
}

export const DEFAULT_FOODS = ['berries', 'oran berries', 'poké puffs', 'a rare candy shaped cookie', 'fresh apples']
