# IDBots UI Description Text Simplification

> 优化 IDBots 界面文字说明，解决"AI 味道"过重的问题

## 📋 概述 Overview

**问题**: IDBots 界面有太多冗长的说明文字（3-7+ 行），让用户感觉界面很重，阅读负担大。

**解决方案**: 将长文字说明移到 tooltip 悬浮提示中，只在需要时显示。界面保持简洁，信息依然完整。

---

## 📊 影响范围

### 需要优化的区域统计

| 严重程度 | 区域 | 文件数 | 字符串数 | 当前行数 | 优化后 |
|---------|------|--------|---------|---------|--------|
| 🔴 高优先级 | MetaBot 高级设置 | 1 | 6 | 19 行 | 0-3 行 |
| 🟡 中优先级 | 内存设置 | 1 | 24 | 36+ 行 | 0-12 行 |
| 🟢 低优先级 | 其他组件 | 10+ | 24 | 30+ 行 | 10-15 行 |
| **总计** | - | **12+** | **54** | **85+** | **10-30** |

**预期减少**: 55-75 行说明文字

---

## 🎯 核心优化点

### 1. MetaBot 编辑表单 - 高级标签

**文件**: `src/renderer/components/metabots/MetaBotEditTabs.tsx`

三个能力开关的说明文字过长：

| 开关 | 当前长度 | 行数 | 操作 |
|------|---------|------|------|
| MCP 工具 | 170 字符 | 4-5 行 | 移至 tooltip |
| 浏览器自动化 | 196 字符 | 5-6 行 | 移至 tooltip |
| 桌面操作 | 257 字符 | 7-8 行 | 移至 tooltip |

**节省**: 19 行 → 0-3 行 (减少 84-100%)

### 2. 内存设置

**文件**: `src/renderer/components/settings/MemorySettings.tsx`

12 个长说明文字，每个 3-6 行。

### 3. 其他组件

- Surf 设置、每日汇报、Knowledge Base 等
- 共 10+ 个组件需要优化

---

## 🎨 设计方案

### 视觉对比

**当前**:
```
Desktop Operations (Experimental)    ○───●
默认开启：开启后该 Bot 的 cowork 会话可截屏并操作本机桌面
（cua-driver）。需要给 IDBots 授予 macOS 辅助功能/录屏权限
（首次使用系统会弹窗）。所有动作仅以后台方式执行：任何会
移动你的物理鼠标或抢夺焦点的路由（前台投递、桌面作用域输入
、拖拽、修饰键点击）都会被策略拒绝...
(7-8 行)
```

**优化后**:
```
Desktop Operations (Experimental)  ❔    ○───●
    ↑ 鼠标悬停显示完整说明
```

### 交互流程

1. **默认**: 只显示标签和开关，界面简洁
2. **需要了解**: 鼠标悬停在 ❔ 图标上
3. **显示**: Tooltip 弹出完整说明
4. **移开**: Tooltip 隐藏

---

## 🛠 技术实现

### 使用现有组件

```tsx
import Tooltip from '../ui/Tooltip';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';

<label>
  {i18nService.t('metabotCoworkMcpTools')}
  <Tooltip content={i18nService.t('metabotCoworkMcpToolsTooltip')}>
    <QuestionMarkCircleIcon className="h-4 w-4 inline ml-1.5" />
  </Tooltip>
</label>
```

### i18n 字符串更新

每个长说明文字需要两个变体：

```typescript
// 选项 1: 完全移除行内文字
metabotCoworkMcpToolsTooltip: '完整说明...',

// 选项 2: 保留简短行内提示
metabotCoworkMcpToolsHintShort: '默认关闭。启用后挂载 MCP 工具',
metabotCoworkMcpToolsTooltip: '默认关闭：关闭时该 Bot 的...',
```

---

## 📦 文档结构

```
UI-DESCRIPTION-SIMPLIFICATION.md          # 执行摘要（本文档）
UI-DESCRIPTION-VISUAL-COMPARISON.md       # 视觉对比和示例
UI-DESCRIPTION-IMPLEMENTATION-CHECKLIST.md # 详细实施清单
localdocs/
  ├── ui-description-simplification-plan.md    # 完整计划
  └── ui-description-audit-details.md          # 全面审计报告
```

### 文档说明

1. **本文档** (README): 快速概览和执行摘要
2. **Visual Comparison**: 前后对比图和用户体验流程
3. **Implementation Checklist**: 分阶段任务清单，含代码示例
4. **Detailed Plan** (localdocs): 完整的规划文档
5. **Audit Details** (localdocs): 所有需要修改的字符串详情

---

## ⏱ 时间估算

| 阶段 | 任务 | 时间 |
|------|------|------|
| Phase 1 | MetaBot 高级设置 (3 开关) | 2 小时 |
| Phase 2 | 内存设置 (12 提示) | 3 小时 |
| Phase 3 | MetaBot 功能 (Surf, 每日汇报等) | 2 小时 |
| Phase 4 | Dream & 能力 | 1 小时 |
| Phase 5 | 群组任务 & 其他 | 1 小时 |
| 测试 & QA | 视觉 + 功能 + 回归 | 1 小时 |
| **总计** | - | **10 小时** |

---

## ✅ 成功标准

- [x] 方案设计完成
- [ ] 无单条行内说明超过 2 行
- [ ] 所有 5+ 行说明移至 tooltip
- [ ] ❔ 图标使用一致
- [ ] 悬停显示完整说明
- [ ] 中英文双语支持
- [ ] 无信息丢失
- [ ] 通过视觉 QA（亮/暗主题）
- [ ] 通过功能测试
- [ ] 通过回归测试

---

## 🚀 下一步

### 建议的实施顺序

#### 方案 A: 分阶段（推荐）
1. 先做 Phase 1 (MetaBot 高级设置)
2. 提交 PR，合并，观察反馈
3. 继续 Phase 2-5
4. 每个 Phase 独立 PR

**优点**: 
- 小 PR，易审查
- 可以早期发现问题
- 逐步验证效果

#### 方案 B: 一次性
1. 完成所有 5 个 Phase
2. 单个大 PR
3. 全面测试后合并

**优点**: 
- 一次性解决问题
- 整体效果更明显

**缺点**: 
- 大改动，审查难度高
- 风险集中

### 立即开始

查看 `UI-DESCRIPTION-IMPLEMENTATION-CHECKLIST.md` 获取详细的分步骤清单。

---

## 📞 问题和讨论

有任何疑问或建议，请：
1. 查看详细文档 (Visual Comparison / Implementation Checklist)
2. 在 PR 中讨论具体实现细节
3. 提供用户反馈和测试结果

---

## 📝 更新记录

- **2024-10-27**: 初始方案设计完成
  - 完成全面审计
  - 创建 4 个详细文档
  - 确定 54 个需要修改的字符串
  - 估算 10 小时实施时间

---

**分支**: `worktree-ui-description-simplify`  
**状态**: ✅ 方案设计完成，等待审批后实施
