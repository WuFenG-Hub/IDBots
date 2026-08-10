import fs from 'fs';
import { z } from 'zod';
import type { ProjectRecord, ProjectResource } from '../projectStore';

/**
 * Control surface the host (main.ts) provides for the local Projects tool.
 * Backed by the SQLite projects table via ProjectStore.
 */
export interface ProjectsControl {
  list(): ProjectRecord[];
}

/** Minimal shape of the claude-agent-sdk `tool()` helper we depend on. */
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

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const PROMPT_GUIDELINES_MAX = 300;

/**
 * Build the `## Local Projects` system-prompt section. Enabled projects carry
 * their key facts inline (source directory + guidelines excerpt) so the bot
 * knows them with zero tool calls — weak models otherwise skip the tool call
 * and go clone from GitHub (observed failure). Frozen projects are named only,
 * never with paths. Returns null when there is nothing configured.
 */
export function buildProjectsPromptSection(projects: ProjectRecord[]): string | null {
  if (!projects.length) return null;
  const enabled = projects.filter((project) => project.enabled);
  const disabled = projects.filter((project) => !project.enabled);
  const lines = [
    '## Local Projects',
    `This machine has ${projects.length} configured project(s). Key facts are inlined below — use them directly when the user mentions a project by name, and NEVER clone or fetch that project from a remote repository when a source directory is listed here. Call the \`project_query\` tool with the name for full guidelines and the resource list. Treat each project's guidelines as binding instructions for any work on that project.`,
    '<available_projects>',
    ...enabled.map((project) => {
      const entry = ['<project>', `<name>${escapeXmlText(project.name)}</name>`];
      if (project.sourceDir) {
        entry.push(`<source_dir>${escapeXmlText(project.sourceDir)}</source_dir>`);
      }
      const guidelines = project.guidelines?.replace(/\s+/g, ' ').trim();
      if (guidelines) {
        entry.push(`<guidelines>${escapeXmlText(truncate(guidelines, PROMPT_GUIDELINES_MAX))}</guidelines>`);
      }
      entry.push(`<resources_count>${project.resources.length}</resources_count>`);
      entry.push('</project>');
      return entry.join('\n');
    }),
    '</available_projects>',
  ];
  if (disabled.length) {
    lines.push(
      `Frozen (disabled) projects — do NOT read, modify or write anything under their paths: ${disabled.map((project) => escapeXmlText(project.name)).join(', ')}`
    );
  }
  return lines.join('\n');
}

interface StatResult {
  type: 'directory' | 'file';
  missing?: boolean;
}

/** Stat a path defensively: returns its type, or missing:true when it is gone. */
function statPath(targetPath: string): StatResult {
  try {
    const stat = fs.statSync(targetPath);
    return { type: stat.isDirectory() ? 'directory' : 'file' };
  } catch {
    return { type: 'file', missing: true };
  }
}

function formatResource(resource: ProjectResource): string {
  const stat = statPath(resource.path);
  const parts = [`{ path: ${resource.path}, type: '${stat.type}'`];
  if (resource.note) parts.push(`, note: ${resource.note}`);
  if (stat.missing) parts.push(', missing: true');
  parts.push(' }');
  return parts.join('');
}

function formatProjectSummary(project: ProjectRecord): string {
  const guidelines = project.guidelines?.trim()
    ? truncate(project.guidelines.replace(/\s+/g, ' ').trim(), 160)
    : 'none';
  const lines = [
    `- ${project.name}`,
    `  guidelines: ${guidelines}`,
    `  sourceDir: ${project.sourceDir || 'none'}`,
    `  resources: ${project.resources.length}`,
  ];
  return lines.join('\n');
}

function formatProjectDetail(project: ProjectRecord): string {
  const lines = [
    `Project: ${project.name}`,
    `guidelines: ${project.guidelines?.trim() ? project.guidelines : 'none'}`,
  ];
  if (project.sourceDir) {
    const stat = statPath(project.sourceDir);
    lines.push(`sourceDir: { path: ${project.sourceDir}, type: '${stat.type}'${stat.missing ? ', missing: true' : ''} }`);
  } else {
    lines.push('sourceDir: none');
  }
  if (project.resources.length) {
    lines.push('resources:');
    for (const resource of project.resources) {
      lines.push(`- ${formatResource(resource)}`);
    }
  } else {
    lines.push('resources: none');
  }
  lines.push('Treat this project\'s guidelines as binding instructions for any work on the project.');
  return lines.join('\n');
}

/**
 * Inline MCP tool that lets any cowork session query the locally configured
 * Projects (see the Settings > Projects tab). Registered for every session
 * type when the host provides ProjectsControl (see coworkRunner). Disabled
 * projects are soft-frozen: the tool never reveals their paths.
 */
export function buildProjectsAgentTools(deps: {
  tool: SdkToolFactory;
  control: ProjectsControl;
}): unknown[] {
  const { tool, control } = deps;

  const projectQuery = tool(
    'project_query',
    'Query locally configured Projects. Without arguments, returns a summary list of enabled projects (name, guidelines excerpt, source directory, resource count) plus the names of frozen (disabled) projects. With `name`, returns the full detail for that project: full guidelines, source directory, and every resource path with its type (directory/file) and whether it is missing. Use this BEFORE working on a project the user mentions by name, and treat its guidelines as binding instructions.',
    {
      name: z.string().optional().describe('Project name to get full details for; omit to list all projects'),
    },
    async (args: { name?: string }) => {
      try {
        const projects = control.list();
        const queryName = args.name?.trim();

        if (!queryName) {
          if (!projects.length) {
            return textResult('No projects are configured on this machine yet. The user can create them in Settings > Projects.');
          }
          const enabled = projects.filter((project) => project.enabled);
          const disabled = projects.filter((project) => !project.enabled);
          const sections: string[] = [];
          if (enabled.length) {
            sections.push(`${enabled.length} enabled project(s):\n${enabled.map(formatProjectSummary).join('\n')}`);
          } else {
            sections.push('No enabled projects.');
          }
          if (disabled.length) {
            sections.push(
              `Frozen (disabled) projects — do NOT read, modify or write anything under their paths: ${disabled.map((project) => project.name).join(', ')}`
            );
          }
          sections.push('Call project_query with a project name for its full guidelines and paths before working on it.');
          return textResult(sections.join('\n\n'));
        }

        const project = projects.find((entry) => entry.name.toLowerCase() === queryName.toLowerCase());
        if (!project) {
          const available = projects.map((entry) => entry.name).join(', ') || 'none';
          return textResult(`No project named "${queryName}". Available projects: ${available}.`, true);
        }
        if (!project.enabled) {
          return textResult(
            `Project "${project.name}" is frozen (disabled). You MUST NOT read, modify or write anything belonging to it; its paths are intentionally hidden. Tell the user it can be re-enabled in Settings > Projects.`
          );
        }
        return textResult(formatProjectDetail(project));
      } catch (error) {
        return textResult(`project_query failed: ${error instanceof Error ? error.message : String(error)}`, true);
      }
    }
  );

  return [projectQuery];
}
