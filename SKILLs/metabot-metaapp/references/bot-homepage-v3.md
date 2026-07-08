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

重点看这些分组：

- `identity`
- `profile`
- `presence`
- `sections.services`
- `sections.metaapps`
- `sections.chats`
- `sections.buzzes`
- `warnings`

`profile.homepage.payload.uri` 才是当前选中的 custom homepage。不要从 `sections.metaapps` 倒推出哪个是正在使用的 homepage。

## 4. 图片字段

如果头像或其它图片字段已经是可直接访问的 `http(s)` URL，就直接渲染。  
如果还是 `metafile://...`、裸 pin id，或其它 MetaFile reference，再转成可访问 URL。

## 5. 发布后的 homepage 选中

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
