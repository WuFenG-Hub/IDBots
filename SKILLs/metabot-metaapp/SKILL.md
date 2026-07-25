---
name: metabot-metaapp
description: 统一的 MetaApp 技能。用于指导和执行 Bot Browser 里的静态 MetaApp 开发、Agent Internet 协议链接接入、MetaID PIN 写链、MetaFile 上传，以及 MetaApp 的发布、修改、删除、分享和 Bot homepage/Bot Page 制作。只要用户提到 MetaApp、静态网站上链、Bot Page/homepage、metaid://、pin://、metafile://、metaapp://、map://、MetaApp 发布/修改/分享，就优先使用这个技能，而不是旧的 IDFramework 专用技能或旧的发布单点技能。
official: true
---

# MetaBot MetaApp

把这个技能当作 IDBots 里所有 MetaApp 相关工作的统一入口。

MetaApp 现在的主模型很简单：它就是一个能在 Bot Browser 里运行的静态网站包，通常是 ZIP-backed HTML/CSS/JS 资源，再通过 `/protocols/metaapp` 写到链上。它不再默认要求 IDFramework；只要是浏览器可运行的静态站点，并且遵守 Agent Internet URI、Bot Browser bridge、MetaApp 发布协议约定，就可以作为规范 MetaApp。

## 这个技能负责什么

- 设计或开发新的静态 MetaApp
- 把本地项目目录、构建产物目录、HTML 包或 ZIP 发布成链上 MetaApp
- 更新、删除、分享已经发布的 MetaApp
- 制作 Bot homepage / Bot Page 类 MetaApp
- 解释和接入 `metaid://`、`pin://`、`metafile://`、`metaapp://`、`map://`
- 指导 MetaApp 内如何使用 `window.AgentBrowser.navigate(...)` 和 `window.AgentBrowser.request(...)`

## 路由方式

先判断用户要做的是哪一类事：

1. 开发新的 MetaApp，或改一个现有静态站点的 Agent Internet 接入方式：
   先读 `references/agent-browser-metaapp.md`
2. 发布、修改、删除、分享 MetaApp：
   先读 `references/publish-manage.md`，再用 `scripts/index.js`
3. 做 Bot homepage / Bot Page：
   先读 `references/agent-browser-metaapp.md`，再补读 `references/bot-homepage-v3.md`
4. 用户问的是旧的 IDFramework MetaApp：
   只有在用户明确要维护 IDFramework 老项目时，才考虑旧技能；普通 MetaApp 工作一律走本技能

## 开发规则

- 接受任何浏览器可运行的静态站点。不要把 IDFramework 当默认方案，也不要要求用户迁移到 IDFramework。
- 优先使用 Agent Internet URI，而不是把本来已经有协议语义的资源继续写成 Web2 URL。
- MetaApp 包内资源必须使用相对路径。不要发布依赖 `/assets/...`、`/css/...`、`/js/...` 这类站点根路径的包。
- 只要页面里要点击 `metaid://`、`pin://`、`metaapp://`、`metafile://`、`map://`，或者要调用宿主 bridge，就把 `AgentBrowser` helper 放进页面里，而且只放一次。
- 读取当前发帖/写链身份，用 `browser.actor.current`。
- 写链用 `metaid.pin.write`。
- 选文件上传用 `metafile.upload`。
- 不要在 MetaApp 里请求钱包 API、私钥、支付 API、宿主路由、本地文件路径、父 DOM 访问权。

写前端或审查前端实现前，先读 [agent-browser-metaapp.md](references/agent-browser-metaapp.md)。

## 发布和管理规则

MetaApp 的发布、更新、删除、分享，以 `references/publish-manage.md` 和 `scripts/index.js` 为准。

### 默认流程

1. 整理 request JSON
2. 跑 prepare，让脚本负责打包目录、上传 ZIP、上传图片、组装最终 payload
3. 把 prepare 结果里的最终 JSON 完整展示给用户
4. 用户确认后，再执行真正的链上写入

### 常用命令

创建发布准备文件：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --prepare-request /tmp/metabot-metaapp-request.json \
  --output /tmp/metabot-metaapp-prepared.json
```

更新发布准备文件：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --prepare-update-request /tmp/metabot-metaapp-update-request.json \
  --output /tmp/metabot-metaapp-update-prepared.json
```

确认后真正写链：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --publish-prepared /tmp/metabot-metaapp-prepared.json
```

删除 MetaApp：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --delete-pin <pinId> \
  --first-pin-id <firstPinId>
```

生成分享链接：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --share-links <pinId> \
  --first-pin-id <firstPinId>
```

如果用户想“顺手发一条公告 buzz”，保持在本技能里完成：先生成分享 URI/URL，再把它写进 buzz 文案，调用 `metabot-post-buzz/scripts/post-buzz.js`。不要把用户赶去另一个技能重新开始。

## Bot Homepage MetaApp

Bot homepage 是 MetaApp 的一个特例，但 `/info/homepage` 仍然是单独的指针记录，不是 `/protocols/metaapp` 本体的一部分。

- 先按普通 MetaApp 做开发与发布
- 如果这是一个 Bot homepage / Bot Page，再补读 [bot-homepage-v3.md](references/bot-homepage-v3.md)
- 发布后，如果用户明确说这个 MetaApp 要成为某个 Bot 的选中 homepage，再执行显式的 homepage follow-up

准备 homepage payload：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --prepare-homepage-payload <pinId>
```

显式设为当前 Bot 的选中 homepage：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --set-homepage-metaapp <pinId>
```

这里尽量对齐 OAC：

- 普通 MetaApp publish 仍然不会自动完成 homepage 选中
- homepage 选中仍然是第二步，而且要在用户明确确认后再执行
- 但第二步现在可以继续在本技能里直接完成，而不是只停在 payload 准备

## 验证清单

- 项目是浏览器可运行的静态站点
- 包内资源路径是相对路径，不是站点根路径
- Agent Internet 资源链接优先使用 `metaid://`、`pin://`、`metaapp://`、`metafile://`、`map://`
- 页面需要 bridge 时，`AgentBrowser` helper 已接入
- `content` 最终是 `metafile://...`
- 本地图片在最终 JSON 里已经变成 `metafile://...` 或保留合法 `https://...`
- `metadata` 是对象，不是随意字符串
- 最终 payload 已展示给用户确认
- 更新/删除/分享时，优先携带 `firstPinId`，避免公开分享 pin 漂到最新 write pin
