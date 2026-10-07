/**
 * The launch command for real, on a local validator (⛔ refuses any RPC that is not localhost).
 *
 *   solana-test-validator --rpc-port 8961 --faucet-port 8964 --dynamic-port-range 9200-9230 --reset
 *   SOLANA_RPC=http://127.0.0.1:8961 node node_modules/tsx/dist/cli.mjs scripts/e2e-golive.ts
 *
 * Exactly what launch day does, minus systemd: a fresh pool with no token account, an env file without a
 * mint, then `golive <MINT>` (NOT --dry) with the restart command pointed at a script that starts the real
 * server from that env file. Checks: the pool token account exists on chain, the env file has the mint and
 * payouts on with every other line intact, the shop reports open with that mint, a second `golive --dry`
 * is idempotent, and the first real payment after launch is credited.
 */
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { Connection, Keypair, LAMPORTS_PER_SOL, VersionedTransaction } from '@solana/web3.js'
import { TOKEN_2022_PROGRAM_ID as P, createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount, getMint, getAssociatedTokenAddressSync } from '@solana/spl-token'
import bs58 from 'bs58'

const RPC = process.env.SOLANA_RPC ?? 'http://127.0.0.1:8961'
if (!/127\.0\.0\.1|localhost/.test(RPC)) throw new Error('local validator only')
const conn = new Connection(RPC, 'confirmed')
const PORT = 5398
const BASE = `http://127.0.0.1:${PORT}`
const dir = mkdtempSync(join(tmpdir(), 'xp-golive-'))

// chain: a mint, a funded pool with NO token account, one player wallet with tokens
const funder = Keypair.generate()
const pool = Keypair.generate()
const player = Keypair.generate()
await conn.confirmTransaction(await conn.requestAirdrop(funder.publicKey, 20 * LAMPORTS_PER_SOL), 'confirmed')
for (const k of [pool, player]) await conn.confirmTransaction(await conn.requestAirdrop(k.publicKey, LAMPORTS_PER_SOL), 'confirmed')
const mint = await createMint(conn, funder, funder.publicKey, null, 6, undefined, undefined, P)
const pAta = await getOrCreateAssociatedTokenAccount(conn, funder, mint, player.publicKey, false, 'confirmed', undefined, P)
await mintTo(conn, funder, mint, pAta.address, funder, 10_000_000_000n, [], undefined, P)
const poolAta = getAssociatedTokenAddressSync(mint, pool.publicKey, false, P)
assert.equal(await conn.getAccountInfo(poolAta), null, 'pool token account must not exist before launch')

// the env file as it is on the box before launch (no mint, payouts off), plus local-only settings
const envFile = join(dir, 'env')
const before = [
  '# production-like env for the launch test',
  `PORT=${PORT}`,
  `DATA_DIR=${join(dir, 'data')}`,
  'WEB_DIST=../web/dist',
  'DEV_MODE=1',
  'LLM_ENABLED=0',
  'X_SOURCE=fixture',
  'X_REPLY=none',
  'X_HANDLE=xpokefun',
  'TOKEN_MINT=',
  'PAYOUTS_ENABLED=0',
  `POOL_SECRET=${bs58.encode(pool.secretKey)}`,
  `SOLANA_RPC=${RPC}`,
  'RPC_RPS=0',
  'CONFIRMATIONS=0',
  'ADMIN_TOKEN=keep-me-exactly',
  '',
].join('\n')
writeFileSync(envFile, before, { mode: 0o600 })

// "systemctl restart xpoke" stand-in: start the real server detached from that env file
const pidFile = join(dir, 'server.pid')
const logFile = join(dir, 'server.log')
const restart = join(dir, 'restart.sh')
writeFileSync(
  restart,
  `#!/bin/bash\n[ -f ${pidFile} ] && kill $(cat ${pidFile}) 2>/dev/null; sleep 0.5\nnohup env -u TOKEN_MINT -u PAYOUTS_ENABLED node --env-file=${envFile} node_modules/tsx/dist/cli.mjs src/index.ts > ${logFile} 2>&1 &\necho $! > ${pidFile}\n`,
  { mode: 0o755 },
)
const stop = () => {
  if (existsSync(pidFile)) spawnSync('kill', [readFileSync(pidFile, 'utf8').trim()])
}
process.on('exit', stop)

// golive reads its settings the way the box does: from the env file (node --env-file) plus the overrides
const envVars = Object.fromEntries(before.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
const runGolive = (...args: string[]) =>
  spawnSync('node', ['node_modules/tsx/dist/cli.mjs', 'src/golive.ts', mint.toBase58(), ...args], {
    env: { ...process.env, ...envVars, GOLIVE_ENV_FILE: envFile, GOLIVE_RESTART_CMD: restart },
    encoding: 'utf8',
  })

// unsafe tokens are refused before anything happens: a freeze authority, and a Token-2022 transfer fee
{
  const frozenMint = await createMint(conn, funder, funder.publicKey, funder.publicKey, 6, undefined, undefined, P)
  const r1 = spawnSync('node', ['node_modules/tsx/dist/cli.mjs', 'src/golive.ts', frozenMint.toBase58(), '--dry'], {
    env: { ...process.env, ...envVars }, encoding: 'utf8',
  })
  assert.notEqual(r1.status, 0, 'a mint with a freeze authority is refused')
  assert.match(r1.stderr, /freeze authority/)
  // transfer-fee mint through the CLI (keypair file for the fee payer)
  const kp = join(dir, 'funder.json')
  writeFileSync(kp, JSON.stringify(Array.from(funder.secretKey)))
  const out = spawnSync('spl-token', ['create-token', '--program-2022', '--transfer-fee-basis-points', '50', '--transfer-fee-maximum-fee', '1000', '--decimals', '6', '-u', RPC, '--fee-payer', kp, '--mint-authority', kp, '--output', 'json'], { encoding: 'utf8' })
  const feeMint = (JSON.parse(out.stdout) as { commandOutput: { address: string } }).commandOutput.address
  const r2 = spawnSync('node', ['node_modules/tsx/dist/cli.mjs', 'src/golive.ts', feeMint, '--dry'], { env: { ...process.env, ...envVars }, encoding: 'utf8' })
  assert.notEqual(r2.status, 0, 'a transfer-fee mint is refused')
  assert.match(r2.stderr, /transferFeeConfig/)
  console.log('✓ refused: mint with a freeze authority, Token-2022 mint with a transfer fee')
}

console.log('--- golive (real run)')
const live = runGolive()
process.stdout.write(live.stdout)
if (live.status !== 0) {
  console.error(live.stderr)
  throw new Error(`golive exited ${live.status}`)
}

// 1. the pool token account exists on chain, owned by the pool
const ata = await getAccount(conn, poolAta, 'confirmed', P)
assert.equal(ata.owner.toBase58(), pool.publicKey.toBase58())
assert.equal(ata.amount, 0n)

// 2. the env file: mint + payouts set, everything else byte-for-byte as before
const after = readFileSync(envFile, 'utf8')
assert.match(after, new RegExp(`^TOKEN_MINT=${mint.toBase58()}$`, 'm'))
assert.match(after, /^PAYOUTS_ENABLED=1$/m)
const untouched = before.split('\n').filter((l) => !/^(TOKEN_MINT|PAYOUTS_ENABLED)=/.test(l) && l !== '')
for (const l of untouched) assert.ok(after.includes(l), `kept: ${l.slice(0, 30)}`)
assert.equal(after.split('\n').filter((l) => /^TOKEN_MINT=/.test(l)).length, 1, 'exactly one TOKEN_MINT line')

// 3. the server golive started reports the shop open with that mint and payouts on
const shop = (await (await fetch(`${BASE}/api/shop`)).json()) as { enabled: boolean; token: string }
assert.equal(shop.enabled, true)
assert.equal(shop.token, mint.toBase58())
const st = (await (await fetch(`${BASE}/api/agent/status`)).json()) as { chain: { payouts: boolean; poolTokenAccount: string } }
assert.equal(st.chain.payouts, true)
assert.equal(st.chain.poolTokenAccount, poolAta.toBase58())
console.log('✓ pool token account on chain · env rewritten · shop open · payouts on')

// 4. running it again is harmless
console.log('--- golive --dry again (idempotent)')
const again = runGolive('--dry')
assert.equal(again.status, 0, again.stderr)
assert.match(again.stdout, /exists/)

// 5. the first real payment after launch is credited (the fresh-pool scanner path)
const login = await fetch(`${BASE}/api/dev/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: 'first' }) })
const cookie = login.headers.get('set-cookie')!.split(';')[0]!
const h = { cookie, 'content-type': 'application/json' }
const order = (await (await fetch(`${BASE}/api/shop/order`, { method: 'POST', headers: h, body: JSON.stringify({ ball: 'ultra', qty: 1 }) })).json()) as { id: number; amountWei: string }
const built = (await (await fetch(`${BASE}/api/pay/build`, { method: 'POST', headers: h, body: JSON.stringify({ kind: 'order', id: order.id, payer: player.publicKey.toBase58() }) })).json()) as { tx: string }
const vtx = VersionedTransaction.deserialize(Buffer.from(built.tx, 'base64'))
vtx.sign([player])
await conn.confirmTransaction(await conn.sendRawTransaction(vtx.serialize()), 'confirmed')
let status = ''
for (let i = 0; i < 60 && status !== 'paid'; i++) {
  await new Promise((r) => setTimeout(r, 1000))
  const me = (await (await fetch(`${BASE}/api/me`, { headers: h })).json()) as { trainer: { orders: { status: string }[]; balls: { ultra: number } } }
  status = me.trainer.orders[0]!.status
  if (status === 'paid') assert.equal(me.trainer.balls.ultra, 1)
}
assert.equal(status, 'paid', 'first payment after launch credited')
// ball purchases are burned in full: the pool ends empty and supply drops by exactly the payment
const supplyBefore = 10_000n * 1_000_000n
for (let i = 0; i < 30 && (await getAccount(conn, poolAta, 'confirmed', P)).amount !== 0n; i++) await new Promise((r) => setTimeout(r, 1000))
assert.equal((await getAccount(conn, poolAta, 'confirmed', P)).amount, 0n, 'the purchase was burned out of the pool')
assert.equal((await getMint(conn, mint, 'confirmed', P)).supply, supplyBefore - BigInt(order.amountWei), 'supply dropped by exactly the purchase')
console.log('✓ first payment after launch credited, then burned: pool empty, supply down by exactly the purchase')
const log = readFileSync(logFile, 'utf8').split('\n').filter((l) => /error|HELD|fail/i.test(l) && !/ExperimentalWarning|bindings/.test(l))
assert.deepEqual(log, [], 'server log clean')
console.log('\nGOLIVE E2E PASSED')
stop()
process.exit(0)
