/**
 * OpenTeam invitee-side renderer types — mirror of the main-process shapes
 * returned by the openTeamCollab:* IPC surface. A membership records one local
 * bot auto-joining an external group task hosted on another machine.
 */

export type OpenTeamCollabStatus = 'active' | 'left';

export interface OpenTeamCollabSummary {
  id: number;
  groupId: string;
  metabotId: number;
  /** Local bot display name (metabots.name); null when the bot row is gone. */
  botName: string | null;
  globalmetaid: string | null;
  inviterGlobalmetaid: string | null;
  taskTitle: string | null;
  invitePinId: string | null;
  joinedPinId: string | null;
  status: OpenTeamCollabStatus;
  createdAt: string | null;
  /** Total locally indexed group messages for the group. */
  messageCount: number;
  /** chain_timestamp of the newest indexed message; null when none. */
  lastMessageAt: number | null;
}
