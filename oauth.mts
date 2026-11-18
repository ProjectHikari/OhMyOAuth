import { createHash, randomBytes } from 'node:crypto'
import { integer, object, text } from '../shared/runtime.mts'

export const callbackPath = '/ohmyoauth/callback'
export const startPath = '/ohmyoauth/start'
export const secret = () => randomBytes(32).toString('base64url')
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
const id = /^[1-9][0-9]{0,14}$/

export type OAuthConfig = {
  selfId: string
  groups: string[]
  origin: string
  port: number
  clientId: string
  clientSecret: string
}

export function config(raw: unknown, env = process.env): OAuthConfig | undefined {
  const input = object(raw)
  if (input.enabled === undefined || input.enabled === false) return
  if (input.enabled !== true) throw new Error('enabled must be a boolean')
  const selfId = String(input.selfId ?? '')
  if (!id.test(selfId) || !Array.isArray(input.groups) || !input.groups.length ||
      input.groups.length > 100 || input.groups.some(group => !id.test(String(group)))) throw new Error('配置机器人账号与目标群')
  const url = new URL(text(input.publicOrigin, 'HTTPS入口', 1024))
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password)
    throw new Error('HTTPS入口必须是公网HTTPS origin')
  return { selfId, groups: [...new Set(input.groups.map(String))] as string[], origin: url.origin,
    port: integer(input.port ?? 3220, '认证监听端口', 1, 65535),
    clientId: text(env.OHMYOAUTH_GITHUB_CLIENT_ID, 'GitHub Client ID', 256),
    clientSecret: text(env.OHMYOAUTH_GITHUB_CLIENT_SECRET, 'GitHub Client Secret', 1024) }
}

export function githubURL(cfg: OAuthConfig, state: string, verifier: string): string {
  const url = new URL('https://github.com/login/oauth/authorize')
  url.search = new URLSearchParams({ client_id: cfg.clientId, redirect_uri: cfg.origin + callbackPath,
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString()
  return url.href
}

const knownGitHubErrors = new Set([
  'access_denied', 'bad_verification_code', 'incorrect_client_credentials',
  'redirect_uri_mismatch', 'unverified_user_email', 'application_suspended',
  'invalid_grant', 'invalid_request',
])

export class OAuthFailure extends Error {
  readonly reason: string
  constructor(reason: string) { super(reason); this.reason = reason }
}

export function callbackFailure(error: string | null): OAuthFailure {
  return new OAuthFailure(error && knownGitHubErrors.has(error) ? 'authorize:' + error : 'authorize:invalid_callback')
}

const connectErrors = new Set(['UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH'])

async function githubResponse(stage: 'exchange' | 'profile', run: () => Promise<Response>, signal: AbortSignal): Promise<any> {
  let response
  for (let attempt = 0; ; attempt++) {
    try { response = await run(); break }
    catch (error) {
      signal.throwIfAborted()
      const cause = error instanceof Error ? error.cause as NodeJS.ErrnoException | undefined : undefined
      // Only retry failures before the request could reach GitHub.
      if (attempt === 0 && cause?.code && connectErrors.has(cause.code)) continue
      throw new OAuthFailure(stage + ':network')
    }
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new OAuthFailure(stage + ':http_' + response.status)
  }
  let data
  try { data = await response.json() }
  catch { throw new OAuthFailure(stage + ':invalid_response') }
  if (!data || typeof data !== 'object') throw new OAuthFailure(stage + ':invalid_response')
  return data
}

export async function verifyGitHub(cfg: OAuthConfig, code: string, verifier: string, signal: AbortSignal, request = fetch): Promise<void> {
  const deadline = () => AbortSignal.any([signal, AbortSignal.timeout(13_000)])
  const token = await githubResponse('exchange', () => request('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error', signal: deadline(),
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code,
      redirect_uri: cfg.origin + callbackPath, code_verifier: verifier }),
  }), signal)
  if (token.error) {
    const error = knownGitHubErrors.has(token.error) ? token.error : 'oauth_error'
    throw new OAuthFailure('exchange:' + error)
  }
  if (typeof token.access_token !== 'string' || typeof token.token_type !== 'string' || token.token_type.toLowerCase() !== 'bearer')
    throw new OAuthFailure('exchange:invalid_token')
  if (typeof token.scope === 'string' ? token.scope.trim() !== '' : token.scope != null)
    throw new OAuthFailure('exchange:overprivileged')
  const user = await githubResponse('profile', () => request('https://api.github.com/user', {
    signal: deadline(), redirect: 'error',
    headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token.access_token },
  }), signal)
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new OAuthFailure('profile:invalid_account')
}
