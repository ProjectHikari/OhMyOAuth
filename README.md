# OhMyOAuth

OhMyOAuth 是 Testbot 的 QQ 群认证插件。新人入群后先禁言，在网页完成 GitHub OAuth，再把一次性验证码私聊发给 Bot。验证通过后，Bot 解除本次认证施加的禁言。

Bot 在群里成功 @ 新人后开始计时。第 5 分钟提醒，第 10 分钟仍未验证则移出群。没收到链接时，私聊 Bot 发送「开始」。OAuth 失败后可用 `/restart oauth` 重试，每次入群最多 3 次。

## 接入

需要 Node.js 24、Testbot Core 的 TypeScript SDK、`plugins/shared` 的运行时与 SQLite 模块，以及支持 `body.onebot.verification` 的 me.onebot。将本仓库检出到 Testbot 的 `plugins/ohmyoauth` 目录。

```sh
git clone https://github.com/ProjectHikari/OhMyOAuth.git plugins/ohmyoauth
```

公开版 me.onebot 如果还没有认证事件，可以在 me.onebot 仓库根目录应用 [兼容补丁](integration/me.onebot.patch)。补丁基于 `79f4f75`。部署时同时检查宿主当前加载的事件清单。

OAuth App、HTTPS 回调、测试群及权限设置见 [配置说明](SETUP.md)。默认需要显式启用，并填写要处理的群号。

## 许可

源码采用 AGPL-3.0。Outfit 字体使用 SIL Open Font License。[源码许可](LICENSE) · [字体许可](fonts/OFL.txt)
