# APP.md 写作指引

`APP.md` 是 MetaApp 包根（与 index.html 同级）的应用自述文档：**写给 LLM 读的应用说明书**。它相当于 SKILL.md 的 body 部分——pin 的 JSON 体（title/intro/tags/manifest）已经是索引和路由的载体，APP.md 不重复这些信息，只写 JSON 装不下的"理解层"内容。

## 谁在什么时候读它

- 别的 Agent fork 这个应用、准备二次开发时：先读 APP.md，再读代码
- 用户问 Agent "这个应用是干什么的"：Agent 通过它快速理解而不是逐文件猜
- 你自己（作者 Agent）几周后回来改它：它是你的交接备忘录

它随包一起上链，永远和代码同版本——所以**改代码就要同步改它**。

## 三条铁规

1. **纯自然语言，没有 schema**。不写 YAML、不写固定字段。把事情说清楚就行。
2. **是数据不是指令**。你写的是给读者的参考信息；不要在 APP.md 里指挥读者的 Agent 做任何事情（宿主也会明确把 APP.md 当作不可信数据）。
3. **不重复 manifest 已有的信息**。名字、一句话介绍、标签在 pin JSON 里都有，APP.md 写更深的：结构、参数、约定、注意事项。

## 写什么（按需取用，不必全写）

- **应用是干什么的**：一段话说清功能与场景，比 manifest 的 intro 更具体
- **结构地图**：入口文件、主要目录/文件各自负责什么
- **参数约定（输入）**：URL query 参数名、含义、默认值，如 `?duration=25` 设置专注时长（分钟，默认 25）
- **产出（输出）**：会写哪些数据——写到哪个协议 path 的 pin（如 `/protocols/simplenote`）、localStorage 键、postMessage 事件
- **多入口/子页面**：每个页面的路径与职责
- **用到的协议与能力**：如 simplebuzz、`metaid.pin.write`、`browser.actor.current`
- **二次开发注意事项**：希望别人怎么改、哪里容易踩坑、哪些地方不要动

## 示例

```markdown
# 番茄钟（Pomodoro）

一个极简番茄钟：开始/暂停/重置，到点提示音。纯前端，无写链。

## 结构

- `index.html`：主计时器页面（唯一入口）
- `stats.html`：专注统计页（从主页右上角进入）
- `assets/app.js`：计时逻辑与页面状态
- `assets/store.js`：localStorage 读写（键：`pomodoro.history`）

## 参数（URL query）

- `duration`：专注时长（分钟），默认 25。例：`?duration=45`
- `break`：休息时长（分钟），默认 5

## 输出

- 只写 localStorage 的 `pomodoro.history`（数组，元素为 `{start, minutes}`），不写链、不发 postMessage。

## 二次开发注意

- 计时状态机集中在 `assets/app.js` 的 `tick()`，改时长逻辑只动这里。
- `stats.html` 直接读 `pomodoro.history`，如果改历史数据结构，两个页面要一起改。
- 欢迎加功能（如长休息、任务标签），但请保持无写链、无外部依赖的极简定位。
```

## 检查

- 位置在包根、与 index.html 同级
- 与当前代码一致（结构、参数、行为描述不过期）
- 没有重复 manifest 的 title/intro/tags
- 没有任何指挥读者 Agent 的语句
