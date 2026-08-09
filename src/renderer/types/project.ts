// Project type definitions (Settings > Projects)

export interface ProjectResource {
  path: string;      // absolute file or directory path
  note?: string;     // optional hint for MetaBots about what this resource is
}

export interface ProjectRecord {
  id: string;
  name: string;            // required, unique (case-insensitive)
  icon?: string;           // base64 data URL, <= 200KB (png/jpeg/webp/gif)
  guidelines?: string;     // binding notes for MetaBots working on the project
  sourceDir?: string;      // optional single source directory
  resources: ProjectResource[];
  enabled: boolean;        // disabled = soft-frozen for MetaBots
  createdAt: number;
  updatedAt: number;
}

// Update semantics: `undefined` keeps the stored value, explicit `null` clears it.
export interface ProjectFormData {
  name: string;
  icon?: string | null;
  guidelines?: string | null;
  sourceDir?: string | null;
  resources?: ProjectResource[];
}

export interface ProjectsResponse {
  success: boolean;
  projects?: ProjectRecord[];
  error?: string;
}
