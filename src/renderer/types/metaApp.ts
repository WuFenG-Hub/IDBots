export interface MetaAppRecord {
  id: string;
  name: string;
  description: string;
  icon?: string;
  cover?: string;
  isOfficial: boolean;
  updatedAt: number;
  entry: string;
  appPath: string;
  appRoot: string;
  prompt: string;
  aiPrompt?: string;
  version: string;
  creatorMetaId: string;
  authorName?: string;
  authorAvatar?: string;
  sourcePinId?: string;
  codePinId?: string;
  sourceType: 'bundled-idbots' | 'chain-idbots' | 'chain-community' | 'manual' | string;
  managedByIdbots: boolean;
}

export interface CommunityMetaAppRecord {
  appId: string;
  name: string;
  description: string;
  icon?: string;
  cover?: string;
  version: string;
  runtime: string;
  creatorMetaId: string;
  sourcePinId: string;
  publishedAt: number;
  indexFile: string;
  codeUri: string;
  codePinId: string;
  aiPrompt?: string;
  authorName?: string;
  authorAvatar?: string;
  status: 'install' | 'installed' | 'update' | 'uninstallable';
  installable: boolean;
  reason: string;
}

export interface CommunityMetaAppListParams {
  cursor?: string;
  size?: number;
  /** App identity keys already shown on earlier pages; stale versions are skipped. */
  seen?: string[];
}

export interface MetaAppUrlResult {
  success: boolean;
  appId?: string;
  name?: string;
  url?: string;
  error?: string;
}

export interface CommunityMetaAppListResult {
  success: boolean;
  apps?: CommunityMetaAppRecord[];
  nextCursor?: string | null;
  /** Full seen-set for the requested cursor after this page; persist for navigation. */
  seen?: string[];
  error?: string;
}

export interface CommunityMetaAppInstallResult {
  success: boolean;
  appId?: string;
  name?: string;
  status?: 'installed' | 'updated' | 'already-installed';
  error?: string;
}
