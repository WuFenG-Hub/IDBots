import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Static wiring tests for the tracked-task board UI fixes (owner 2026-09-18).
 *
 * The dev-instance E2E pass is noisy (vite HMR full-reloads), so the wiring
 * contracts these fixes introduced are locked here at source level, following
 * the repo's *Static.test.mjs pattern. Each assertion names the exact file and
 * the load-bearing token; refactorings that break the wiring fail loudly.
 */

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(projectRoot, ...parts), 'utf8');

const drawerSrc = read('src', 'renderer', 'components', 'trackedTasks', 'TrackedTaskDrawer.tsx');
const linkSrc = read('src', 'renderer', 'components', 'trackedTasks', 'MetaWebUriLink.tsx');
const modalSrc = read('src', 'renderer', 'components', 'trackedTasks', 'AdmissionRulesModal.tsx');
const sectionSrc = read('src', 'renderer', 'components', 'trackedTasks', 'TrackedTasksSection.tsx');
const appSrc = read('src', 'renderer', 'App.tsx');
const composerSrc = read('src', 'renderer', 'components', 'cowork', 'CoworkPromptInput.tsx');
const serviceSrc = read('src', 'renderer', 'services', 'trackedTask.ts');
const preloadSrc = read('src', 'main', 'preload.ts');
const mainSrc = read('src', 'main', 'main.ts');
const boardSrc = read('src', 'main', 'services', 'trackedTaskBoard.ts');
const typesSrc = read('src', 'renderer', 'types', 'trackedTask.ts');
const dtsSrc = read('src', 'renderer', 'types', 'electron.d.ts');
const i18nSrc = read('src', 'renderer', 'services', 'i18n.ts');

test('drawer: the fixed overlay root carries non-draggable so the header drag strip cannot swallow clicks', () => {
  // The root node of the drawer (fixed inset-0 z-50) must be non-draggable:
  // ScheduledTasksView's 48px header is draggable and window-global drag
  // regions ignore DOM stacking, so the top-right X was unclickable.
  const root = drawerSrc.match(/<div className="([^"]*fixed inset-0 z-50[^"]*)">/);
  assert.ok(root, 'drawer fixed root found');
  assert.match(root[1], /(?:^|\s)non-draggable(?:\s|$)/, 'drawer root must carry non-draggable');
});

test('drawer: the scroll body carries min-h-0 (flex column min-height:auto trap)', () => {
  assert.match(
    drawerSrc,
    /className="min-h-0 flex-1 overflow-y-auto px-4 pb-4"/,
    'drawer body must be min-h-0 flex-1 overflow-y-auto',
  );
});

test('drawer: goal text preserves newlines and clamps to 6 lines with a measured expand/collapse', () => {
  assert.match(drawerSrc, /whitespace-pre-wrap/, 'goal copy must keep original line breaks');
  assert.match(drawerSrc, /WebkitLineClamp: collapsedLines/, 'collapsed state applies the line clamp');
  assert.match(drawerSrc, /GOAL_COLLAPSED_LINES = 6/, 'goal default truncation is ~6 lines');
  assert.match(
    drawerSrc,
    /collapsedLines=\{GOAL_COLLAPSED_LINES\}/,
    'the goal renders at the 6-line clamp',
  );
  assert.match(
    drawerSrc,
    /scrollHeight > el\.clientHeight \+ 1/,
    'expand/collapse visibility is measured via ref overflow, not a char heuristic',
  );
  // The measured value gates the button; expanding keeps the button visible.
  assert.match(drawerSrc, /\(expanded \|\| collapsedOverflow\)/);
  assert.match(drawerSrc, /'trackedTask\.drawer\.expand'/);
  assert.match(drawerSrc, /'trackedTask\.drawer\.collapse'/);
  // A card switch must reset the expansion state (keyed remount).
  assert.match(drawerSrc, /key=\{`goal-\$\{detail\.id\}`\}/, 'the goal remounts on card switch');
});

test('drawer: the header title (owner_intent, 1600+ chars) clamps to 3 lines and shares the measured expand/collapse', () => {
  // Owner 2026-09-18 feedback ②: the raw title wall left the body 0px tall and pushed
  // the footer off-screen; the title now folds at 3 lines like the goal.
  assert.match(drawerSrc, /TITLE_COLLAPSED_LINES = 3/, 'title folds at 3 lines');
  assert.match(
    drawerSrc,
    /collapsedLines=\{TITLE_COLLAPSED_LINES\}/,
    'the header title renders at the 3-line clamp',
  );
  assert.match(drawerSrc, /key=\{`title-\$\{detail\.id\}`\}/, 'the title remounts on card switch');
  assert.match(drawerSrc, /as="h2"/, 'the title keeps its h2 semantics');
});

test('drawer: the expanded text scrolls inside a max-h-[40vh] container and the toggle stays outside it', () => {
  // Owner 2026-09-18 feedback ②: expansion must not grow the drawer unbounded — the
  // text is capped at 40vh and scrolls internally, and the expand/collapse button is
  // rendered OUTSIDE the capped container so it can never scroll out of reach.
  assert.match(
    drawerSrc,
    /EXPANDED_TEXT_MAX_HEIGHT_CLASS = 'max-h-\[40vh\]'/,
    'the expanded cap constant is 40vh',
  );
  assert.match(
    drawerSrc,
    /EXPANDED_TEXT_MAX_HEIGHT_CLASS\} overflow-y-auto`/,
    'the expanded state wraps the text in a capped, internally scrollable container',
  );
  const scrollIdx = drawerSrc.indexOf('${EXPANDED_TEXT_MAX_HEIGHT_CLASS} overflow-y-auto');
  const toggleIdx = drawerSrc.indexOf('(expanded || collapsedOverflow)');
  assert.ok(scrollIdx > -1, 'the capped scroll container exists');
  assert.ok(toggleIdx > scrollIdx, 'the toggle button sits outside the capped scroll container');
});

test('MetaWebUriLink: only MetaWeb schemes linkify, bare pinIds become pin:// URIs, clicks ride botBrowser:openUri', () => {
  assert.match(
    linkSrc,
    /\(?:pin\|metaapp\|metafile\|metaid\):\/\//,
    'the scheme allowlist is exactly pin:// metaapp:// metafile:// metaid://',
  );
  assert.match(linkSrc, /\[0-9a-f\]\{64\}i0/, 'bare pinId pattern (64 hex + i0) is recognised');
  assert.match(linkSrc, /`pin:\/\/\$\{token\}`/, 'a bare pinId is turned into pin://<pinId>');
  assert.match(
    linkSrc,
    /botBrowser:openUri/,
    'clicks dispatch the existing botBrowser:openUri channel',
  );
  assert.match(linkSrc, /newTab: true/, 'link clicks open a NEW browser tab');
  // Scheme-coloured link text (owner 2026-09-18 feedback ③) replaces the uniform accent.
  for (const [scheme, colour] of [
    ['pin', 'text-sky-'],
    ['metaapp', 'text-violet-'],
    ['metafile', 'text-emerald-'],
    ['metaid', 'text-amber-'],
  ]) {
    assert.match(
      linkSrc,
      new RegExp(`${scheme}: '${colour}`),
      `${scheme}:// links use ${colour}* (scheme-coloured, not accent)`,
    );
  }
  assert.doesNotMatch(linkSrc, /text-claude-accent/, 'the uniform accent colour is gone');
  assert.match(linkSrc, /hover:underline/, 'hover underline is preserved');
  // Non-MetaWeb strings stay plain text: there is no http(s) branch.
  assert.doesNotMatch(linkSrc, /https?(?::|\\?\/)/, 'no http(s) linkification');
});

test('drawer: deliverable rows carry a scheme-coloured type badge; the status chip stays secondary', () => {
  // Owner 2026-09-18 feedback ③: metaapp deliverable rows used to render as "pin"
  // (backend ordering bug); the row now badges the kind with its own colour ramp.
  assert.match(drawerSrc, /const DELIVERABLE_KIND_BADGE_CLASS: Record<string, string> = \{/);
  assert.match(
    drawerSrc,
    /metaapp: 'border-violet-500\/40 bg-violet-500\/10 text-violet-600 dark:text-violet-400'/,
    'metaapp badge is violet',
  );
  assert.match(
    drawerSrc,
    /metafile: 'border-emerald-500\/40 bg-emerald-500\/10 text-emerald-600 dark:text-emerald-400'/,
    'metafile badge is emerald',
  );
  assert.match(
    drawerSrc,
    /pin: 'border-sky-500\/40 bg-sky-500\/10 text-sky-600 dark:text-sky-400'/,
    'pin badge is sky',
  );
  assert.match(
    drawerSrc,
    /url: 'border-amber-500\/40 bg-amber-500\/10 text-amber-600 dark:text-amber-400'/,
    'url badge is amber',
  );
  assert.match(drawerSrc, /deliverableKindBadgeClass\(item\.kind\)/, 'badge class resolves from the item kind');
  assert.match(drawerSrc, /deliverableKindLabel\(item\.kind\)/, 'badge label resolves from the item kind');
  for (const key of ['metaapp', 'metafile', 'pin', 'url', 'other']) {
    assert.match(drawerSrc, new RegExp(`'trackedTask\\.uriKind\\.${key}'`), `badge label key ${key}`);
  }
  // The old kind/status chip survives as the secondary neutral chip.
  assert.match(drawerSrc, /\{item\.status && \(/, 'the status chip renders whenever a status exists');
  assert.doesNotMatch(drawerSrc, /item\.kind \|\| item\.status \|\| '—'/, 'the raw kind chip is gone');
});

test('i18n: the closure-due banner copy stays neutral — it never claims an age bound', () => {
  // Owner 2026-09-18: "{count} 张卡已超 2 天无动静" misreported same-day terminal cards,
  // because counts.closureDue is the three-level SUM while "over 2 days" only fits the
  // zombie level. The banner copy must therefore carry NO age claim.
  const zhStart = i18nSrc.indexOf('  zh: {');
  const enStart = i18nSrc.indexOf('  en: {');
  assert.ok(zhStart > -1 && enStart > zhStart, 'both dictionaries located');
  const zhBlock = i18nSrc.slice(zhStart, enStart);
  const enBlock = i18nSrc.slice(enStart);
  const zhLine = zhBlock.split('\n').find((line) => line.includes("'trackedTask.closureDueBanner'"));
  const enLine = enBlock.split('\n').find((line) => line.includes("'trackedTask.closureDueBanner'"));
  assert.ok(zhLine, 'zh banner entry exists');
  assert.ok(enLine, 'en banner entry exists');
  assert.doesNotMatch(zhLine, /超 ?2 ?天/, 'zh banner must not claim "over 2 days"');
  assert.doesNotMatch(zhLine, /天无动静/, 'zh banner must not claim "no activity for N days"');
  assert.doesNotMatch(enLine, /2 days/i, 'en banner must not claim "2 days"');
  assert.doesNotMatch(enLine, /idle over/i, 'en banner must not claim "idle over"');
  // The neutral wording and the {count} placeholder survive.
  assert.match(zhLine, /\{count\} 张卡待收口/, 'zh banner uses the neutral "{count} 张卡待收口"');
  assert.match(enLine, /\{count\} card\(s\) awaiting close-out/, 'en banner uses the neutral wording');
});

test('drawer: deliverables and the closure pinId render through MetaWebUriLink', () => {
  assert.match(drawerSrc, /<MetaWebUriLink text=\{item\.uri\} \/>/, 'deliverable uris are links');
  assert.match(drawerSrc, /<MetaWebUriLink text=\{detail\.closure\.pinId\} \/>/, 'closure pinId is a link');
});

test('toolbar: admission entry sits left of refresh, refresh left of the new-task button', () => {
  const admIdx = sectionSrc.indexOf("i18nService.t('trackedTask.admission.entry')");
  const refreshIdx = sectionSrc.indexOf('type="button"\n        onClick={() => void trackedTaskService.loadBoard()}');
  const newIdx = sectionSrc.indexOf("i18nService.t('trackedTask.newTask.button')");
  assert.ok(admIdx > -1, 'admission entry button exists');
  assert.ok(refreshIdx > -1, 'refresh button exists');
  assert.ok(newIdx > -1, 'new-task button exists');
  assert.ok(admIdx < refreshIdx && refreshIdx < newIdx, 'toolbar order: admission < refresh < new task');
  // The admission button takes over the right-alignment (ml-auto); the refresh
  // button lost it when the cluster grew.
  const admBlock = sectionSrc.slice(admIdx - 600, admIdx);
  assert.match(admBlock, /ml-auto/, 'admission entry carries ml-auto');
  assert.match(sectionSrc, /QuestionMarkCircleIcon/, 'admission entry uses the question-mark icon');
  assert.match(
    sectionSrc,
    /className="btn-idchat-primary-filled px-3 py-1 text-sm font-medium"/,
    'new-task button matches the scheduled-tasks New Task styling exactly',
  );
  assert.match(
    sectionSrc,
    /new CustomEvent\('cowork:newChatWithDraft', \{\s*detail: \{ text: i18nService\.t\('trackedTask\.newTaskDraft'\) \},?\s*\}\)/,
    'the new-task button dispatches cowork:newChatWithDraft with the i18n draft text',
  );
});

test('admission modal: non-draggable root, existing admission keys plus the two new lines', () => {
  const root = modalSrc.match(/<div className="([^"]*fixed inset-0 z-\[9999\][^"]*)"/);
  assert.ok(root, 'modal fixed root found');
  assert.match(root[1], /(?:^|\s)non-draggable(?:\s|$)/, 'modal root must carry non-draggable');
  for (const key of [
    'trackedTask.admission.title',
    'trackedTask.admission.hint',
    'trackedTask.admission.activeRules',
    'trackedTask.admission.archiveNote',
    'trackedTask.admission.modeSwitchNote',
  ]) {
    assert.match(modalSrc, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `modal reuses ${key}`);
  }
  // adm1..adm5 resolve through the shared label-key table (single key source).
  assert.match(
    modalSrc,
    /TRACKED_ADMISSION_RULE_LABEL_KEYS\[rule\]/,
    'modal renders ADM-1..ADM-5 via the shared label-key table',
  );
});

test('drawer: the archive entry only appears for closed, still-admitted cards', () => {
  assert.match(
    drawerSrc,
    /detail\.state === 'closed' && detail\.admitted && onArchiveCard/,
    'archive button is gated on closed + admitted (archive view stays read-only)',
  );
  assert.match(drawerSrc, /'trackedTask\.archive\.action'/);
  assert.match(drawerSrc, /'trackedTask\.archive\.archiving'/);
});

test('archive write path: renderer service -> preload -> d.ts -> main IPC -> kv single-row override', () => {
  assert.match(
    serviceSrc,
    /async archiveCard\(input: \{ cardId: string; archived: boolean \}\)/,
    'renderer service exposes archiveCard',
  );
  assert.match(serviceSrc, /api\.archiveCard\(/, 'service calls the bridge');
  assert.match(serviceSrc, /void this\.loadBoard\(\)/, 'service refetches the whole board after archiving');

  assert.match(preloadSrc, /archiveCard: \(input: \{ cardId: string; archived: boolean \}\) =>/, 'preload bridge');
  assert.match(preloadSrc, /ipcRenderer\.invoke\('trackedTask:archiveCard', input\)/, 'preload channel');

  assert.match(dtsSrc, /TrackedCardArchiveResult/, 'd.ts mirrors the result type');
  assert.match(dtsSrc, /archiveCard: \(input: \{ cardId: string; archived: boolean \}\) => Promise<TrackedCardArchiveResult>/);

  assert.match(mainSrc, /ipcMain\.handle\('trackedTask:archiveCard'/, 'main registers the IPC handler');
  assert.match(mainSrc, /broadcastTrackedTaskUpdate\(\[input\.cardId\], 'archived'\)/, 'main broadcasts the update');

  // Main service: ONE kv row, no DDL, reversible, projection shift only.
  assert.match(boardSrc, /TRACKED_CARD_ARCHIVE_OVERRIDE_KV_KEY = 'tracked_card_archive_override'/);
  assert.match(boardSrc, /admitted = admissionVerdict\.admitted && !overrideArchived/, 'admitted := admitted AND NOT override');
  assert.match(boardSrc, /archived: false/, 'archived:false is a first-class input (reversible)');
  assert.match(boardSrc, /parseArchiveOverrides/);
  // The counts contract still partitions every card into exactly one bucket.
  assert.match(boardSrc, /admittedCards\.length/, 'admitted count from the partition');
  assert.match(boardSrc, /archivedCards\.length/, 'archived count from the partition');

  assert.match(typesSrc, /export interface TrackedCardArchiveResult/, 'renderer type mirror exists');
});

test('App.tsx: cowork:newChatWithDraft routes the draft text through focus-input after the clear logic', () => {
  assert.match(
    appSrc,
    /window\.addEventListener\('cowork:newChatWithDraft', handler\)/,
    'App listens for the new-chat-with-draft event',
  );
  assert.match(
    appSrc,
    /handleNewChat\(undefined, text\)/,
    'the handler forwards the text as the draft',
  );
  assert.match(
    appSrc,
    /detail: \{ clear: shouldClearInput, text: draftText \}/,
    'focus-input detail carries the draft text',
  );
  // Order: the event is dispatched from the setTimeout AFTER clearSession/clearSelection.
  const clearIdx = appSrc.indexOf('coworkService.clearSession()');
  const dispatchIdx = appSrc.indexOf("'cowork:focus-input'");
  assert.ok(clearIdx > -1 && dispatchIdx > clearIdx, 'draft text is applied after the clear logic');
});

test('CoworkPromptInput: focus-input applies detail.text via the versioned draft field, then focuses', () => {
  assert.match(
    composerSrc,
    /const text = \(event as CustomEvent<\{ text\?: unknown \}>\)\.detail\?\.text;/,
    'handleFocusInput reads detail.text',
  );
  assert.match(
    composerSrc,
    /draftFieldRef\.current\?\.set\(text\)/,
    'the draft is written through the versioned field (lands in setDraftPrompt)',
  );
  const setIdx = composerSrc.indexOf('draftFieldRef.current?.set(text)');
  const focusIdx = composerSrc.indexOf('textareaRef.current?.focus();', setIdx);
  assert.ok(focusIdx > setIdx, 'the text is applied before the focus call inside the same rAF');
  assert.match(
    composerSrc,
    /textarea\.setSelectionRange\(end, end\)/,
    'the caret lands at the end of the prefilled draft',
  );
});

test('i18n: every new key exists in BOTH dictionaries', () => {
  const zhStart = i18nSrc.indexOf('  zh: {');
  const enStart = i18nSrc.indexOf('  en: {');
  const zhBlock = i18nSrc.slice(zhStart, enStart);
  const enBlock = i18nSrc.slice(enStart);
  const newKeys = [
    'trackedTask.admission.entry',
    'trackedTask.admission.archiveNote',
    'trackedTask.admission.modeSwitchNote',
    'trackedTask.newTask.button',
    'trackedTask.newTaskDraft',
    'trackedTask.archive.action',
    'trackedTask.archive.archiving',
    'trackedTask.archive.successToast',
    'trackedTask.drawer.expand',
    'trackedTask.drawer.collapse',
    'trackedTask.uriKind.metaapp',
    'trackedTask.uriKind.metafile',
    'trackedTask.uriKind.pin',
    'trackedTask.uriKind.url',
    'trackedTask.uriKind.other',
  ];
  for (const key of newKeys) {
    assert.match(zhBlock, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `zh missing ${key}`);
    assert.match(enBlock, new RegExp(`'${key.replace(/\./g, '\\.')}'`), `en missing ${key}`);
  }
  // The en draft is the equivalent sentence, not a copy of the zh text.
  const enDraftLine = enBlock.split('\n').find((line) => line.includes("'trackedTask.newTaskDraft'"));
  assert.ok(enDraftLine, 'en draft line exists');
  assert.ok(!/[\u4e00-\u9fff]/.test(enDraftLine), 'en draft text carries no Chinese');
  assert.match(enDraftLine, /long-running task/, 'en draft keeps the intent');
});
