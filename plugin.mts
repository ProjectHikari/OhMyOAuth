import path from 'node:path'
import { run } from '../../core/bridge/sdk/typescript/sdk.mts'
import type { VerificationEvent } from '../onebot/adapter.mts'
import { dataRoot, jsonFile, log } from '../shared/runtime.mts'
import { openSQLite, sqliteConfig } from '../shared/sqlite.mts'
import { createOAuthServer } from './http.mts'
import { config } from './oauth.mts'
import { AdmissionStore } from './store.mts'
import { Verifier } from './verifier.mts'

await run(async ctx => {
  const cfg = config(await jsonFile(path.join(dataRoot, 'ohmyoauth.json'), {}))
  if (!cfg) { log('INFO', ctx.pluginId, 'GitHub 群认证未启用'); return }
  const adapter = await ctx.call('adapter.onebot', 'status') as { verificationIngress?: boolean }
  if (!adapter.verificationIngress) throw new Error('请先开启并重新加载 OneBot 的 verificationIngress')

  const storage = await sqliteConfig(dataRoot, 'ohmyoauth')
  if (storage.path === ':memory:') throw new Error('OhMyOAuth 要求持久化状态')
  const db = openSQLite(dataRoot, 'ohmyoauth.sqlite', storage)
  await ctx.defer('OhMyOAuth 状态库', async () => { db.close() })
  const verifier = new Verifier(cfg, new AdmissionStore(db), (selfId, action, params, signal) =>
    ctx.call('adapter.onebot', 'action', { selfId, action, params }, signal),
  ctx.signal, message => log('WARN', ctx.pluginId, message))
  await ctx.defer('OhMyOAuth 认证任务', () => verifier.work.close())
  const server = createOAuthServer(verifier)
  await ctx.defer('OhMyOAuth HTTP 入口', () => new Promise<void>((resolve, reject) => {
    if (!server.listening) { resolve(); return }
    server.close(error => error ? reject(error) : resolve())
    server.closeAllConnections()
  }))
  let ready = false
  await ctx.on('body.onebot.verification', async raw => {
    if (ready) await verifier.receive(raw as VerificationEvent)
  })
  let scanning = false
  await ctx.every('OhMyOAuth 认证期限', 1000, async () => {
    if (!ready || scanning) return
    scanning = true
    try { await verifier.tick() } finally { scanning = false }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(cfg.port, '127.0.0.1', () => { server.off('error', reject); resolve() })
  })
  await ctx.after('启用 OhMyOAuth 入口', 0, async () => {
    ready = true
    log('OK', ctx.pluginId, `GitHub 群认证已启用 - ${cfg.groups.length} 个群`)
  })
})
