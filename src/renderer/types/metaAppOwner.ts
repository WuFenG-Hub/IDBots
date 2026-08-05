export type MetaAppOperation = 'create' | 'modify' | 'revoke';

export interface MetaAppManifestInput {
  title?: string;
  appName?: string;
  prompt?: string;
  icon?: string;
  coverImg?: string;
  introImgs?: string[];
  intro?: string;
  runtime?: string | string[];
  version?: string;
  contentType?: string;
  content?: string;
  indexFile?: string;
  code?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  tags?: string[];
  disabled?: boolean;
  codeType?: string;
}

export interface OwnerMetaAppRecord {
  pinId: string;
  firstPinId: string;
  operation: MetaAppOperation;
  title: string;
  appName: string;
  prompt?: string;
  icon?: string;
  coverImg?: string;
  introImgs: string[];
  intro?: string;
  runtime: string;
  version: string;
  contentType: string;
  content?: string;
  indexFile?: string;
  code?: string;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  tags: string[];
  disabled: boolean;
  codeType?: string;
  ownerAddress: string;
  timestamp: number | null;
  txid?: string;
  txids: string[];
  metaappUri: string;
  shareWebUrl: string;
  runUrl: string;
  raw?: unknown;
}
