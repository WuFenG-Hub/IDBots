# UI Description Simplification - Implementation Checklist

## Quick Reference

**Goal**: Remove verbose UI descriptions (3-7+ lines) by moving them to tooltips
**Pattern**: `[Label ❔]` + optional short hint + full text on hover
**Component**: Use existing `Tooltip` from `src/renderer/components/ui/Tooltip.tsx`

---

## Phase 1: Critical Fixes (Do First) 🔴

### MetaBotEditTabs.tsx - Advanced Tab Cowork Capabilities

**File**: `src/renderer/components/metabots/MetaBotEditTabs.tsx`

- [ ] **MCP Tools** (line ~1290-1312)
  - [ ] Add tooltip icon next to label
  - [ ] Remove or shorten inline hint text
  - [ ] i18n: Add `metabotCoworkMcpToolsTooltip` (EN + ZH)
  - [ ] i18n: Optional `metabotCoworkMcpToolsHintShort` if keeping inline

- [ ] **Browser Automation** (line ~1315-1338)
  - [ ] Add tooltip icon next to label
  - [ ] Remove or shorten inline hint
  - [ ] i18n: `metabotCoworkBrowserAutomationTooltip`
  - [ ] i18n: Optional `*HintShort`

- [ ] **Desktop Computer Use** (line ~1340-1363)
  - [ ] Add tooltip icon next to label  
  - [ ] Remove or shorten inline hint
  - [ ] i18n: `metabotCoworkComputerUseTooltip`
  - [ ] i18n: Optional `*HintShort`

**Expected savings**: 19 lines → 0-3 lines (84-100% reduction)

---

## Phase 2: Memory & Settings 🟡

### MemorySettings.tsx

**File**: `src/renderer/components/settings/MemorySettings.tsx`

- [ ] **Context Window Size** hint
  - [ ] i18n: `contextWindowSizeTooltip` / optional `*HintShort`
  
- [ ] **Cowork API Config** hint
  - [ ] i18n: `coworkApiConfigTooltip`
  
- [ ] **LLM Judge Enabled** hint
  - [ ] i18n: `coworkMemoryLlmJudgeEnabledTooltip`
  
- [ ] **Visibility External Safe** hint
  - [ ] i18n: `coworkMemoryVisibilityExternalSafeTooltip`
  
- [ ] **Policy Max Items** hint
  - [ ] i18n: `memoryPolicyMaxItemsTooltip`
  
- [ ] **Hygiene Deep** hint
  - [ ] i18n: `memoryHygieneDeepTooltip`
  
- [ ] **Culture** hint
  - [ ] i18n: `memoryCultureTooltip`
  
- [ ] **Culture Comm Trend** hint
  - [ ] i18n: `memoryCultureCommTrendTooltip`
  
- [ ] **Practice Bot Toggle** hint
  - [ ] i18n: `memoryPracticeBotToggleTooltip`
  
- [ ] **Practice Auto Approve** hint
  - [ ] i18n: `memoryPracticeAutoApproveToggleTooltip`
  
- [ ] **Self Identity** hint
  - [ ] i18n: `memorySelfIdentityTooltip`
  
- [ ] **Embedding Download** hint
  - [ ] i18n: `coworkMemoryEmbeddingDownloadTooltip`

---

## Phase 3: MetaBot Features 🟢

### SurfSection.tsx

**File**: `src/renderer/components/metabots/SurfSection.tsx`

- [ ] **Surf Section** main hint
  - [ ] i18n: `surfSectionTooltip` + `surfSectionHintShort` (1 line)

### DailyReportSection.tsx

**File**: `src/renderer/components/metabots/DailyReportSection.tsx`

- [ ] **Daily Report** main hint
  - [ ] i18n: `dailyReportSectionTooltip` + `dailyReportSectionHintShort`

### MetaBotCreateForm.tsx

**File**: `src/renderer/components/metabots/MetaBotCreateForm.tsx`

- [ ] **Archetype** hint
  - [ ] i18n: `metabotArchetypeTooltip`

### KnowledgeBasePanel.tsx (if exists)

- [ ] **Knowledge Base** panel hint
  - [ ] i18n: `knowledgeBasePanelTooltip`

### MetawebStudyPanel.tsx (if exists)

- [ ] **MetaWeb Study** hint
  - [ ] i18n: `metawebStudyPanelTooltip`

---

## Phase 4: Dream & Capabilities 🟢

### DreamTelemetryPanel.tsx

**File**: `src/renderer/components/settings/DreamTelemetryPanel.tsx`

- [ ] **Failures** hint
  - [ ] i18n: `dreamTelemetryFailuresTooltip`
  
- [ ] **Diary Trust** hint
  - [ ] i18n: `dreamTelemetryDiaryTrustTooltip`

### CapabilityDraftsPanel.tsx

**File**: `src/renderer/components/settings/CapabilityDraftsPanel.tsx`

- [ ] **Capability Drafts** hint
  - [ ] i18n: `capabilityDraftsTooltip`

---

## Phase 5: Group Tasks & Misc 🟢

### GroupTask Components

**Files**: `src/renderer/components/groupTasks/*.tsx`

- [ ] **Review Silence** hint (NewGroupTaskModal or GroupTaskDetailView)
  - [ ] i18n: `groupTasksReviewSilenceTooltip`

### Settings.tsx

**File**: `src/renderer/components/Settings.tsx`

- [ ] **Workspace Instructions** hint (if exists)
  - [ ] i18n: `workspaceInstructionsTooltip`

### Skills Components

- [ ] **GitHub Import** description (if multi-line)
  - [ ] i18n: `githubImportTooltip`

- [ ] **Missing Skills Banner** description
  - [ ] i18n: `missingSkillsBannerTooltip`

---

## i18n Updates Checklist

**File**: `src/renderer/services/i18n.ts`

Total estimated: ~40 new strings (20 keys × 2 languages)

### String Naming Convention

- `*Tooltip`: Full explanation (replaces old `*Hint` in some cases)
- `*HintShort`: Optional 1-2 line inline version

### Template

```typescript
// Chinese
zh: {
  // Old (can remove or keep as Tooltip)
  metabotCoworkMcpToolsHint: '默认关闭：关闭时该 Bot...',
  
  // New
  metabotCoworkMcpToolsHintShort: '默认关闭。启用后挂载 MCP 工具', // Optional
  metabotCoworkMcpToolsTooltip: '默认关闭：关闭时该 Bot 的 cowork...', // Full
}

// English  
en: {
  metabotCoworkMcpToolsHintShort: 'Off by default. Mount MCP tools in cowork',
  metabotCoworkMcpToolsTooltip: 'Off by default: while off, this bot\'s...',
}
```

---

## Code Pattern Reference

### Basic Pattern (No Inline Hint)

```tsx
import Tooltip from '../ui/Tooltip';
import { QuestionMarkCircleIcon } from '@heroicons/react/24/outline';

<div className={rowClass}>
  <label className={labelClass}>
    {i18nService.t('labelKey')}
    <Tooltip content={i18nService.t('labelKeyTooltip')}>
      <QuestionMarkCircleIcon 
        className="h-4 w-4 inline ml-1.5 cursor-help
          dark:text-claude-darkTextSecondary text-claude-textSecondary
          hover:text-claude-accent dark:hover:text-claude-accent
          transition-colors" 
      />
    </Tooltip>
  </label>
  <div>
    <Toggle />
    {/* No hint text here */}
  </div>
</div>
```

### With Short Inline Hint

```tsx
<div className={rowClass}>
  <label className={labelClass}>
    {i18nService.t('labelKey')}
    <Tooltip content={i18nService.t('labelKeyTooltip')}>
      <QuestionMarkCircleIcon className="h-4 w-4 inline ml-1.5 cursor-help" />
    </Tooltip>
  </label>
  <div>
    <Toggle />
    <p className={hintClass}>
      {i18nService.t('labelKeyHintShort')}
    </p>
  </div>
</div>
```

### Reusable Helper Component (Optional)

If many places need the same pattern, create:

**File**: `src/renderer/components/ui/LabelWithTooltip.tsx`

```tsx
interface LabelWithTooltipProps {
  label: string;
  tooltip: string;
  className?: string;
}

const LabelWithTooltip: React.FC<LabelWithTooltipProps> = ({
  label,
  tooltip,
  className = '',
}) => (
  <label className={className}>
    {label}
    <Tooltip content={tooltip}>
      <QuestionMarkCircleIcon className="h-4 w-4 inline ml-1.5 cursor-help
        dark:text-claude-darkTextSecondary text-claude-textSecondary
        hover:text-claude-accent dark:hover:text-claude-accent
        transition-colors" 
      />
    </Tooltip>
  </label>
);

export default LabelWithTooltip;
```

Usage:
```tsx
<LabelWithTooltip
  label={i18nService.t('metabotCoworkMcpTools')}
  tooltip={i18nService.t('metabotCoworkMcpToolsTooltip')}
  className={labelClass}
/>
```

---

## Testing Checklist

### Visual QA
- [ ] Test in light theme
- [ ] Test in dark theme
- [ ] Test on small screen (mobile/narrow window)
- [ ] Test on large screen
- [ ] Verify tooltip positioning (doesn't go off-screen)
- [ ] Check tooltip readability (text not too wide/narrow)

### Functional QA
- [ ] All tooltips show on hover
- [ ] Tooltips hide when mouse moves away
- [ ] Toggle switches still work
- [ ] No information loss (all old text available in tooltips)
- [ ] Both EN and ZH languages show correct text
- [ ] Keyboard accessibility (focus states work)

### Regression Testing
- [ ] Compile: `npm run compile:electron` — 0 errors
- [ ] Build skills: `npm run build:skills` — 0 errors
- [ ] Lint: `npm run lint` — 0 errors/warnings
- [ ] Tests: `node --test tests/*.test.mjs` — all pass

---

## Progress Tracking

| Phase | Status | Files | Strings | Time Est. |
|-------|--------|-------|---------|-----------|
| Phase 1: Critical (MetaBotEditTabs) | ⏳ TODO | 1 | 6 | 2h |
| Phase 2: Memory Settings | ⏳ TODO | 1 | 24 | 3h |
| Phase 3: MetaBot Features | ⏳ TODO | 4 | 10 | 2h |
| Phase 4: Dream & Capabilities | ⏳ TODO | 2 | 6 | 1h |
| Phase 5: Group Tasks & Misc | ⏳ TODO | 3+ | 8 | 1h |
| Testing & QA | ⏳ TODO | - | - | 1h |
| **TOTAL** | ⏳ TODO | ~12 | ~54 | **10h** |

Update status: ⏳ TODO → 🚧 IN PROGRESS → ✅ DONE

---

## Rollout Strategy

### Option A: All at Once
- Complete all phases
- Single large PR
- Comprehensive testing at the end
- Risk: Large changeset, harder to review

### Option B: Phased Rollout (Recommended)
- Phase 1 → PR → Merge → Test in production
- Phase 2 → PR → Merge → Test
- Continue incrementally
- Benefit: Smaller PRs, easier review, can catch issues early

---

## Success Metrics

After completion, measure:

- [ ] Total lines of inline description text removed
- [ ] User feedback (subjective: "Does UI feel cleaner?")
- [ ] No increase in support questions about features
- [ ] Tooltip usage analytics (if available)

**Expected outcome**: 40-50 lines of description text → ~10 lines or 0 lines

---

## Related Documents

- `UI-DESCRIPTION-SIMPLIFICATION.md` - Executive summary & plan
- `UI-DESCRIPTION-VISUAL-COMPARISON.md` - Before/after mockups
- `localdocs/ui-description-simplification-plan.md` - Detailed plan
- `localdocs/ui-description-audit-details.md` - Full audit & text rewrites

---

**Last Updated**: 2024-10-27
**Branch**: `worktree-ui-description-simplify`
