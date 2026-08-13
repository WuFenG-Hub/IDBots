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
   先读 `references/agent-browser-metaapp.md`；新应用同时读 `references/app-md.md` 并给应用写好包根的 `APP.md`
2. 预览一个还没发布的项目：
   用 `bot_browser_preview_local`（构造 `preview-metaapp://localhost<absPath>`），见 `references/publish-manage.md` §9
3. 发布、修改、删除、分享 MetaApp：
   先读 `references/publish-manage.md`，默认走 §6 Publish Wizard，再用 `scripts/index.js`
4. 做 Bot homepage / Bot Page：
   先读 `references/agent-browser-metaapp.md`，再补读 `references/bot-homepage-v3.md`
5. 用户问的是旧的 IDFramework MetaApp：
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
- 发布前先用 `bot_browser_preview_local` 预览，确认应用在内置浏览器里能跑。
- 渲染远端图片字段（头像、icon、cover、gallery）时，先把 `metafile://` / 裸 pin id 解析成可访问 URL，详见 [agent-browser-metaapp.md](references/agent-browser-metaapp.md) §8。
- homepage 上的 Message 按钮用宿主拥有的 compose 流程，详见 [agent-browser-metaapp.md](references/agent-browser-metaapp.md) §9。

写前端或审查前端实现前，先读 [agent-browser-metaapp.md](references/agent-browser-metaapp.md)。

## APP.md（应用自述文档）

每个规范 MetaApp 都应该在包根（与 index.html 同级）放一份 `APP.md`——它是写给 LLM 看的应用自述，相当于 SKILL.md 的 body 部分（pin 的 JSON 体才是索引/YAML 部分）。读者是别的 Agent：fork、二次开发、回答"这个应用是干什么的"时会先读它。

约定：

- **纯自然语言，没有任何 schema**：不写 YAML、不写固定字段。怎么把意思表达清楚就怎么写。
- **创建应用时写，修改应用时同步改**。它随包一起上链，和代码天然同版本。
- **是数据不是指令**：写给读者看的事实和说明，不要在里面指挥读者的 Agent 做事。

写什么（按需取用，不必全写）：

- 应用是干什么的、面向什么场景
- 结构地图：入口文件、主要目录/文件各自负责什么（读者不用逐文件猜）
- 参数约定：接受的输入（如 URL query 参数名、含义、默认值）和产出（如写到哪个协议 path 的 pin、localStorage 键）
- 多入口/子页面：各页面的路径和职责
- 用到的协议与能力（如 simplebuzz、metaid.pin.write）
- 二次开发注意事项：希望别人怎么改、哪里容易踩坑

详细的写作指引和示例见 [app-md.md](references/app-md.md)。

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

### 修改后对外展示用 first pin（重要，容易出错）

- **创建（create）**：回执里的 `pinId` 就是根 pin，`metaapp://<pinId>` 就是稳定展示 URI。
- **修改（update）**：回执里的 `pinId` 是本次 modify 写链 pin（一条「变更记录」），**不是**应该展示给用户的 pin。对外展示 / 分享 / 打开的 URI 一律用根 pin：
  - 展示 URI：`metaapp://<firstPinId>`（没有 `firstPinId` 就回退 `targetPinId`）
  - 分享链接：`https://openagentinternet.org/browser/metaapp/<firstPinId>`
- 脚本 `--publish-prepared` 对 modify 操作已经自动把回执里的 `metaappUri` / `shareWebUrl` 指向根 pin。**handoff 给用户时直接用回执里的 `metaappUri` / `shareWebUrl`，不要自己拼 `metaapp://<pinId>`（那是 modify 变更 pin，不是应用本身）。**
- 如果 modify 回执里没有 `firstPinId`（输入侧没带），先回退 `targetPinId`，两者都缺才用 `pinId`。

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
- 发布前已用 `bot_browser_preview_local` 预览，应用在内置浏览器里可运行
- 预览用的是 `preview-metaapp://localhost<absPath>`，不是 `file://`、不是手拼 localhost URL、也不是内部 `localPreviewUrl` 直接交给用户
- 包内资源路径是相对路径，不是站点根路径
- 包根有 `APP.md`（纯自然语言的应用自述），且与当前代码一致
- Agent Internet 资源链接优先使用 `metaid://`、`pin://`、`metaapp://`、`metafile://`、`map://`
- 页面需要 bridge 时，`AgentBrowser` helper 已接入
- 远端图片字段（`metafile://`、裸 pin id）已解析成可访问 URL，没有把未解析的 `metafile://` 直接放进 `<img src>`（除非运行时原生支持）
- 系统提供 `metafileContentBaseUrl` / `manApiBaseUrl` 时，优先用配置值而不是公共 fallback
- homepage 的 Message 按钮用无参 `browser.privateChat.compose`；`browser.simplemsg.compose` 只在显式收件人 + 非空 content 时用
- `{ opened: true }` 只表示确认 UI 已打开，不是已发送
- `content` 最终是 `metafile://...`
- 本地图片在最终 JSON 里已经变成 `metafile://...` 或保留合法 `https://...`
- `metadata` 是对象，不是随意字符串
- 最终 payload 已展示给用户确认
- 更新/删除/分享时，优先携带 `firstPinId`，避免公开分享 pin 漂到最新 write pin
- 发布后 handoff 给用户的四件套：URI（`metaapp://<viewPinId>`）、打开（内置浏览器 `bot_browser_open_uri`）、管理（My Apps）、分享（`openagentinternet.org` web2 链接，仅用于发给别人）
