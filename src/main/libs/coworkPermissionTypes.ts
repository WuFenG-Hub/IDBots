/**
 * Host permission decision shared by DSH (and leftover sandbox) approval
 * bridges. Local-owned so the Claude Agent SDK is not a type dependency for
 * the DSH-only cowork kernel.
 */
export type PermissionResult =
  | {
      behavior: 'allow';
      updatedInput?: Record<string, unknown>;
      updatedPermissions?: Record<string, unknown>[];
      toolUseID?: string;
    }
  | {
      behavior: 'deny';
      message: string;
      interrupt?: boolean;
      toolUseID?: string;
    };
