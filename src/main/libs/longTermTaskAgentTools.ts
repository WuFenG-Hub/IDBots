import { z } from 'zod';
import type { LongTermTaskStore } from '../longTermTaskStore';
import { buildDelegationAnchorBlock } from './longTermDelegationAnchor';

/**
 * Long-term task tools — the TwinBot's first-class surface for the redesigned
 * long-term task board (docs/design/long-term-task-redesign-plan.md).
 *
 * Every tool delegates straight to LongTermTaskStore, so derivation and the
 * event journal live in exactly one place. The tools are the Twin's channel
 * (`actor: 'twin'` is fixed here — the model can never impersonate the owner);
 * the owner's channel is the board UI (IPC with `actor: 'owner'`).
 *
 * Discipline the tool descriptions encode (the creation skill owns the rest):
 *  - create stays a DRAFT until the owner explicitly confirms → activate.
 *  - acceptance is owner-only unless the task's delegate switch is on.
 *  - every write lands in the task's event journal (restart-proof memory).
 */

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function jsonResult(value: unknown) {
  return textResult(JSON.stringify(value, null, 2));
}

export interface LongTermTaskAgentControl {
  store: () => LongTermTaskStore;
  /** Owner's UI language ('zh' | 'en') — delegation anchors follow it. */
  getAppLanguage?: () => string;
}

const CHANNEL_ENUM = ['delegate_bot', 'group_task', 'owner_external', 'owner_together'] as const;

const subtaskDraftSchema = z.object({
  title: z.string().min(1).describe('Sub-project title (short, verifiable).'),
  description: z.string().optional().describe('What this sub-project means and its boundaries.'),
  acceptanceCriteria: z.array(z.string()).optional().describe('Checkable acceptance criteria, one per line.'),
  dependsOnOrdinals: z.array(z.number()).optional().describe('1-based ordinals of sub-projects that must be accepted first.'),
  preferredChannel: z.enum(CHANNEL_ENUM).optional().describe('delegate_bot | group_task | owner_external | owner_together.'),
  notes: z.string().optional(),
});

export function buildLongTermTaskAgentTools(deps: { tool: SdkToolFactory; control: LongTermTaskAgentControl }): unknown[] {
  const { tool, control } = deps;
  const store = () => control.store();

  const createTask = tool(
    'longterm_task_create',
    'Create a long-term task DRAFT after you and the owner have aligned on it (grilling-style Q&A: the goal was fuzzy, you asked until the boundary, sub-project split and acceptance criteria were explicit). A long-term task is for work that spans days/weeks with blocking points — never for something finishable in one session (that is a normal cowork turn) or a multi-bot short job (that is a group task). The draft is NOT active yet: present the split in chat and only call longterm_task_activate after the owner confirms in prose.',
    {
      title: z.string().min(1).describe('Task title (short).'),
      goal: z.string().min(1).describe('The full goal statement, including the done-ness definition of the whole task.'),
      subtasks: z.array(subtaskDraftSchema).min(1).describe('Ordered sub-projects. Order should respect dependencies.'),
      definitionSessionId: z.string().optional().describe('The session where the definition was discussed (for traceability).'),
    },
    async (args: { title?: string; goal?: string; subtasks?: unknown[]; definitionSessionId?: string }) => {
      try {
        const result = store().createTask(
          {
            title: String(args.title ?? ''),
            goal: String(args.goal ?? ''),
            subtasks: (args.subtasks ?? []) as never[],
            definitionSessionId: args.definitionSessionId ?? null,
          },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to create the long-term task: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const activateTask = tool(
    'longterm_task_activate',
    'Activate a draft long-term task after the OWNER confirmed the sub-project split and acceptance criteria in prose. Never activate on your own initiative — activation is the owner\'s sign-off.',
    { taskId: z.string().min(1) },
    async (args: { taskId?: string }) => {
      try {
        const result = store().activateTask(String(args.taskId ?? ''), 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to activate: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const listTasks = tool(
    'longterm_task_list',
    'List every long-term task on the board (defining / active / waiting / paused / done) with column, progress (accepted/total) and the current sub-project. Read-only. Use this at session start to recall what is in flight.',
    {},
    async () => {
      try {
        return jsonResult(store().listBoard());
      } catch (error) {
        return textResult(`Failed to list: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const getTask = tool(
    'longterm_task_get',
    'Get one long-term task\'s full state brief: goal, stage, progress, the current sub-project with its acceptance criteria and evidence, all sub-projects, and the recent event journal (why it is where it is). Read-only. Call this before pushing any task forward so you never lose the thread across sessions.',
    { taskId: z.string().min(1) },
    async (args: { taskId?: string }) => {
      try {
        const detail = store().getTask(String(args.taskId ?? ''));
        if (!detail) return textResult('Task not found.', true);
        return jsonResult(detail);
      } catch (error) {
        return textResult(`Failed to read: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const updateTask = tool(
    'longterm_task_update',
    'Update a long-term task\'s title/goal, toggle the acceptance-delegate switch (only when the owner explicitly granted it in chat), or pause/resume/cancel the task. Every change is journalled as a replan.',
    {
      taskId: z.string().min(1),
      title: z.string().optional(),
      goal: z.string().optional(),
      acceptanceDelegate: z.boolean().optional().describe('Owner granted TwinBot acceptance authority for THIS task.'),
      action: z.enum(['pause', 'resume', 'cancel']).optional(),
      note: z.string().optional().describe('Reason for pause/cancel.'),
    },
    async (args: { taskId?: string; title?: string; goal?: string; acceptanceDelegate?: boolean; action?: 'pause' | 'resume' | 'cancel'; note?: string }) => {
      try {
        const taskId = String(args.taskId ?? '');
        if (args.action === 'pause') return jsonResult(store().pauseTask(taskId, 'twin', args.note ?? ''));
        if (args.action === 'resume') return jsonResult(store().activateTask(taskId, 'twin'));
        if (args.action === 'cancel') return jsonResult(store().cancelTask(taskId, 'twin', args.note ?? ''));
        const result = store().updateTask(
          { taskId, title: args.title, goal: args.goal, acceptanceDelegate: args.acceptanceDelegate },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to update: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const addSubtask = tool(
    'longterm_subtask_add',
    'Add a sub-project to an existing task (requirements grow). Journalled as a replan.',
    {
      taskId: z.string().min(1),
      title: z.string().min(1),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      dependsOnOrdinals: z.array(z.number()).optional(),
      preferredChannel: z.enum(CHANNEL_ENUM).optional(),
      notes: z.string().optional(),
    },
    async (args: { taskId?: string; title?: string } & Record<string, unknown>) => {
      try {
        const result = store().addSubtask(String(args.taskId ?? ''), args as never, 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to add: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const updateSubtask = tool(
    'longterm_subtask_update',
    'Redefine an open sub-project: title, description, acceptance criteria, dependencies (by sub-project id), preferred channel, notes, order. Use when the owner corrects the definition mid-flight — the change is journalled so the correction is auditable.',
    {
      subtaskId: z.string().min(1),
      title: z.string().optional(),
      description: z.string().optional(),
      acceptanceCriteria: z.array(z.string()).optional(),
      dependsOn: z.array(z.string()).optional().describe('Sibling sub-project ids that must be accepted first.'),
      preferredChannel: z.enum(CHANNEL_ENUM).nullable().optional(),
      notes: z.string().optional(),
      ordinal: z.number().optional(),
    },
    async (args: { subtaskId?: string } & Record<string, unknown>) => {
      try {
        const result = store().updateSubtask(args as never, 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to update: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const beginSubtask = tool(
    'longterm_subtask_begin',
    'Start pushing a sub-project (pins it as the board focus). Refused while its dependencies are not yet accepted. Pick the execution channel you and the owner agreed on.',
    {
      subtaskId: z.string().min(1),
      channel: z.enum(CHANNEL_ENUM).optional(),
    },
    async (args: { subtaskId?: string; channel?: string }) => {
      try {
        const result = store().beginSubtask(String(args.subtaskId ?? ''), 'twin', (args.channel as never) ?? null);
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to begin: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const waitSubtask = tool(
    'longterm_subtask_wait',
    'Park the current sub-project on a blocking point: kind=owner when you need the owner to decide something (say exactly WHAT in the note), kind=external when waiting on an outside condition (notarization, external delivery, a date). The heartbeat re-checks time-based waits and the card shows the note.',
    {
      subtaskId: z.string().min(1),
      kind: z.enum(['owner', 'external']),
      note: z.string().min(1).describe('Precisely what is being waited on.'),
      waitUntil: z.string().optional().describe('ISO datetime for time-based re-checks (e.g. an expected delivery date).'),
    },
    async (args: { subtaskId?: string; kind?: 'owner' | 'external'; note?: string; waitUntil?: string }) => {
      try {
        const result = store().waitSubtask(
          String(args.subtaskId ?? ''),
          { kind: args.kind === 'external' ? 'external' : 'owner', note: String(args.note ?? ''), waitUntil: args.waitUntil ?? null },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to wait: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const unblockSubtask = tool(
    'longterm_subtask_unblock',
    'Resume a waiting sub-project (owner answered / external condition resolved).',
    { subtaskId: z.string().min(1), note: z.string().optional() },
    async (args: { subtaskId?: string; note?: string }) => {
      try {
        const result = store().unblockSubtask(String(args.subtaskId ?? ''), 'twin', args.note ?? '');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to unblock: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const proposeSubtask = tool(
    'longterm_subtask_propose',
    'Propose acceptance for a sub-project: attach verifiable evidence (local dir, metaapp:// URI, pin:// id, URL) and a summary of how each acceptance criterion is met. Moves the card to waiting-owner; the owner accepts or rejects with feedback.',
    {
      subtaskId: z.string().min(1),
      evidence: z.array(z.object({ kind: z.string(), uri: z.string().min(1), note: z.string().optional() })).min(1),
      summary: z.string().min(1),
    },
    async (args: { subtaskId?: string; evidence?: unknown[]; summary?: string }) => {
      try {
        const result = store().proposeSubtask(
          String(args.subtaskId ?? ''),
          { evidence: (args.evidence ?? []) as never[], summary: String(args.summary ?? '') },
          'twin',
        );
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to propose: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const acceptSubtask = tool(
    'longterm_subtask_accept',
    'Accept a sub-project as the Twin — ONLY when the task\'s acceptance-delegate switch is on (the owner granted it explicitly) AND you verified every acceptance criterion against the evidence. Otherwise ask the owner to accept. When the last open sub-project is accepted the whole task completes.',
    { subtaskId: z.string().min(1), note: z.string().optional() },
    async (args: { subtaskId?: string; note?: string }) => {
      try {
        const result = store().acceptSubtask(String(args.subtaskId ?? ''), 'twin', args.note ?? '');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to accept: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const rejectSubtask = tool(
    'longterm_subtask_reject',
    'Bounce your own acceptance proposal back to in-progress when you discover the evidence does not actually meet the criteria. Carries a reason.',
    { subtaskId: z.string().min(1), feedback: z.string().min(1) },
    async (args: { subtaskId?: string; feedback?: string }) => {
      try {
        const result = store().rejectSubtask(String(args.subtaskId ?? ''), 'twin', String(args.feedback ?? ''));
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return jsonResult(result.value);
      } catch (error) {
        return textResult(`Failed to reject: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const addNote = tool(
    'longterm_event_note',
    'Journal a note on a task (or one sub-project): decisions made in chat, context worth surviving a restart, why something is where it is. Cheap and append-only — prefer one precise note over re-explaining later.',
    { taskId: z.string().min(1), subtaskId: z.string().optional(), text: z.string().min(1) },
    async (args: { taskId?: string; subtaskId?: string; text?: string }) => {
      try {
        const result = store().addNote(String(args.taskId ?? ''), args.subtaskId ?? null, String(args.text ?? ''), 'twin');
        if (!result.ok) return textResult(`Refused (${result.code}): ${result.error}`, true);
        return textResult('Noted.');
      } catch (error) {
        return textResult(`Failed to note: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  const delegationAnchor = tool(
    'longterm_delegation_anchor',
    'Build the context anchor block for a delegation brief. REQUIRED whenever you delegate any slice of a long-term sub-project to a worker bot or a group task: paste the returned block into the delegation objective verbatim. It carries the task/sub-project ids, the goal, the acceptance criteria, recent journal events, and the worker\'s duties (read longterm_task_get first, never invent infrastructure, journal key findings back). A delegation without this anchor is a lossy relay — the worker would build the plausible thing instead of the right thing.',
    {
      taskId: z.string().min(1),
      subtaskId: z.string().min(1),
    },
    async (args: { taskId?: string; subtaskId?: string }) => {
      try {
        const detail = store().getTask(String(args.taskId ?? ''));
        if (!detail) return textResult('Task not found.', true);
        const subtask = detail.subtasks.find((sub) => sub.id === String(args.subtaskId ?? ''));
        if (!subtask) return textResult('Sub-project not found in this task.', true);
        return textResult(buildDelegationAnchorBlock(detail, subtask, control.getAppLanguage?.() === 'zh' ? 'zh' : 'en'));
      } catch (error) {
        return textResult(`Failed to build the delegation anchor: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    },
  );

  return [
    createTask,
    activateTask,
    listTasks,
    getTask,
    updateTask,
    addSubtask,
    updateSubtask,
    beginSubtask,
    waitSubtask,
    unblockSubtask,
    proposeSubtask,
    acceptSubtask,
    rejectSubtask,
    addNote,
    delegationAnchor,
  ];
}
