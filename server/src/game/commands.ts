/** What the parser produces and the engine runs. */
export type Pick = { index?: number; name?: string }

export type Command =
  | { kind: 'catch'; ball: 'poke' | 'ultra' | 'master' }
  | { kind: 'check'; pick?: Pick }
  | { kind: 'feed'; pick?: Pick; food?: string }
  | { kind: 'battle'; pick?: Pick }
  | { kind: 'evolve'; pick?: Pick }
  | { kind: 'swap'; box: string; party?: string }
  | { kind: 'release'; pick?: Pick; confirm: boolean }
  | { kind: 'challenge'; target: string; pick?: Pick }
  | { kind: 'accept'; pick?: Pick; wager?: boolean }
  | { kind: 'decline'; wager?: boolean }
  | { kind: 'cancel' }
  | { kind: 'wager'; target: string; amount: number }
  | { kind: 'trade'; target: string; offer: string; want?: string }
  | { kind: 'tournament_join' }
  | { kind: 'activity'; pick?: Pick }
  | { kind: 'help' }
  | { kind: 'wallet' }
  | { kind: 'chat'; text: string }
  | { kind: 'none' }

export function describe(c: Command): string {
  switch (c.kind) {
    case 'catch':
      return c.ball === 'poke' ? 'catch' : `catch (${c.ball} ball)`
    case 'wager':
      return `wager @${c.target} ${c.amount}`
    case 'trade':
      return `trade @${c.target} ${c.offer}${c.want ? ` for ${c.want}` : ''}`
    case 'challenge':
      return `challenge @${c.target}`
    case 'swap':
      return `swap ${c.box}${c.party ? ` for ${c.party}` : ''}`
    case 'tournament_join':
      return 'tournament join'
    default:
      return c.kind
  }
}
