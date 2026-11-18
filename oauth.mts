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

export async function verifyGitHub(cfg: OAuthConfig, code: string, verifier: string, signal: AbortSignal, request = fetch): Promise<void> {
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(8000)])
  const response = await request('https://github.com/login/oauth/access_token', {
    method: 'POST', redirect: 'error', signal: timeout,
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: cfg.clientId, client_secret: cfg.clientSecret, code,
      redirect_uri: cfg.origin + callbackPath, code_verifier: verifier }),
  })
  if (!response.ok) { await response.body?.cancel(); throw new Error('GitHub token exchange failed') }
  const token = await response.json()
  if (token.error || typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer' || token.scope)
    throw new Error('GitHub returned an invalid or overprivileged token')
  const profile = await request('https://api.github.com/user', { signal: timeout, redirect: 'error',
    headers: { accept: 'application/vnd.github+json', authorization: 'Bearer ' + token.access_token } })
  if (!profile.ok) { await profile.body?.cancel(); throw new Error('GitHub account lookup failed') }
  const user = await profile.json()
  if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('GitHub account has no valid ID')
}
