# Security

XPoke handles real tokens, so reports are taken seriously.

**Please report security problems privately**, not in a public issue: send a direct message to
[@xpokefun](https://x.com/xpokefun) on X, or open a [private security advisory](https://github.com/xpokefun/XPoke/security/advisories/new)
on this repository. Include what you found, how to reproduce it, and what it could affect.

Especially interesting: anything that lets someone receive tokens they did not win, take another player's
payment or payout, move a running wager's payout address, use someone's wager allowance for anything but the
exact stake of a wager they started or accepted, or make the server sign something it should not.

Please don't test against the live service with real funds or other players' accounts; the local test suites
(see the README) run everything against a local Solana validator.
