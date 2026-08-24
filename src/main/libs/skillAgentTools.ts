import { z } from 'zod';
import type {
  ExtractMetaAppResult,
  InstallSkillResult,
  InstallSkillSource,
} from '../services/skillInstallService';

/** Calling session's skill perspective: its bot binding, or null for a
 * bot-less user session (which sees bundled + global skills only). */
export type SkillToolPerspective = { metabotId: number | null };

/**
 * Control surface the host (main.ts) provides for the skill_tool.
 * Backed by skillInstallService — extract MetaApp zips, install skill
 * packages into the user-data SKILLs directory, and list what is already
 * installed. Every skill operation is perspective-aware: the caller's bot
 * determines assignment on install and visibility on list/read.
 */
export type SkillToolControl = {
  extractMetaApp(input: { pinId: string; workspaceDir: string }): Promise<ExtractMetaAppResult>;
  installSkill(
    input: InstallSkillSource,
    perspective: SkillToolPerspective
  ): Promise<InstallSkillResult & {
    /** Skill id (folder name) of the installed package, when ok. */
    skillId?: string;
    /** metabot the skill was auto-assigned to; null = installed to the
     * library unassigned (bot-less session — assign via the Skills UI). */
    assignedToMetabotId?: number | null;
  }>;
  listInstalledSkills(perspective: SkillToolPerspective): Array<{
    id: string;
    name: string;
    origin: 'bundled' | 'global' | 'assigned';
  }>;
  /**
   * Load one enabled skill's full SKILL.md plus its directory (for relative
   * path resolution), scoped to the caller's visible set. Backs the
   * read_skill action; null when the name/id does not resolve to a skill the
   * caller's bot may use.
   */
  readSkill(nameOrId: string, perspective: SkillToolPerspective): {
    id: string;
    name: string;
    directory: string;
    skillPath: string;
    content: string;
  } | null;
};

type SdkToolFactory = (
  name: string,
  description: string,
  schema: Record<string, unknown>,
  handler: (args: any) => Promise<unknown>,
) => unknown;

function textResult(text: string, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    ...(isError ? { isError: true } : {}),
  };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Aggregate skill / MetaApp package operations. Registered for every cowork
 * surface (standard Chat included) so a bot can search → read APP.md →
 * install → verify without leaving the conversation.
 *
 * All skill operations are scoped to the calling session's bot: installs are
 * auto-assigned to that bot (bot-less user sessions install to the library
 * unassigned), and list/read only surface skills the bot may actually use
 * (bundled + global + assigned).
 *
 * install_skill is gated host-side: coworkRunner.withSkillInstallApproval
 * asks the owner for confirmation in interactive sessions (unattended
 * acceptEdits/bypassPermissions/autoApprove sessions skip the prompt), so
 * this builder itself never prompts.
 */
export function buildSkillAgentTools(deps: {
  tool: SdkToolFactory;
  control: SkillToolControl;
  getWorkspaceDir: () => string;
  /** The calling session's REAL metabot binding (no twin fallback). */
  getMetabotId: () => number | null;
}): unknown[] {
  const { tool, control, getWorkspaceDir, getMetabotId } = deps;
  const perspective = (): SkillToolPerspective => ({ metabotId: getMetabotId() });

  return [
    tool(
      'skill_tool',
      [
        'Install, read, and list on-device skills; also extract a MetaApp package to read its APP.md.',
        'Use action "extract_metaapp" with pinId (or metaapp://<pinId>) after search_metaapps: unpacks the app zip into the workspace temp dir, returns the file list plus APP.md (install instructions live there). Not for just opening an app in the Bot Browser.',
        'Use action "install_skill" to install one skill into the user-data SKILLs directory (never the source tree). Pass exactly one source: zip (local path, http(s) URL, or metafile://<pinId>), github (owner/repo or a github.com tree/blob URL), skills.sh (package name), or npm (package name). Package must contain SKILL.md; installed as SKILLs/<name from SKILL.md>/; 4MB limit. Skills belong to bots: when called from a bot session the install is auto-assigned to that bot; from a bot-less session it lands in the library unassigned — tell the owner to assign it via the Skills UI if it should be usable.',
        'Use action "list_installed_skills" to list the skills THIS session\'s bot can use (bundled / global / assigned) and verify a skill is usable after install.',
        'Use action "read_skill" with name (id or name from the <available_skills> catalog) to load a skill\'s full SKILL.md plus its on-disk directory; resolve the SKILL.md\'s relative paths against that directory.',
        'Assigning skills to other bots belongs on metabot_update (chat_skill_op), not here. Returns JSON per action.',
      ].join(' '),
      {
        action: z.enum(['extract_metaapp', 'install_skill', 'list_installed_skills', 'read_skill']),
        name: z.string().optional().describe('Skill id or name for read_skill.'),
        pinId: z.string().optional().describe('MetaApp pin id or metaapp://<pinId> for extract_metaapp.'),
        zip: z.string().optional().describe('Local path, http(s) URL, or metafile:// pin for a skill zip.'),
        github: z.string().optional().describe('GitHub owner/repo or a github.com tree/blob URL.'),
        'skills.sh': z.string().optional().describe('skills.sh package name (owner/repo or registry name).'),
        npm: z.string().optional().describe('npm package name whose tarball contains SKILL.md.'),
      },
      async (args: {
        action: 'extract_metaapp' | 'install_skill' | 'list_installed_skills' | 'read_skill';
        name?: string;
        pinId?: string;
        zip?: string;
        github?: string;
        'skills.sh'?: string;
        npm?: string;
      }) => {
        if (args.action === 'list_installed_skills') {
          const skills = control.listInstalledSkills(perspective());
          if (skills.length === 0) {
            return textResult('No skills available for this session.');
          }
          const lines = skills.map((skill) => `- ${skill.name} (${skill.id}, ${skill.origin})`);
          return textResult(
            [
              `Skills available to this session (${skills.length}; origin: bundled = shipped with IDBots, global = shared with all bots, assigned = assigned to this bot):`,
              ...lines,
            ].join('\n'),
          );
        }

        if (args.action === 'read_skill') {
          const name = asString(args.name);
          if (!name) {
            return textResult('skill_tool read_skill requires name (skill id or name).', true);
          }
          const entry = control.readSkill(name, perspective());
          if (!entry) {
            return textResult(
              `Skill "${name}" not found or not enabled. Use action list_installed_skills to see what is installed.`,
              true,
            );
          }
          return textResult([
            `## Skill: ${entry.name}`,
            '',
            `Skill directory: ${entry.directory}`,
            'Resolve relative paths in this SKILL.md against that directory.',
            '',
            '---',
            '',
            entry.content,
          ].join('\n'));
        }

        if (args.action === 'extract_metaapp') {
          const pinId = asString(args.pinId);
          if (!pinId) {
            return textResult('skill_tool extract_metaapp requires pinId (or metaapp://<pinId>).', true);
          }
          try {
            const result = await control.extractMetaApp({
              pinId,
              workspaceDir: getWorkspaceDir(),
            });
            return textResult(JSON.stringify(result, null, 2), result.ok === false);
          } catch (error) {
            return textResult(
              `extract_metaapp failed: ${error instanceof Error ? error.message : String(error)}`,
              true,
            );
          }
        }

        const source: InstallSkillSource = {
          zip: asString(args.zip) || undefined,
          github: asString(args.github) || undefined,
          'skills.sh': asString(args['skills.sh']) || undefined,
          npm: asString(args.npm) || undefined,
        };
        try {
          const result = await control.installSkill(source, perspective());
          return textResult(JSON.stringify(result, null, 2), result.ok === false);
        } catch (error) {
          return textResult(
            `install_skill failed: ${error instanceof Error ? error.message : String(error)}`,
            true,
          );
        }
      },
    ),
  ];
}
