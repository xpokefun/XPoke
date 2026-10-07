/** Settings, all from the environment. See .env.example. */

function env(name: string, fallback = ''): string {
  return (process.env[name] ?? fallback).trim()
}

export type Config = ReturnType<typeof loadConfig>

export function loadConfig() {
  const port = Number(env('PORT', '5340'))
  const publicUrl = env('PUBLIC_URL', `http://localhost:${port}`).replace(/\/$/, '')
  const source = env('X_SOURCE', 'fixture') as 'twitterapi.io' | 'x-api' | 'fixture'
  const reply = env('X_REPLY', 'none') as 'twitterapi.io' | 'x-api' | 'none'
  return {
    port,
    publicUrl,
    dataDir: env('DATA_DIR', './data'),
    webDist: env('WEB_DIST', '../web/dist'),
    dev: env('DEV_MODE') === '1',
    adminToken: env('ADMIN_TOKEN'),

    // X
    handle: env('X_HANDLE', 'xpokefun').replace(/^@/, ''),
    source,
    reply,
    dryRun: env('DRY_RUN') === '1',
    twitterApiIoKey: env('TWITTERAPI_IO_KEY'),
    twitterApiIoLoginCookie: env('TWITTERAPI_IO_LOGIN_COOKIE'),
    twitterApiIoProxy: env('TWITTERAPI_IO_PROXY'),
    xBearerToken: env('X_BEARER_TOKEN'),
    xUserId: env('X_USER_ID'),
    pollSeconds: Math.max(15, Number(env('POLL_SECONDS', '20'))),
    /** Account-wide public replies per hour (protects a new X account; over it commands still run). */
    globalRepliesPerHour: Number(env('GLOBAL_REPLIES_PER_HOUR', '120')),
    /** Minimum gap between two posts, in ms. */
    replyGapMs: Number(env('REPLY_GAP_MS', '1500')),
    /** Different trainers' mentions processed side by side. */
    mentionWorkers: Number(env('MENTION_WORKERS', '8')),
    /** Cadence when nobody has played for 10 minutes. */
    pollIdleSeconds: Math.max(15, Number(env('POLL_IDLE_SECONDS', '90'))),
    /** How often the wide 2 h catch-up runs (the mentions index can lag over an hour). */
    catchupMinutes: Math.max(10, Number(env('CATCHUP_MINUTES', '45'))),
    xClientId: env('X_CLIENT_ID'),
    xClientSecret: env('X_CLIENT_SECRET'),

    // the model
    llmModel: env('LLM_MODEL', 'claude-opus-5-5'),
    llmKey: env('ANTHROPIC_API_KEY'),
    /** Bearer-token gateways (OpenRouter): the key goes here instead of ANTHROPIC_API_KEY. */
    llmAuthToken: env('ANTHROPIC_AUTH_TOKEN'),
    llmBaseUrl: env('ANTHROPIC_BASE_URL'),
    llmEnabled: env('LLM_ENABLED', '1') !== '0',
    /** Model calls per trainer per hour; beyond it, unknown text gets the rules only. */
    llmPerUserHour: Number(env('LLM_PER_USER_HOUR', '5')),
    /** Hard ceiling on model calls per UTC day, across everyone. */
    llmDailyCap: Number(env('LLM_DAILY_CAP', '300')),

    // Solana
    tokenMint: env('TOKEN_MINT'),
    tokenSymbol: env('TOKEN_SYMBOL', 'XPOKE'),
    poolSecret: env('POOL_SECRET'),
    poolAddress: env('POOL_ADDRESS'),
    payoutsEnabled: env('PAYOUTS_ENABLED', '0') === '1',
    solanaRpc: env('SOLANA_RPC'),
    rpcRps: Number(env('RPC_RPS', '4')),
    priorityMicroLamports: Number(env('PRIORITY_MICROLAMPORTS', '50000')),
    /** Read the pool's whole history on first start (tests). Normally the first start just marks "now". */
    scanFromStart: env('SCAN_FROM_START') === '1',
  }
}
