import type { CoworkMessage } from '../../types/cowork';

/**
 * Pure task/todo list state machine for Claude Agent SDK sessions.
 *
 * The SDK maintains the working task list through tool calls in the message
 * stream (there is no dedicated "todo panel" message type):
 *
 * - `TodoWrite`      (legacy / CLI mode): full-list replacement. Input carries
 *                    `todos: [{ content, status, activeForm }]`.
 * - `TaskCreate`     (headless/SDK mode, 0.3.142+): creates ONE task per call.
 *                    Input carries top-level `subject` / `description` /
 *                    `activeForm`; the new task id is returned in the
 *                    tool_result payload.
 * - `TaskUpdate`     updates one existing task by `id` (status, activeForm,
 *                    subject, description, owner, ...).
 * - `TaskGet`/`TaskList` are read-only; their results are not required to
 *                    reconstruct state because create/update calls stay in the
 *                    message history.
 *
 * The state is derived deterministically from the session message list, so it
 * works identically for live streaming and reloaded history — no extra
 * persistence is needed.
 */

export type TodoStatus = 'completed' | 'in_progress' | 'pending' | 'unknown';

export type TodoItemSource = 'todowrite' | 'taskcreate' | 'taskupdate' | 'tasklist';

export interface TodoListItem {
  /** Stable identity used for React keys and cross-call matching. */
  key: string;
  /** SDK task id when known (TaskUpdate input or TaskCreate result). */
  id: string | null;
  /** The tool_use id that created this item (for result pairing). */
  toolUseId: string | null;
  /** Primary display text: activeForm when in_progress, else subject/content. */
  primaryText: string;
  /** Secondary detail: description / content when it differs from primary. */
  secondaryText: string | null;
  status: TodoStatus;
  owner: string | null;
  source: TodoItemSource;
}

export interface TodoListState {
  items: TodoListItem[];
}

export const EMPTY_TODO_STATE: TodoListState = { items: [] };

const normalizeToolName = (value: string): string =>
  value.toLowerCase().replace(/[\s_]+/g, '');

export const isTodoWriteToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'todowrite';
};

export const isTaskCreateToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'taskcreate';
};

export const isTaskUpdateToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  return normalizeToolName(toolName) === 'taskupdate';
};

export const isTaskListToolName = (toolName: string | undefined): boolean => {
  if (!toolName) return false;
  const normalized = normalizeToolName(toolName);
  return normalized === 'taskcreate'
    || normalized === 'taskupdate'
    || normalized === 'tasklist'
    || normalized === 'taskget';
};

export const isTodoRelatedToolName = (toolName: string | undefined): boolean =>
  isTodoWriteToolName(toolName) || isTaskListToolName(toolName);

const toTrimmedString = (value: unknown): string | null =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export const normalizeTodoStatus = (value: unknown): TodoStatus => {
  const normalized = typeof value === 'string'
    ? value.trim().toLowerCase().replace(/-/g, '_')
    : '';

  if (normalized === 'completed') return 'completed';
  if (normalized === 'in_progress' || normalized === 'running') return 'in_progress';
  if (normalized === 'pending' || normalized === 'todo') return 'pending';
  return 'unknown';
};

const readString = (record: Record<string, unknown>, ...keys: string[]): string | null => {
  for (const key of keys) {
    const value = toTrimmedString(record[key]);
    if (value) return value;
  }
  return null;
};

const readId = (record: Record<string, unknown>): string | null =>
  readString(record, 'id', 'taskId', 'task_id');

/** Legacy TodoWrite input: `{ todos: [{ content, status, activeForm }] }`. */
export const parseTodoWriteItems = (input: unknown): TodoListItem[] | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  if (!Array.isArray(record.todos)) return null;

  const items = record.todos
    .map((rawTodo, index): TodoListItem | null => {
      if (!rawTodo || typeof rawTodo !== 'object') return null;
      const todo = rawTodo as Record<string, unknown>;
      const activeForm = readString(todo, 'activeForm');
      const content = readString(todo, 'content');
      const primaryText = activeForm ?? content ?? 'Untitled todo';
      const secondaryText = content && content !== primaryText ? content : null;
      return {
        key: `todo-${index}`,
        id: readId(todo),
        toolUseId: null,
        primaryText,
        secondaryText,
        status: normalizeTodoStatus(todo.status),
        owner: readString(todo, 'owner'),
        source: 'todowrite',
      };
    })
    .filter((item): item is TodoListItem => item !== null);

  return items.length > 0 ? items : null;
};

/**
 * Legacy TaskCreate/TaskUpdate input shape (pre-0.3.142): a full `tasks`
 * array. Kept for compatibility with older transcripts.
 */
export const parseLegacyTaskListItems = (input: unknown): TodoListItem[] | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const rawTasks = Array.isArray(record.tasks) ? record.tasks : null;
  if (!rawTasks) return null;

  const items = rawTasks
    .map((rawTask, index): TodoListItem | null => {
      if (!rawTask || typeof rawTask !== 'object') return null;
      const task = rawTask as Record<string, unknown>;
      const activeForm = readString(task, 'activeForm');
      const content = readString(task, 'content', 'subject', 'description');
      const primaryText = activeForm ?? content ?? 'Untitled todo';
      const secondaryText = content && content !== primaryText ? content : null;
      return {
        key: readId(task) ?? `task-${index}`,
        id: readId(task),
        toolUseId: null,
        primaryText,
        secondaryText,
        status: normalizeTodoStatus(task.status),
        owner: readString(task, 'owner'),
        source: 'tasklist',
      };
    })
    .filter((item): item is TodoListItem => item !== null);

  return items.length > 0 ? items : null;
};

/**
 * Current SDK (0.3.142+) TaskCreate input: one task per call with top-level
 * `subject` / `description` / optional `activeForm`. New tasks are `pending`.
 */
export const parseTaskCreateItem = (input: unknown): TodoListItem | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const subject = readString(record, 'subject');
  const description = readString(record, 'description');
  const activeForm = readString(record, 'activeForm');
  if (!subject && !description && !activeForm) return null;

  const primaryText = activeForm ?? subject ?? description ?? 'Untitled todo';
  const secondaryText = description && description !== primaryText ? description : null;
  const id = readId(record);

  return {
    key: id ?? 'task-pending', // caller fixes the key with the toolUseId when id is absent
    id,
    toolUseId: null,
    primaryText,
    secondaryText,
    status: normalizeTodoStatus(record.status ?? 'pending'),
    owner: readString(record, 'owner'),
    source: 'taskcreate',
  };
};

export interface TaskUpdatePatch {
  id: string | null;
  primaryText?: string;
  secondaryText?: string | null;
  status?: TodoStatus;
  owner?: string | null;
}

/** Current SDK TaskUpdate input: `{ id, subject?, description?, activeForm?, status?, owner? }`. */
export const parseTaskUpdatePatch = (input: unknown): TaskUpdatePatch | null => {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const id = readId(record);
  if (!id) return null;

  const subject = readString(record, 'subject');
  const description = readString(record, 'description');
  const activeForm = readString(record, 'activeForm');
  const status = record.status !== undefined ? normalizeTodoStatus(record.status) : undefined;
  const owner = record.owner !== undefined ? readString(record, 'owner') : undefined;

  if (!subject && !description && !activeForm && status === undefined && owner === undefined) {
    return null;
  }

  let primaryText: string | undefined;
  let secondaryText: string | null | undefined;
  if (subject || description || activeForm) {
    primaryText = activeForm ?? subject ?? description ?? undefined;
    secondaryText = description && description !== primaryText ? description : null;
  }

  return {
    id,
    primaryText,
    secondaryText,
    status,
    owner,
  };
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Best-effort extraction of a task id from a TaskCreate tool_result. The SDK
 * returns the new task id in the result payload; shape varies by version
 * (`{ id }`, `{ taskId }`, `{ task: { id } }`, ...).
 */
export const extractTaskIdFromResult = (content: string): string | null => {
  if (!content || !content.trim()) return null;

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Not JSON — try to find `id`/`taskId` in plain text.
    const match = content.match(/(?:taskId|task_id|"id")\s*[:=]\s*"?([A-Za-z0-9_.-]+)"?/i);
    return match ? match[1] : null;
  }

  const candidates: unknown[] = [parsed];
  if (isPlainObject(parsed)) {
    if (isPlainObject(parsed.task)) candidates.push(parsed.task);
    if (isPlainObject(parsed.data)) candidates.push(parsed.data);
  }

  for (const candidate of candidates) {
    if (!isPlainObject(candidate)) continue;
    const id = readString(candidate, 'id', 'taskId', 'task_id');
    if (id) return id;
  }
  return null;
};

const applyTodoWrite = (input: unknown): TodoListState => {
  const items = parseTodoWriteItems(input);
  return items ? { items } : EMPTY_TODO_STATE;
};

const applyTaskCreate = (state: TodoListState, input: unknown, toolUseId: string | null): TodoListState => {
  const item = parseTaskCreateItem(input);
  if (!item) return state;

  const key = item.id ?? toolUseId ?? `task-${state.items.length}`;
  const nextItem: TodoListItem = { ...item, key, toolUseId };

  // Upsert by id when known; otherwise append (a TaskCreate always adds a task).
  if (item.id) {
    const existingIndex = state.items.findIndex((existing) => existing.id === item.id);
    if (existingIndex >= 0) {
      const items = [...state.items];
      items[existingIndex] = nextItem;
      return { items };
    }
  }
  return { items: [...state.items, nextItem] };
};

const applyTaskUpdate = (state: TodoListState, input: unknown): TodoListState => {
  const patch = parseTaskUpdatePatch(input);
  if (!patch) return state;

  const index = state.items.findIndex((item) => item.id === patch.id);
  if (index < 0) return state;

  const item = state.items[index];
  const items = [...state.items];
  items[index] = {
    ...item,
    ...(patch.primaryText !== undefined ? { primaryText: patch.primaryText } : {}),
    ...(patch.secondaryText !== undefined ? { secondaryText: patch.secondaryText } : {}),
    ...(patch.status !== undefined ? { status: patch.status } : {}),
    ...(patch.owner !== undefined ? { owner: patch.owner } : {}),
  };
  return { items };
};

const applyTaskCreateResult = (state: TodoListState, toolUseId: string | null, content: string): TodoListState => {
  if (!toolUseId) return state;
  const id = extractTaskIdFromResult(content);
  if (!id) return state;

  const index = state.items.findIndex((item) => item.toolUseId === toolUseId);
  if (index < 0) return state;

  const items = [...state.items];
  items[index] = { ...items[index], id, key: id };
  return { items };
};

export const applyTodoMessage = (state: TodoListState, message: CoworkMessage): TodoListState => {
  if (message.type !== 'tool_use') return state;

  const toolName = typeof message.metadata?.toolName === 'string'
    ? message.metadata.toolName
    : '';
  const toolInput = message.metadata?.toolInput;
  const toolUseId = typeof message.metadata?.toolUseId === 'string'
    ? message.metadata.toolUseId
    : null;

  if (isTodoWriteToolName(toolName)) {
    return applyTodoWrite(toolInput);
  }
  if (isTaskCreateToolName(toolName)) {
    return applyTaskCreate(state, toolInput, toolUseId);
  }
  if (isTaskUpdateToolName(toolName)) {
    return applyTaskUpdate(state, toolInput);
  }
  return state;
};

/**
 * Derive the session's current task list by replaying every todo-related tool
 * call in message order. Deterministic for live and reloaded sessions.
 */
export const buildSessionTodoList = (messages: CoworkMessage[]): TodoListItem[] => {
  // Track the tool name that produced each tool_use id so tool_results can be
  // paired without depending on renderer-only metadata.
  const toolNameByUseId = new Map<string, string>();
  let state = EMPTY_TODO_STATE;

  for (const message of messages) {
    if (message.type === 'tool_use') {
      const toolName = typeof message.metadata?.toolName === 'string'
        ? message.metadata.toolName
        : '';
      if (isTodoRelatedToolName(toolName)) {
        const toolUseId = typeof message.metadata?.toolUseId === 'string'
          ? message.metadata.toolUseId
          : null;
        if (toolUseId) toolNameByUseId.set(toolUseId, toolName);
        state = applyTodoMessage(state, message);
      }
      continue;
    }

    if (message.type === 'tool_result') {
      const toolUseId = typeof message.metadata?.toolUseId === 'string'
        ? message.metadata.toolUseId
        : null;
      const toolName = toolUseId ? toolNameByUseId.get(toolUseId) : undefined;
      if (toolUseId && isTaskCreateToolName(toolName)) {
        state = applyTaskCreateResult(state, toolUseId, message.content ?? '');
      }
    }
  }

  return state.items;
};

export interface TodoSummary {
  total: number;
  completed: number;
  inProgress: number;
  pending: number;
}

export const getTodoSummary = (items: TodoListItem[]): TodoSummary => {
  const completed = items.filter((item) => item.status === 'completed').length;
  const inProgress = items.filter((item) => item.status === 'in_progress').length;
  return {
    total: items.length,
    completed,
    inProgress,
    pending: items.length - completed - inProgress,
  };
};

export const getTodoListSummaryText = (
  items: TodoListItem[],
  labels: { items: string; completed: string; inProgress: string; pending: string }
): string => {
  const summary = getTodoSummary(items);
  const parts = [
    `${summary.total} ${labels.items}`,
    `${summary.completed} ${labels.completed}`,
    `${summary.inProgress} ${labels.inProgress}`,
    `${summary.pending} ${labels.pending}`,
  ];
  const activeItem = items.find((item) => item.status === 'in_progress');
  if (activeItem) parts.push(activeItem.primaryText);
  return parts.join(' · ');
};
