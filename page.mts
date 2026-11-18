import { randomBytes } from 'node:crypto'
import type { ServerResponse } from 'node:http'

const escapeHTML = (text: string) => text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

const style = `
@font-face{font-family:Outfit;src:url(/ohmyoauth/fonts/outfit-400.ttf) format("truetype");font-weight:400;font-display:swap}
@font-face{font-family:Outfit;src:url(/ohmyoauth/fonts/outfit-700.ttf) format("truetype");font-weight:700;font-display:swap}
:root {
  color-scheme: light dark;
  --page: #f8f8f6; --panel: #fcfcfb; --border: #dfdfdc; --ink: #1c1c1e;
  --muted: #5d5e63; --accent: #245f82; --accent-bg: #e6f0ff;
  --button: #9cb6f9; --button-hover: #bcdbfd; --button-ink: #16263c;
  --code: #f0f0ee; --warning: #8b6500;
  font-family: Outfit, "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
}
@media (prefers-color-scheme: dark) {
  :root {
    --page: #101113; --panel: #191b1f; --border: #2b2e34; --ink: #f1f1ef;
    --muted: #b8babd; --accent: #a5ebff; --accent-bg: #1d3449;
    --code: #101113; --warning: #ffcf76;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--page); color: var(--ink); line-height: 1.6; }
header { border-bottom: 1px solid var(--border); }
header > div { max-width: 1120px; margin: auto; padding: 16px clamp(20px, 5vw, 56px); font-size: 18px; font-weight: 700; }
main { max-width: 680px; margin: auto; padding: clamp(36px, 9vw, 104px) clamp(16px, 4vw, 24px) 36px; }
.card { background: var(--panel); border: 1px solid var(--border); border-radius: 16px; padding: clamp(20px, 6vw, 44px); }
h1 { margin: 0; line-height: 1.2; font-size: clamp(26px, 5vw, 38px); font-weight: 700; }
.description { margin: 12px 0 0; color: var(--muted); }
.timer { display: inline-flex; align-items: center; gap: 8px; margin: 20px 0 0; padding: 3px 10px; border-radius: 999px; color: var(--accent); background: var(--accent-bg); font-size: 14px; }
.timer output { font-variant-numeric: tabular-nums; font-weight: 700; }
.timer[data-short] { color: var(--warning); background: var(--code); }
.actions { margin-top: 26px; }
.proof { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; min-width: 0; }
code { flex: 1 1 200px; min-width: 0; overflow-wrap: anywhere; user-select: all; border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; background: var(--code); font: 14px/1.5 ui-monospace, Consolas, monospace; }
button { border: 0; border-radius: 999px; padding: 9px 17px; background: var(--button); color: var(--button-ink); font: inherit; font-weight: 700; cursor: pointer; }
button:hover { background: var(--button-hover); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.feedback { color: var(--muted); margin: 12px 0 0; font-size: 14px; }
`

const script = `
const timer = document.querySelector('.timer')
const feedback = document.querySelector('.feedback')
const actions = document.querySelector('.actions')
const copy = document.querySelector('[data-copy]')
const code = document.querySelector('code')

if (timer) {
  const output = timer.querySelector('output')
  const duration = Number(timer.dataset.remaining)
  const wall = Date.now()
  const monotonic = performance.now()
  let interval
  const update = () => {
    const elapsed = Math.max(Date.now() - wall, performance.now() - monotonic)
    const seconds = Math.max(0, Math.ceil((duration - elapsed) / 1000))
    output.textContent = String(Math.floor(seconds / 60)).padStart(2, '0') + ':' + String(seconds % 60).padStart(2, '0')
    timer.toggleAttribute('data-short', seconds <= 30)
    if (seconds === 0) {
      clearInterval(interval)
      if (actions) actions.hidden = true
      if (code) code.textContent = ''
      feedback.textContent = '已过期，请在 QQ 私聊 Bot 发送「开始」。'
      feedback.hidden = false
    }
  }
  interval = setInterval(update, 250)
  update()
  addEventListener('pageshow', update)
  document.addEventListener('visibilitychange', update)
}

copy?.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(code.textContent)
    feedback.textContent = '验证码已复制'
  } catch {
    const range = document.createRange()
    range.selectNodeContents(code)
    const selection = window.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    feedback.textContent = '已选中验证码，请手动复制'
  }
  feedback.hidden = false
})
`

type PageOptions = { code?: string; start?: boolean; remainingMs?: number }
export function page(response: ServerResponse, status: number, message: string, { code, start, remainingMs }: PageOptions = {}): void {
  const nonce = randomBytes(18).toString('base64url')
  response.setHeader('Content-Security-Policy',
    `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; font-src 'self'; form-action 'self' https://github.com; frame-ancestors 'none'; base-uri 'none'`)
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' })
  const seconds = Math.max(0, Math.ceil((remainingMs ?? 0) / 1000))
  const clock = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
  const timer = remainingMs === undefined ? '' : `<p class="timer" data-remaining="${Math.max(0, Math.round(remainingMs))}">${code ? '验证码剩余' : '认证剩余'} <output role="timer">${clock}</output></p>`
  const actions = code
    ? `<div class="actions proof"><code>${escapeHTML(code)}</code><button type="button" data-copy>复制验证码</button></div>`
    : start ? '<form class="actions" method="post"><button>使用 GitHub 登录</button></form>' : ''
  response.end(`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OAuth验证 - OhMyOAuth</title>
<style nonce="${nonce}">${style}</style>
</head>
<body>
<header><div>OhMyOAuth</div></header>
<main><section class="card" aria-labelledby="title">
<h1 id="title">OAuth验证</h1>
<p class="description">${escapeHTML(message)}</p>
${timer}${actions}
<p class="feedback" role="status" hidden></p>
</section></main>
<script nonce="${nonce}">${script}</script>
</body>
</html>`)
}
