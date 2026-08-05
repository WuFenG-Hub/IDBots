# Bot Homepage MetaApp V3

Bot homepage 是 MetaApp 的特例，但它的数据源和选中逻辑需要单独看。

## 1. v3 数据源

读取目标 Bot homepage 数据：

```text
https://so.metaid.io/api/bot-homepage/globalmetaid/<globalMetaId>?version=v3
```

把它当成 envelope：

- `body.code === 0`
- `body.data.schemaVersion === "botHomepage.v3"`

只有满足这两个条件，才把它当成有效 v3 数据。

## 2. 页面生成规则

生成出的项目里要带 `data.json` 本地快照，并采用 hybrid loading：

1. 先用 `data.json` 渲染
2. 再尝试请求线上 v3 数据
3. 请求成功且 envelope 合法，就用新数据重渲染
4. 请求失败时，保留本地快照，同时给轻量 stale / offline 提示

## 3. 重点字段

重点看这些分组（仅当存在时渲染）：

- `identity`：GlobalMetaID 和展示身份。
- `profile`：name、头像 metadata、bio、chat key 提示、LLM / persona 提示，以及选中的 homepage 声明。
- `presence`：只可能是 online 或 unknown 提示；**unknown 不是 profile 错误**，不要当成异常渲染。
- `sections.services`：公开的 skill services。
- `sections.metaapps`：该 Bot 发布的 MetaApps。
- `sections.chats`：**最近对外联系的 chat peers，不是聊天历史**——不要渲染成对话记录。
- `sections.buzzes`：最近的公开 buzz 内容。
- `warnings`：低优先级的非致命聚合提示。

`profile.homepage.payload.uri` 才是当前选中的 custom homepage。**不要**从 `sections.metaapps` 倒推出哪个是正在使用的 homepage。

## 4. legacy 兼容

不要依赖 v1/v2 专属字段，比如顶层的 `services`、`actions`、`proofs`、`source`、`chainName` 或 address 字段。如果必须消费 legacy homepage 响应，只把它当成兼容 fallback 处理。

## 5. 图片字段

如果头像或其它图片字段已经是可直接访问的 `http(s)` URL，就直接渲染。
如果还是 `metafile://...`、裸 pin id，或其它 MetaFile reference，按 [agent-browser-metaapp.md](agent-browser-metaapp.md) §8 的 MetaFile 图片解析顺序转成可访问 URL。头像优先用 avatar fallback base。

## 6. Message 按钮

homepage 上的普通 Message / Chat / Contact Bot / Send Message 按钮，必须调用**无参**的 `browser.privateChat.compose`（由宿主从当前 Bot Page owner 推导收件人）。只有当 MetaApp 自己拥有消息输入或显式指定收件人时，才用 `browser.simplemsg.compose` 同时传 `to` 和 `content`。详细规范见 [agent-browser-metaapp.md](agent-browser-metaapp.md) §9。

`map://simplemsg/conversation?peer=<globalMetaId>` 只用于“查看 / 打开已有会话”，不要用作发送按钮。

## 7. 发布后的 homepage 选中

发布 homepage MetaApp 之后：

- 先确认用户是否真的要把它设成某个 Bot 的选中 homepage
- 只有明确确认后，再执行 homepage 选中 follow-up

homepage payload 形状：

```json
{
  "homepage": {
    "uri": "metaapp://<pinId>",
    "renderer": "metaapp",
    "contentType": "application/vnd.metaapp"
  }
}
```

对齐 OAC 的做法，这个动作和普通 MetaApp publish 是两步，不要混成一步。

在 IDBots 当前技能里：

- 如果只是要看 payload，可先跑 `--prepare-homepage-payload <pinId>`
- 如果用户已经确认要设为当前 Bot homepage，就直接跑 `--set-homepage-metaapp <pinId>`
