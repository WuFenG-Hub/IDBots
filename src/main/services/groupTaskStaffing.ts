/**
 * Group-task staffing: decompose → coarse seats → one bot per seat →
 * owner-confirm (unless the wish said "just start") → create.
 *
 * Research is a basic capability of every seat, not a seat of its own.
 * Match-first; local is a tie-break, not a gate.
 */

export const GROUP_TASK_SEAT_ROLES = [
  'content',
  'design',
  'engineering',
  'promotion',
  'domain',
] as const;

export type GroupTaskSeatRole = (typeof GROUP_TASK_SEAT_ROLES)[number];

export const GROUP_TASK_TYPICAL_TEAM_SIZE = 5;
export const GROUP_TASK_HARD_TEAM_SIZE = 8;

export type GroupTaskStaffingProposalStatus =
  | 'pending'
  | 'confirmed'
  | 'skip_authorized'
  | 'consumed'
  | 'cancelled';

export type GroupTaskStaffingOwnerDecision =
  | 'skip_authorized'
  | 'owner_confirmed'
  | 'owner_revise'
  | 'awaiting_owner';

export interface GroupTaskStaffingStage {
  id: string;
  title: string;
  seatRole: GroupTaskSeatRole;
  dependsOn: string[];
}

export interface GroupTaskStaffingSeat {
  role: GroupTaskSeatRole;
  /** Required when role is `domain` (e.g. "legal"). */
  domainLabel?: string;
  candidateName: string;
  candidateGlobalMetaId?: string;
  metabotId?: number;
  source: 'local' | 'remote';
  reason: string;
  backupName?: string;
}

export interface GroupTaskStaffingPlan {
  stages: GroupTaskStaffingStage[];
  seats: GroupTaskStaffingSeat[];
}

export interface GroupTaskStaffingProposal {
  id: number;
  sourceSessionId: string;
  twinMetabotId: number;
  title: string;
  goal: string;
  acceptanceCriteria: string | null;
  plan: GroupTaskStaffingPlan;
  status: GroupTaskStaffingProposalStatus;
  skipAuthorized: boolean;
  ownerDecision: string | null;
  createdTaskId: number | null;
  createdAt: number;
  confirmedAt: number | null;
}

export interface StaffingSessionMessage {
  type: string;
  content: string;
  timestamp: number;
}

export interface StaffingPlanValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
  teamSize: number;
}

export class GroupTaskStaffingError extends Error {
  readonly code:
    | 'STAFFING_PLAN_INVALID'
    | 'OWNER_CONFIRM_REQUIRED'
    | 'OWNER_REVISE_REQUIRED'
    | 'PROPOSAL_NOT_FOUND'
    | 'PROPOSAL_NOT_USABLE'
    | 'ROSTER_CAP_EXCEEDED'
    | 'SOURCE_SESSION_REQUIRED';

  constructor(
    code: GroupTaskStaffingError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'GroupTaskStaffingError';
    this.code = code;
  }
}

const SKIP_CONFIRM_PATTERNS: RegExp[] = [
  /不用确认/,
  /不必确认/,
  /不需要确认/,
  /无需确认/,
  /不用问我/,
  /不用等人选/,
  /跳过确认/,
  /直接开(群|始|吧|任务)?/,
  /自行决定(人选)?/,
  /no need to confirm/i,
  /skip confirmation/i,
  /without confirmation/i,
  /don't ask me/i,
  /do not ask me/i,
  /just start/i,
  /start directly/i,
  /proceed without confirmation/i,
];

const REVISE_PATTERNS: RegExp[] = [
  /换人/,
  /换成/,
  /换一个/,
  /去掉/,
  /不要\s*\S+/,
  /再找/,
  /换掉/,
  /\breplace\b/i,
  /\bswap\b/i,
  /\bremove\b/i,
  /\bdrop\b/i,
  /\binstead\b/i,
];

const CONFIRM_EXACT_PATTERNS: RegExp[] = [
  /^(确认|就这样|就这样开|可以开|开吧|开始吧|同意|没问题|好的|好|行|嗯)[。.!！]*$/u,
  /^(ok|okay|yes|yep|go|go ahead|looks good|lgtm|proceed|confirmed?|start)[.!]*$/i,
];

const CONFIRM_PHRASE_PATTERNS: RegExp[] = [
  /确认人选/,
  /按这个(名单|人选|班子)/,
  /就这些人/,
  /就这样开/,
  /可以开(群|了|吧)?/,
  /confirmed the (roster|slate|team)/i,
  /looks good,? (start|go|proceed)/i,
];

function isSeatRole(value: unknown): value is GroupTaskSeatRole {
  return typeof value === 'string' && (GROUP_TASK_SEAT_ROLES as readonly string[]).includes(value);
}

function trimText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStaffingPlan(raw: unknown): GroupTaskStaffingPlan {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const stagesRaw = Array.isArray(record.stages) ? record.stages : [];
  const seatsRaw = Array.isArray(record.seats) ? record.seats : [];
  const stages: GroupTaskStaffingStage[] = stagesRaw.map((item, index) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const role = isSeatRole(row.seatRole) ? row.seatRole : 'content';
    const dependsOn = Array.isArray(row.dependsOn)
      ? row.dependsOn.map((dep) => String(dep ?? '').trim()).filter(Boolean)
      : [];
    return {
      id: trimText(row.id) || `stage-${index + 1}`,
      title: trimText(row.title) || `Stage ${index + 1}`,
      seatRole: role,
      dependsOn,
    };
  });
  const seats: GroupTaskStaffingSeat[] = seatsRaw.map((item) => {
    const row = item && typeof item === 'object' ? item as Record<string, unknown> : {};
    const metabotId = Number(row.metabotId);
    return {
      role: isSeatRole(row.role) ? row.role : 'content',
      domainLabel: trimText(row.domainLabel) || undefined,
      candidateName: trimText(row.candidateName) || trimText(row.name),
      candidateGlobalMetaId: trimText(row.candidateGlobalMetaId) || trimText(row.globalmetaid) || undefined,
      metabotId: Number.isInteger(metabotId) && metabotId > 0 ? metabotId : undefined,
      source: row.source === 'remote' ? 'remote' : 'local',
      reason: trimText(row.reason),
      backupName: trimText(row.backupName) || undefined,
    };
  });
  return { stages, seats };
}

function seatKey(seat: GroupTaskStaffingSeat): string {
  if (seat.role === 'domain') {
    return `domain:${(seat.domainLabel || 'unspecified').trim().toLowerCase()}`;
  }
  return seat.role;
}

export function validateStaffingPlan(plan: GroupTaskStaffingPlan): StaffingPlanValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const [index, seat] of plan.seats.entries()) {
    if (!isSeatRole(seat.role)) {
      errors.push(`seats[${index}].role is not a coarse seat`);
      continue;
    }
    if (seat.role === 'domain' && !seat.domainLabel) {
      errors.push(`seats[${index}] domain seat needs domainLabel (e.g. legal)`);
    }
    if (!seat.candidateName) {
      errors.push(`seats[${index}] needs candidateName`);
    }
    if (seat.source === 'remote' && !seat.candidateGlobalMetaId) {
      errors.push(`seats[${index}] remote seat needs candidateGlobalMetaId`);
    }
    const key = seatKey(seat);
    if (seen.has(key)) {
      errors.push(`duplicate seat ${key}: one bot per coarse role`);
    }
    seen.add(key);
  }
  const teamSize = plan.seats.length + 1;
  if (teamSize > GROUP_TASK_HARD_TEAM_SIZE) {
    errors.push(
      `team size ${teamSize} exceeds the hard cap of ${GROUP_TASK_HARD_TEAM_SIZE} (including the Twin chair)`,
    );
  }
  if (teamSize > GROUP_TASK_TYPICAL_TEAM_SIZE) {
    warnings.push(
      `team size ${teamSize} is above the typical cap of ${GROUP_TASK_TYPICAL_TEAM_SIZE}; keep this only when the owner asked for the extra seat`,
    );
  }
  if (plan.stages.some((stage) => stage.title.toLowerCase().includes('research') && stage.seatRole === 'content' && plan.stages.some((other) => other !== stage && other.seatRole === 'content'))) {
    warnings.push('research is a basic capability of every seat — do not split it from content');
  }
  return { ok: errors.length === 0, errors, warnings, teamSize };
}

export function detectSkipConfirmInWish(text: string): boolean {
  const value = String(text ?? '');
  return SKIP_CONFIRM_PATTERNS.some((pattern) => pattern.test(value));
}

export function classifyOwnerStaffingReply(text: string): 'confirm' | 'revise' | 'unknown' {
  const value = String(text ?? '').trim();
  if (!value) return 'unknown';
  if (REVISE_PATTERNS.some((pattern) => pattern.test(value))) return 'revise';
  if (CONFIRM_EXACT_PATTERNS.some((pattern) => pattern.test(value))) return 'confirm';
  if (CONFIRM_PHRASE_PATTERNS.some((pattern) => pattern.test(value))) return 'confirm';
  return 'unknown';
}

export function resolveStaffingOwnerGate(input: {
  wishTexts: string[];
  repliesAfterPropose: string[];
}): { allowed: boolean; decision: GroupTaskStaffingOwnerDecision } {
  if (input.wishTexts.some((wish) => detectSkipConfirmInWish(wish))) {
    return { allowed: true, decision: 'skip_authorized' };
  }
  for (const reply of input.repliesAfterPropose) {
    const kind = classifyOwnerStaffingReply(reply);
    if (kind === 'revise') return { allowed: false, decision: 'owner_revise' };
    if (kind === 'confirm') return { allowed: true, decision: 'owner_confirmed' };
  }
  return { allowed: false, decision: 'awaiting_owner' };
}

export function splitSessionMessagesForStaffingGate(
  messages: StaffingSessionMessage[],
  proposedAtMs: number,
): { wishTexts: string[]; repliesAfterPropose: string[] } {
  const chronological = [...messages].sort((left, right) => left.timestamp - right.timestamp);
  const wishTexts: string[] = [];
  const repliesAfterPropose: string[] = [];
  for (const message of chronological) {
    if (message.type !== 'user') continue;
    const content = String(message.content ?? '').trim();
    if (!content) continue;
    if (message.timestamp <= proposedAtMs) wishTexts.push(content);
    else repliesAfterPropose.push(content);
  }
  return { wishTexts, repliesAfterPropose };
}

export function localSeatMetabotIds(plan: GroupTaskStaffingPlan): number[] {
  return [...new Set(
    plan.seats
      .filter((seat) => seat.source === 'local' && Number.isInteger(seat.metabotId) && Number(seat.metabotId) > 0)
      .map((seat) => Number(seat.metabotId)),
  )];
}

export function localSeatNames(plan: GroupTaskStaffingPlan): string[] {
  return plan.seats
    .filter((seat) => seat.source === 'local' && seat.candidateName)
    .map((seat) => seat.candidateName);
}

export function remoteSeats(plan: GroupTaskStaffingPlan): GroupTaskStaffingSeat[] {
  return plan.seats.filter((seat) => seat.source === 'remote');
}

export function buildStaffingSlateText(input: {
  title: string;
  goal: string;
  acceptanceCriteria?: string | null;
  plan: GroupTaskStaffingPlan;
  ownerConfirmRequired: boolean;
  language?: 'zh' | 'en';
}): string {
  const zh = input.language !== 'en';
  const roleLabel = (seat: GroupTaskStaffingSeat): string => {
    if (seat.role === 'domain') return zh ? `领域（${seat.domainLabel || '未标注'}）` : `domain (${seat.domainLabel || 'unspecified'})`;
    const labels: Record<Exclude<GroupTaskSeatRole, 'domain'>, [string, string]> = {
      content: ['内容', 'content'],
      design: ['设计', 'design'],
      engineering: ['工程', 'engineering'],
      promotion: ['推广', 'promotion'],
    };
    return zh ? labels[seat.role][0] : labels[seat.role][1];
  };
  const lines: string[] = [];
  if (zh) {
    lines.push(`按你的目标「${input.title}」，我拆成 ${input.plan.seats.length} 个粗岗位（调查是每个岗位的基础能力，不单设岗），准备这 ${input.plan.seats.length} 个人（加我一共 ${input.plan.seats.length + 1} 人）：`);
  } else {
    lines.push(`For "${input.title}", I split the work into ${input.plan.seats.length} coarse seat(s) (research is a basic capability of every seat). Proposed team: ${input.plan.seats.length} specialist(s) + me as chair = ${input.plan.seats.length + 1}:`);
  }
  for (const seat of input.plan.seats) {
    const origin = seat.source === 'remote'
      ? (zh ? '**在线，非本机**' : '**online, remote**')
      : (zh ? '本机' : 'local');
    const reason = seat.reason ? (zh ? ` · 理由：${seat.reason}` : ` · reason: ${seat.reason}`) : '';
    const backup = seat.backupName
      ? (zh ? `（备选：${seat.backupName}）` : ` (backup: ${seat.backupName})`)
      : '';
    lines.push(`- **${roleLabel(seat)}** — ${seat.candidateName}（${origin}）${backup}${reason}`);
  }
  if (input.plan.stages.length > 0) {
    lines.push('');
    lines.push(zh ? '工序：' : 'Stages:');
    for (const stage of input.plan.stages) {
      lines.push(`- ${stage.title}`);
    }
  }
  if (input.acceptanceCriteria?.trim()) {
    lines.push('');
    lines.push(zh ? `验收：${input.acceptanceCriteria.trim()}` : `Acceptance: ${input.acceptanceCriteria.trim()}`);
  }
  lines.push('');
  if (input.ownerConfirmRequired) {
    lines.push(zh
      ? '请看是否合理。可以说换人、去掉某岗，或回复「确认人选 / 就这样开」。没确认前我不会建群。'
      : 'Please confirm this roster, ask to swap/drop a seat, or say "looks good, start". I will not create the group until you confirm.');
  } else {
    lines.push(zh
      ? '你已经说了不用确认人选，我将按这份名单直接开群。'
      : 'You asked to skip roster confirmation; I will create the group with this slate.');
  }
  return lines.join('\n');
}

export function assertCreateRosterCap(workerCount: number): void {
  const teamSize = workerCount + 1;
  if (teamSize > GROUP_TASK_HARD_TEAM_SIZE) {
    throw new GroupTaskStaffingError(
      'ROSTER_CAP_EXCEEDED',
      `Group task roster ${teamSize} exceeds the hard cap of ${GROUP_TASK_HARD_TEAM_SIZE} (including the Twin chair).`,
    );
  }
}
