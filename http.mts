import { createServer, type Server } from 'node:http'
import { readFile } from 'node:fs/promises'
import { callbackPath, startPath } from './oauth.mts'
import type { Verifier } from './verifier.mts'
import { page } from './page.mts'

const fontPaths = new Map([400, 700].map(weight => [
  `/ohmyoauth/fonts/outfit-${weight}.ttf`,
  new URL(`./fonts/Outfit-${weight}.ttf`, import.meta.url),
]))

export function createOAuthServer(verifier: Verifier): Server {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    void (async () => {
      const url = new URL(request.url ?? '/', verifier.cfg.origin)
      const font = request.method === 'GET' && url.origin === verifier.cfg.origin ? fontPaths.get(url.pathname) : undefined
      if (font) {
        const bytes = await readFile(font)
        response.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'public, max-age=86400' })
        response.end(bytes)
        return
      }
      const callback = url.pathname === callbackPath && request.method === 'GET'
      const start = url.pathname === startPath && (request.method === 'GET' || request.method === 'POST')
      if (url.origin !== verifier.cfg.origin || (!callback && !start)) {
        page(response, 404, '页面不存在。')
        return
      }
      if (start && request.method === 'POST' && request.headers.origin !== verifier.cfg.origin) {
        page(response, 403, '请从验证页面继续。')
        return
      }
      const result = callback ? await verifier.callback(url.searchParams, request.headers.cookie ?? '') :
        await verifier.start(url.searchParams.get('ticket') ?? '', request.method === 'POST' ? 'POST' : 'GET')
      // Preserve the browser Origin for the same-origin form POST.
      if (result.start) response.setHeader('Referrer-Policy', 'same-origin')
      if (result.cookie) response.setHeader('Set-Cookie', result.cookie)
      if (result.location) {
        response.writeHead(303, { Location: result.location })
        response.end()
        return
      }
      page(response, result.status, result.message ??
        (result.code ? '请复制验证码并私聊发给 Bot，完成群认证。' : '使用 GitHub 登录，完成 QQ 群认证。'), result)
    })().catch(() => {
      if (!response.headersSent) page(response, 503, '验证暂时不可用，请稍后再试。')
      else response.end()
    })
  })
  server.requestTimeout = 15_000
  server.headersTimeout = 10_000
  return server
}
