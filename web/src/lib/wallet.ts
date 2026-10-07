/**
 * Pay with wallet on Solana, through the Wallet Standard (Phantom, Solflare, Backpack...).
 * Loaded only when someone presses "Pay with wallet".
 */
import { getWallets } from '@wallet-standard/app'
import type { Wallet, WalletAccount } from '@wallet-standard/base'
import bs58 from 'bs58'

export const SOLANA_MAINNET = 'solana:mainnet'

type ConnectFeature = { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> }
type SignMessageFeature = {
  signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signedMessage: Uint8Array; signature: Uint8Array }[]>
}

/** Wallets that can prove ownership with a free signed message (for linking). */
export function signingWallets(): SolWallet[] {
  return getWallets()
    .get()
    .filter((w) => w.chains.some((c) => c === SOLANA_MAINNET) && 'standard:connect' in w.features && 'solana:signMessage' in w.features)
    .map((w) => ({ name: w.name, icon: w.icon, wallet: w }))
}

/** Signs a plain-text message. Returns the signature, base58. No transaction, no fee. */
export async function signText(w: SolWallet, account: WalletAccount, message: string): Promise<string> {
  const feature = w.wallet.features['solana:signMessage'] as SignMessageFeature
  const [out] = await feature.signMessage({ account, message: new TextEncoder().encode(message) })
  if (!out?.signature) throw new Error('the wallet returned no signature')
  return bs58.encode(out.signature)
}

type SignAndSendFeature = {
  signAndSendTransaction(
    ...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array }[]
  ): Promise<readonly { signature: Uint8Array }[]>
}

export type SolWallet = { name: string; icon: string; wallet: Wallet }

function usable(w: Wallet): boolean {
  return (
    w.chains.some((c) => c === SOLANA_MAINNET) &&
    'standard:connect' in w.features &&
    'solana:signAndSendTransaction' in w.features
  )
}

export function solanaWallets(): SolWallet[] {
  return getWallets()
    .get()
    .filter(usable)
    .map((w) => ({ name: w.name, icon: w.icon, wallet: w }))
}

export function onSolanaWallets(fn: () => void): () => void {
  const { on } = getWallets()
  const offA = on('register', fn)
  const offB = on('unregister', fn)
  return () => {
    offA()
    offB()
  }
}

export async function connect(w: SolWallet): Promise<WalletAccount> {
  const feature = w.wallet.features['standard:connect'] as ConnectFeature
  const { accounts } = await feature.connect()
  const account = accounts.find((a) => a.chains.includes(SOLANA_MAINNET)) ?? accounts[0]
  if (!account) throw new Error('the wallet did not share an account')
  return account
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/** Signs and sends the server-built transfer. Returns the signature, base58. */
export async function signAndSend(w: SolWallet, account: WalletAccount, txBase64: string): Promise<string> {
  const feature = w.wallet.features['solana:signAndSendTransaction'] as SignAndSendFeature
  const [out] = await feature.signAndSendTransaction({ account, chain: SOLANA_MAINNET, transaction: fromBase64(txBase64) })
  if (!out?.signature) throw new Error('the wallet returned no signature')
  return bs58.encode(out.signature)
}
