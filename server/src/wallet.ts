/**
 * Linking a Solana wallet to an X account.
 *
 * The trainer signs a plain message in their wallet (Wallet Standard `solana:signMessage`): no transaction,
 * no fee, nothing moves. The signature proves they hold the wallet's key, so nobody can link a wallet that is
 * not theirs. From then on wager winnings and refunds go to the linked wallet, whichever wallet paid; that is
 * what protects a player who paid from an exchange or through a swap app.
 *
 * ⚠ The payout address of a wager is fixed when the wager is accepted (wagers.payout_a/b), so changing the
 *   linked wallet later — or someone with a stolen session doing it — never redirects a running wager.
 */
import { createPublicKey, randomBytes, verify } from 'node:crypto'
import bs58 from 'bs58'
import { PublicKey } from '@solana/web3.js'
import { type DB, now } from './db.ts'
import type { Trainer } from './game/store.ts'

const CHALLENGE_TTL = 10 * 60_000
/** DER prefix that turns a raw 32-byte ed25519 public key into SPKI, which node:crypto can verify with. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export class WalletError extends Error {}

function isWallet(address: string): boolean {
  try {
    return new PublicKey(address).toBase58() === address
  } catch {
    return false
  }
}

export function linkMessage(t: Trainer, address: string, nonce: string, issued: Date): string {
  return [
    'XPoke wallet link',
    '',
    `X account: @${t.handle} (${t.id})`,
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${issued.toISOString()}`,
    '',
    'Signing this proves you own this wallet. It is free and does not move any tokens.',
    'Your XPoke wager winnings and refunds will be sent to this wallet.',
  ].join('\n')
}

export function createChallenge(db: DB, t: Trainer, address: string): { nonce: string; message: string } {
  if (!isWallet(address)) throw new WalletError('that is not a Solana wallet address')
  db.prepare('delete from wallet_challenges where expires_at < ? or trainer_id = ?').run(now(), t.id)
  const nonce = randomBytes(16).toString('hex')
  const message = linkMessage(t, address, nonce, new Date())
  db.prepare('insert into wallet_challenges (nonce, trainer_id, address, message, expires_at) values (?,?,?,?,?)').run(
    nonce,
    t.id,
    address,
    message,
    now() + CHALLENGE_TTL,
  )
  return { nonce, message }
}

export function verifySignature(address: string, message: string, signatureB58: string): boolean {
  try {
    const sig = bs58.decode(signatureB58)
    if (sig.length !== 64) return false
    const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, new PublicKey(address).toBuffer()]), format: 'der', type: 'spki' })
    return verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(sig))
  } catch {
    return false
  }
}

/** Completes a link: the challenge must be this trainer's, unexpired, unused, and signed by that wallet. */
export function completeLink(db: DB, t: Trainer, nonce: string, signature: string): string {
  const c = db.prepare('select * from wallet_challenges where nonce = ?').get(String(nonce)) as
    | { trainer_id: string; address: string; message: string; expires_at: number }
    | undefined
  db.prepare('delete from wallet_challenges where nonce = ?').run(String(nonce)) // single use, whatever happens next
  if (!c || c.trainer_id !== t.id) throw new WalletError('that link request is unknown or not yours. start again')
  if (c.expires_at < now()) throw new WalletError('that link request expired. start again')
  if (!verifySignature(c.address, c.message, String(signature))) throw new WalletError('the signature does not match that wallet')
  const owner = db.prepare('select id, handle from trainers where wallet = ?').get(c.address) as { id: string; handle: string } | undefined
  if (owner && owner.id !== t.id) throw new WalletError('that wallet is already linked to another XPoke account')
  db.prepare('update trainers set wallet = ?, wallet_linked_at = ? where id = ?').run(c.address, now(), t.id)
  return c.address
}

export function unlink(db: DB, t: Trainer): void {
  db.prepare('update trainers set wallet = null, wallet_linked_at = null where id = ?').run(t.id)
}

export function shortAddr(a: string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`
}
