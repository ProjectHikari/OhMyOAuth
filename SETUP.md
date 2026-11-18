# OhMyOAuth

新成员先禁言，完成 GitHub 登录并向 Bot 私聊验证码后解禁。只有配置的机器人账号和群启用认证。

## 配置

1. 创建专用 GitHub OAuth App。回调地址填 `https://<认证域名>/ohmyoauth/callback`。将 Client ID 和 Client Secret 分别注入宿主的 `OHMYOAUTH_GITHUB_CLIENT_ID`、`OHMYOAUTH_GITHUB_CLIENT_SECRET` 环境变量。
2. 在插件数据目录添加 `ohmyoauth.json`。将示例中的机器人号和群号替换为实际值。

```json
{
  "enabled": true,
  "selfId": "123456789",
  "groups": ["987654321"],
  "publicOrigin": "https://auth.example.com",
  "port": 3220
}
```

3. 将公网 HTTPS 的 `/ohmyoauth/start` 和 `/ohmyoauth/callback` 代理到 `127.0.0.1:3220`。认证路径禁记请求参数和 Cookie。核对 SnowLuma 侧的消息日志和历史设置，避免认证私信被记录。
4. 在 OneBot 配置中设置 `"verificationIngress": true`。确认活动清单里的 `me.onebot` 已声明 `body.onebot.verification`，然后重启宿主使事件声明生效。启用或挂载 `me.ohmyoauth`。使用插件栈时将它的 `autostart` 设为 `true`。
5. 先用测试群验证进群、临时私信、回码、解禁和超时踢人，再加入正式群。机器人需要群管理权限，群要允许临时会话。

未收到验证私信时，从群成员列表私聊 Bot 发送「开始」。首次成功发送链接后开始计时。第 5 分钟提醒，第 10 分钟移出群聊。GitHub 验证失败时用 `/restart oauth` 重试，每次入群共 3 次尝试。 GitHub 网络故障不扣次数，原截止时间继续计算。同一个 QQ 号有多个待验证群时，使用「开始 群号」选择。

首条私信一直无法发出时，机器人不会自动踢人。验证禁言最长 24 小时。人工修改的禁言需由群管理员处理。
