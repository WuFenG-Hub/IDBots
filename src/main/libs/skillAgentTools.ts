import { z } from 'zod';
import type {
  ExtractMetaAppResult,
  InstallSkillResult,
  InstalledSkillInfo,
  InstallSkillSource,
} from '../services/skillInstallService';

/**
 * Control surface the host (main.ts) provides for the skill_tool.
 * Backed by skillInstallService — extract MetaApp zips, install skill
 * packages into the user-data SKILLs directory, and list what is already
 * installed.
 */
export type SkillToolControl = {
  extractMetaApp(input: { pinId: string; workspaceDir: string }): Promise<ExtractMetaAppResult>;
  installSkill(input: InstallSkillSource): Promise<InstallSkillResult>;
  listInstalledSkills(): InstalledSkillInfo[];
  /**
   * Load one enabled skill's full SKILL.md plus its directory (for relative
   * path resolution). Backs the read_skill action; null when the name/id
   * does not resolve to an enabled skill.
   */
  readSkill(nameOrId: string): {
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
 * Does not prompt AskUserQuestion: install is a local SKILLs/ write that
 * the product owner explicitly opted out of confirmation for.
 */
export function buildSkillAgentTools(deps: {
  tool: SdkToolFactory;
  control: SkillToolControl;
  getWorkspaceDir: () => string;
}): unknown[] {
  const { tool, control, getWorkspaceDir } = deps;

  return [
    tool(
      'skill_tool',
      [
        'Install, inspect, and list on-device skills (and extract a MetaApp package to read its APP.md).',
        'Use action "extract_metaapp" with pinId (or metaapp://<pinId>) after search_metaapps: downloads the app zip, unpacks it into the workspace temp dir, and returns the file list plus APP.md (install instructions live there).',
        'Use action "install_skill" to install a skill into the user-data SKILLs directory (the same folder the packaged app uses; never the source tree). Pass exactly one source: zip (local path, http(s) URL, or metafile://<pinId>), github (owner/repo or a github.com tree/blob URL), skills.sh (package name), or npm (package name). The package must contain SKILL.md; it is installed as SKILLs/<name from SKILL.md>/. Size limit 4MB.',
        'Use action "list_installed_skills" to verify a skill is on disk (name + version) after install.',
        'Use action "read_skill" with name (id or name from the <available_skills> catalog) to load a skill\'s full SKILL.md plus its on-disk directory; resolve the SKILL.md\'s relative paths against that directory.',
        'When NOT to use: do not call extract_metaapp just to open an app in the Bot Browser; this is for reading APP.md / installing the skill it describes. Chat-skill whitelist changes belong on metabot_update (chat_skill_op), not here.',
        'Returns JSON. extract_metaapp returns {ok, files, appMd, extractedDir} or {ok:false, reason:"not-a-zip"} when the pin is not a zip. install_skill returns {ok, name, version, dest} or {ok:false, error}.',
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
          const skills = control.listInstalledSkills();
          if (skills.length === 0) {
            return textResult('No skills installed in the user-data SKILLs directory.');
          }
          const lines = skills.map((skill) => `- ${skill.name} (${skill.version})`);
          return textResult(
            [`Installed skills (${skills.length}):`, ...lines].join('\n'),
          );
        }

        if (args.action === 'read_skill') {
          const name = asString(args.name);
          if (!name) {
            return textResult('skill_tool read_skill requires name (skill id or name).', true);
          }
          const entry = control.readSkill(name);
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
          const result = await control.installSkill(source);
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
