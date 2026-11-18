import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Work } from '../shared/runtime.mts'
import { type VerificationEvent } from '../onebot/adapter.mts'
import { AdmissionStore, admissionKey, type Admission, type Phase } from './store.mts'
import { callbackFailure, callbackPath, startPath, githubURL, hash, OAuthFailure, secret, verifyGitHub, type OAuthConfig } from './oauth.mts'

const minute = 60_000
const windowMs = 10 * minute
const muteSeconds = 24 * 60 * 60
const maxFailures = 3
type Action = (selfId: string, name: string, params: Record<string, any>, signal: AbortSignal) => Promise<any>
type Attempt = { key: string; ticket: string; until: number; state?: string; verifier?: string; browser?: string }
type Page = { status: number; message?: string; code?: string; start?: boolean; remainingMs?: number; location?: string; cookie?: string }

export class Verifier {
  readonly work: Work
  private serial = new Map<string, Promise<unknown>>()
  private attempts = new Map<string, Attempt>()
  private retryAfter = new Map<string, number>()

  readonly cfg: OAuthConfig
  readonly store: AdmissionStore
  readonly action: Action
  readonly warn: (message: string) => void
  readonly now: () => number
  readonly github: typeof verifyGitHub

  constructor(cfg: OAuthConfig, store: AdmissionStore, action: Action, signal: AbortSignal,
    warn: (message: string) => void, now = Date.now, github = verifyGitHub) {
    this.cfg = cfg
    this.store = store
    this.action = action
    this.warn = warn
    this.now = now
    this.github = github
    this.work = new Work(signal)
  }

  private locked<T>(key: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.work.run(signal => {
      const job = (this.serial.get(key) ?? Promise.resolve()).catch(() => {}).then(() => {
        signal.throwIfAborted()
        return task(signal)
      })
      this.serial.set(key, job)
      return job.finally(() => { if (this.serial.get(key) === job) this.serial.delete(key) })
    })
  }

  private save(a: Admission, phase = a.phase): void {
    a.phase = phase
    a.updated = this.now()
    this.store.save(a)
  }

  private finish(a: Admission, phase: Phase): void {
    this.attempts.delete(admissionKey(a))
    delete a.digest
    delete a.codeUntil
    this.save(a, phase)
  }

  private review(a: Admission, reason: string): void {
    this.finish(a, 'review')
    this.warn(`需人工审核 - 群${a.groupId} 成员${a.userId} - ${reason}`)
  }

  private call(a: Admission, action: string, params: Record<string, any>, signal: AbortSignal): Promise<any> {
    return this.action(a.selfId, action, { ...params, group_id: Number(a.groupId), user_id: Number(a.userId) }, signal)
  }

  private async member(a: Admission, signal: AbortSignal) {
    const m = await this.call(a, 'get_group_member_info', { no_cache: true }, signal)
    if (String(m?.group_id) !== a.groupId || String(m?.user_id) !== a.userId ||
        !Number.isSafeInteger(m.join_time) || m.join_time <= 0 ||
        !Object.hasOwn(m, 'shut_up_timestamp') || !Number.isSafeInteger(m.shut_up_timestamp))
      throw new Error('无法确认成员或禁言状态')
    return { joined: m.join_time as number, ban: m.shut_up_timestamp as number, role: m.role as string }
  }

  private async privateMessage(a: Admission, value: string, signal: AbortSignal): Promise<boolean> {
    const routes = ['group', 'friend', 'group'] as const
    let lastRoute: typeof routes[number] = 'group'
    for (const route of routes) {
      if (signal.aborted) return false
      if (route === 'friend') {
        try {
          const friends = await this.action(a.selfId, 'get_friend_list', {}, signal)
          if (!Array.isArray(friends) || !friends.some(item => String(item?.user_id) === a.userId)) continue
        } catch { continue }
      }
      lastRoute = route
      try {
        if (route === 'friend') await this.action(a.selfId, 'send_private_msg', { user_id: Number(a.userId), message: value }, signal)
        else await this.call(a, 'send_private_msg', { message: value }, signal)
        return true
      } catch (error) {
        // A timeout or a closed connection can still have delivered the message.
        if (!(error instanceof Error) || !/^(?:error: )*(?:Error: )?OneBot调用失败，retcode=-?\d+$/.test(error.message)) break
      }
    }
    if (!signal.aborted) this.warn(`私信未确认 - 群${a.groupId} 成员${a.userId} - ${lastRoute === 'friend' ? '好友私聊' : '群临时会话'}`)
    return false
  }

  async receive(e: VerificationEvent): Promise<void> {
    if (e.selfId !== this.cfg.selfId) return
    if (e.kind === 'private') { await this.handlePrivate(e); return }
    if (!e.groupId || !this.cfg.groups.includes(e.groupId)) return
    const a: Admission = { selfId: e.selfId, groupId: e.groupId, userId: e.userId, eventTime: e.time,
      joinTime: 0, phase: 'banning', failures: 0, updated: this.now() }
    const key = admissionKey(a)
    await this.locked(key, async signal => {
      const old = this.store.get(key)
      if (e.kind === 'leave') {
        if (!old || e.time < old.eventTime || ['done', 'left'].includes(old.phase)) return
        old.eventTime = e.time
        this.finish(old, 'left')
        return
      }
      if (old && e.time <= old.eventTime) return
      if (e.time * 1000 < this.now() - windowMs || e.time * 1000 > this.now() + minute) return
      let current
      try { current = await this.member(a, signal) } catch {
        if (!signal.aborted) this.warn(`无法读取新成员状态 - 群${a.groupId} 成员${a.userId}`)
        return
      }
      if (current.joined > e.time || old?.joinTime === current.joined) return
      a.joinTime = current.joined
      this.attempts.delete(key)
      if (current.role !== 'member' || current.ban * 1000 > this.now()) {
        this.review(a, '成员已有禁言或具备管理权限')
        return
      }
      this.save(a)
      try {
        const before = Math.floor(this.now() / 1000)
        await this.call(a, 'set_group_ban', { duration: muteSeconds }, signal)
        const after = await this.member(a, signal)
        if (after.joined !== a.joinTime || after.ban < before + muteSeconds - 2 ||
          after.ban > Math.ceil(this.now() / 1000) + muteSeconds + 2) {
          this.review(a, '无法确认本次禁言')
          return
        }
        a.banUntil = after.ban
        this.save(a, 'waiting')
      } catch {
        this.review(a, '禁言操作未确认')
        return
      }
      try {
        await this.action(a.selfId, 'send_group_msg', { group_id: Number(a.groupId), message: [
          { type: 'at', data: { qq: a.userId } },
          { type: 'text', data: { text: ' 请查看 Bot 私信，在 10 分钟内完成 GitHub 认证。没收到私信的话，请从本群成员列表打开与 Bot 的临时会话，发送「开始」。' } },
        ] }, signal)
      } catch { if (!signal.aborted) this.warn(`群认证提示未确认 - 群${a.groupId}`) }
      await this.sendLink(a, signal)
    })
  }

  private async sendLink(a: Admission, signal: AbortSignal, reuse = false): Promise<void> {
    const key = admissionKey(a), now = this.now()
    const current = this.attempts.get(key)
    const attempt = reuse && current && !current.state && current.until > now ? current :
      { key, ticket: secret(), until: a.deadline ?? now + windowMs }
    if (attempt.until <= now) return
    this.attempts.set(key, attempt)
    const link = new URL(startPath, this.cfg.origin)
    link.searchParams.set('ticket', attempt.ticket)
    if (!await this.privateMessage(a, `请打开链接完成 GitHub 认证，再将网页显示的验证码发给我：\n${link.href}`, signal)) {
      if (attempt !== current) this.attempts.delete(key)
      return
    }
    if (a.deadline === undefined) {
      a.deadline = this.now() + windowMs
      attempt.until = a.deadline
      this.save(a, 'pending')
    }
  }

  private async handlePrivate(e: VerificationEvent): Promise<void> {
    const content = e.text ?? ''
    const command = /^(开始|\/restart oauth)(?: ([1-9][0-9]{0,14}))?$/.exec(content)
    const code = /^OMO-[A-Za-z0-9_-]{22}$/.test(content)
    if (!command && !code) return
    const candidates = this.store.byMember(e.selfId, e.userId).filter(a => this.cfg.groups.includes(a.groupId))
    const group = command?.[2] ?? e.groupId
    const digest = code ? hash(content) : undefined
    const matchingCode = digest && candidates.find(a => a.digest === digest)
    if (code && matchingCode && group && matchingCode.groupId !== group) return
    const target = matchingCode || (group ? candidates.find(a => a.groupId === group) : candidates.length === 1 ? candidates[0] : undefined)
    if (!target) {
      if (!group && candidates.length > 1) {
        await this.work.run(signal => this.privateMessage(candidates[0],
          `有多个群待验证，请发送「开始 群号」选择：${candidates.map(a => a.groupId).join('、')}`, signal))
      }
      return
    }
    const key = admissionKey(target)
    await this.locked(key, async signal => {
      const a = this.store.get(key)
      if (!a || a.joinTime !== target.joinTime) return
      if (a.phase === 'review') { await this.privateMessage(a, '请联系群管理员处理验证。', signal); return }
      if (a.phase !== 'waiting' && a.phase !== 'pending') return
      if (a.deadline !== undefined && this.now() >= a.deadline) return
      if (digest) {
        if (!a.digest || !a.codeUntil || this.now() >= a.codeUntil ||
            !timingSafeEqual(Buffer.from(a.digest, 'hex'), Buffer.from(digest, 'hex'))) {
          await this.privateMessage(a, '验证码无效或已过期。', signal)
          return
        }
        this.finish(a, 'verified')
        await this.unmute(a, signal)
        return
      }
      if (a.failures >= maxFailures) { await this.privateMessage(a, '验证次数已用完。剩余: 0/3，请联系群管理员。', signal); return }
      if (a.digest && (a.codeUntil ?? 0) > this.now()) {
        await this.privateMessage(a, 'GitHub 认证已完成，请把网页上的验证码发给我。', signal)
        return
      }
      if (command?.[1] === '开始' && a.failures > 0 && !this.attempts.has(key)) {
        await this.privateMessage(a, `请使用 /restart oauth 重试。剩余: ${maxFailures - a.failures}/3`, signal)
        return
      }
      const active = this.attempts.get(key)
      if (active?.state) { await this.privateMessage(a, '请先完成已打开的 GitHub 验证。', signal); return }
      if (a.phase === 'waiting') {
        const member = await this.member(a, signal)
        if (member.joined !== a.joinTime) { this.finish(a, 'left'); return }
        if (member.ban !== a.banUntil || member.ban * 1000 <= this.now() || member.role !== 'member') {
          this.review(a, '补发时无法确认验证禁言')
          return
        }
      }
      await this.sendLink(a, signal, true)
    })
  }

  async start(ticket: string, method: 'GET' | 'POST'): Promise<Page> {
    const candidate = [...this.attempts.values()].find(attempt => attempt.ticket === ticket && !attempt.state)
    if (!candidate) return { status: 410, message: '链接已失效，请私聊 Bot 发送「开始」。' }
    return this.locked(candidate.key, async () => {
      if (candidate !== this.attempts.get(candidate.key) || candidate.state || this.now() >= candidate.until)
        return { status: 410, message: '链接已失效。' }
      if (method === 'GET') return { status: 200, start: true, remainingMs: candidate.until - this.now() }
      candidate.state = secret()
      candidate.verifier = secret()
      candidate.browser = secret()
      return { status: 303, location: githubURL(this.cfg, candidate.state, candidate.verifier),
        cookie: this.cookie(candidate.state, candidate.browser) }
    })
  }

  private cookie(state: string, value: string): string {
    return `__Secure-omo-${hash(state).slice(0, 24)}=${value}; Path=${callbackPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=${value ? 600 : 0}`
  }

  async callback(query: URLSearchParams, cookies: string): Promise<Page> {
    const state = query.get('state')
    const pending = state && [...this.attempts.values()].find(attempt => attempt.state === state)
    if (!pending || !pending.browser || !cookies.split(/;\s*/).includes(this.cookie(state!, pending.browser).split(';')[0]))
      return { status: 400, message: '验证会话无效。' }
    return this.locked(pending.key, async signal => {
      const a = this.store.get(pending.key)
      const cookie = this.cookie(state!, '')
      if (!a || a.phase !== 'pending' || !a.deadline || this.attempts.get(pending.key) !== pending ||
          this.now() >= Math.min(a.deadline, pending.until)) return { status: 410, cookie, message: '验证会话已过期。' }
      this.attempts.delete(pending.key)
      try {
        const code = query.get('code')
        if (query.has('error') || !code || code.length > 512) throw callbackFailure(query.get('error'))
        await this.github(this.cfg, code, pending.verifier!, signal)
      } catch (error) {
        if (signal.aborted || this.now() >= a.deadline) return { status: 410, cookie, message: '验证会话已结束。' }
        const reason = error instanceof OAuthFailure ? error.reason : 'internal'
        this.warn(`GitHub OAuth 失败 - 群${a.groupId} 成员${a.userId} - ${reason}`)
        const network = reason.endsWith(':network') || /:http_(?:429|5\d\d)$/.test(reason)
        if (!network) a.failures++
        this.save(a)
        const left = maxFailures - a.failures
        await this.privateMessage(a, network ? `GitHub 暂时无法连接，请使用 /restart oauth 重试。本次未扣除次数，剩余: ${left}/3` :
          left ? `验证失败，请使用 /restart oauth 重试。剩余: ${left}/3` :
          '验证失败。剩余: 0/3，请联系群管理员。', signal)
        return { status: 200, cookie, message: network ? '暂时无法连接 GitHub，请私聊 Bot 发送 /restart oauth。' : 'GitHub 验证失败，请查看 Bot 私信。' }
      }
      if (this.now() >= a.deadline) return { status: 410, cookie, message: '验证会话已过期。' }
      const code = 'OMO-' + randomBytes(16).toString('base64url')
      a.digest = hash(code)
      a.codeUntil = Math.min(a.deadline, this.now() + 3 * minute)
      this.save(a)
      return { status: 200, cookie, code, remainingMs: a.codeUntil - this.now() }
    })
  }

  private async unmute(a: Admission, signal: AbortSignal): Promise<void> {
    const member = await this.member(a, signal)
    if (member.joined !== a.joinTime) { this.finish(a, 'left'); return }
    if (member.ban * 1000 <= this.now()) { this.finish(a, 'done'); return }
    if (member.ban !== a.banUntil || member.role !== 'member') { this.review(a, '禁言状态已由管理员更改'); return }
    this.save(a, 'unmuting')
    try {
      await this.call(a, 'set_group_ban', { duration: 0 }, signal)
      this.finish(a, 'done')
    } catch {
      if (!signal.aborted) await this.checkUnmute(a, signal)
    }
    if (a.phase === 'done') await this.privateMessage(a, 'GitHub 认证通过，已解除禁言。', signal)
  }

  private async checkUnmute(a: Admission, signal: AbortSignal): Promise<void> {
    const member = await this.member(a, signal)
    if (member.joined !== a.joinTime) { this.finish(a, 'left'); return }
    if (member.ban * 1000 <= this.now()) { this.finish(a, 'done'); return }
    this.review(a, '解禁结果未确认')
  }

  private async checkKick(a: Admission, signal: AbortSignal): Promise<void> {
    const list = await this.action(a.selfId, 'get_group_member_list', { group_id: Number(a.groupId), no_cache: true }, signal)
    if (!Array.isArray(list) || !list.some(m => String(m?.user_id) === a.selfId))
      throw new Error('无法确认群成员列表')
    if (!list.some(m => String(m?.user_id) === a.userId)) { this.finish(a, 'left'); return }
    this.review(a, '踢人结果未确认')
  }

  private async tickOne(a: Admission, signal: AbortSignal): Promise<void> {
    if (a.phase === 'verified') { await this.unmute(a, signal); return }
    if (a.phase === 'unmuting') { await this.checkUnmute(a, signal); return }
    if (a.phase === 'kicking') { await this.checkKick(a, signal); return }
    if (a.phase === 'banning') {
      this.review(a, '重启时禁言结果未确认')
      return
    }
    if (!a.deadline || a.phase !== 'pending') return
    const now = this.now()
    if (now >= a.deadline) {
      const member = await this.member(a, signal)
      if (member.joined !== a.joinTime) { this.finish(a, 'left'); return }
      if (member.ban !== a.banUntil || member.role !== 'member') { this.review(a, '超时时群成员或禁言状态已更改'); return }
      this.save(a, 'kicking')
      try {
        await this.call(a, 'set_group_kick', { reject_add_request: false }, signal)
        this.finish(a, 'left')
      } catch {
        if (!signal.aborted) await this.checkKick(a, signal)
      }
      return
    }
    if (a.digest && (a.codeUntil ?? 0) <= now) {
      delete a.digest
      delete a.codeUntil
      this.save(a)
    }
    if (!a.reminded && now >= a.deadline - 5 * minute) {
      a.reminded = true
      this.save(a)
      const remaining = Math.ceil((a.deadline - now) / minute)
      await this.privateMessage(a, `你的 GitHub 验证还未完成，剩余 ${remaining} 分钟。超时将被移出群聊。`, signal)
    }
  }

  tick(): Promise<void> {
    return this.work.run(async () => {
      const now = this.now()
      for (const [key, attempt] of this.attempts) if (attempt.until <= now) this.attempts.delete(key)
      for (const [key, retry] of this.retryAfter) if (retry <= now) this.retryAfter.delete(key)
      const due = this.store.active().filter(row => {
        if (row.selfId !== this.cfg.selfId || !this.cfg.groups.includes(row.groupId) || this.retryAfter.has(admissionKey(row))) return false
        if (row.phase !== 'pending') return true
        return row.deadline !== undefined && (now >= row.deadline ||
          (!row.reminded && now >= row.deadline - 5 * minute) || (row.codeUntil !== undefined && now >= row.codeUntil))
      })
      for (let i = 0; i < due.length; i += 8) {
        await Promise.all(due.slice(i, i + 8).map(row => {
          const key = admissionKey(row)
          return this.locked(key, async signal => {
            const a = this.store.get(key)
            if (!a || a.joinTime !== row.joinTime) return
            try { await this.tickOne(a, signal) } catch {
              if (signal.aborted) return
              this.retryAfter.set(key, this.now() + 30_000)
              this.warn(`群成员状态暂不可读 - 群${a.groupId} 成员${a.userId}`)
            }
          })
        }))
      }
      this.store.prune(now - 7 * 24 * 60 * minute)
    })
  }
}
