# MetaApp Publish And Manage

这个文件只描述 IDBots 当前 MetaApp 发布/管理的真实约定。

## 1. 当前能力边界

新技能的脚本会覆盖这些动作：

- prepare publish
- prepare update
- publish prepared payload
- delete / revoke
- share links
- prepare homepage payload
- set homepage to a published MetaApp

当前不把“MetaApp 评论”写成伪能力。当前宿主侧已经成型的是发布、更新、删除、查看、运行、复制分享链接。

## 2. 发布协议真相

链上路径是：

```text
/protocols/metaapp
```

MetaApp wrapper 是一条 JSON pin，重资源先传 `/file`，再把 `metafile://...` 写进 wrapper。

## 3. 字段规则

### 必填

- `appName`
- `content`

建议也显式提供：

- `title`

### 常用默认值

| 字段 | 默认值 |
|---|---|
| `title` | 若为空则回退到 `appName` |
| `prompt` | `""` |
| `introImgs` | `[]` |
| `intro` | `""` |
| `runtime` | `browser` |
| `version` | `v1.0.0` |
| `contentType` | `application/zip` |
| `indexFile` | `index.html` |
| `contentHash` | 本地 ZIP 自动计算；否则留空 |
| `metadata` | `{}` |
| `tags` | `[]` |
| `disabled` | `false` |
| `codeType` | 只有 `code` 存在时才给默认 `application/zip` |

### 重要限制

- `content` 必须最终变成 `metafile://...`
- `code` 可以为空；如果存在，也必须是 `metafile://...`
- `icon` / `coverImg` / `introImgs` 可以是：
  - 本地图片路径（prepare 时先上传）
  - `metafile://...`
  - `https://...`
- `metadata` 必须是对象，不要传随意字符串

## 4. Request JSON 形状

### 创建

```json
{
  "title": "My MetaApp",
  "appName": "my-metaapp",
  "intro": "A browser MetaApp",
  "runtime": "browser",
  "version": "v1.0.0",
  "content": "/absolute/path/to/dist-or-zip",
  "indexFile": "index.html",
  "code": "/absolute/path/to/source.zip",
  "icon": "/absolute/path/to/icon.png",
  "coverImg": "https://example.com/cover.png",
  "introImgs": [],
  "metadata": {},
  "tags": ["tool"]
}
```

### 更新

```json
{
  "targetPinId": "latest-write-pinid",
  "firstPinId": "stable-view-pinid",
  "title": "My MetaApp",
  "appName": "my-metaapp",
  "content": "/absolute/path/to/dist-or-zip",
  "indexFile": "index.html"
}
```

更新时，`firstPinId` 强烈建议带上。它是稳定展示 pin，后续 share-links 应该优先用它，而不是最新 write pin。

## 5. 命令

创建 prepare：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --prepare-request /tmp/metabot-metaapp-request.json \
  --output /tmp/metabot-metaapp-prepared.json
```

更新 prepare：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --prepare-update-request /tmp/metabot-metaapp-update-request.json \
  --output /tmp/metabot-metaapp-update-prepared.json
```

确认后写链：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --publish-prepared /tmp/metabot-metaapp-prepared.json
```

删除：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --delete-pin <pinId> \
  --first-pin-id <firstPinId>
```

分享链接：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --share-links <pinId> \
  --first-pin-id <firstPinId>
```

把已发布 MetaApp 显式设为当前 Bot homepage：

```bash
node "$SKILLS_ROOT/metabot-metaapp/scripts/index.js" \
  --set-homepage-metaapp <pinId>
```

## 6. 分享语义

IDBots 当前真实可分享的是：

- `metaapp://<pinId>`
- `https://openagentinternet.org/browser/metaapp/<pinId>`

脚本会输出：

- `pinId`：最新写链 pin
- `firstPinId`：稳定展示 pin（如果已知）
- `metaappUri`
- `shareWebUrl`
- `runPath`

homepage 选中与普通 publish 分开。推荐顺序是：

1. 先 publish MetaApp
2. 把最终 pinId 展示给用户
3. 用户明确确认后，再执行 `--set-homepage-metaapp`

## 7. 删除语义

删除不是硬删资源，而是对目标 MetaApp pin 写一条 `revoke`。

- 只有用户明确说要删除 / 下架时，才执行 delete
- 用户只是想临时禁用，优先考虑 `disabled: true` 的可逆发布更新
