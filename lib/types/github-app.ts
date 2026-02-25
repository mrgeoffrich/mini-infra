// ====================
// GitHub App Manifest Flow Types
// ====================

export interface GitHubAppManifestResponse {
  manifestUrl: string;
  state: string; // CSRF token stored server-side
}

export interface GitHubAppSetupCompleteRequest {
  code: string;
}

export interface GitHubAppSetupCompleteResponse {
  success: boolean;
  appSlug: string;
  owner: string;
  message: string;
}

// ====================
// GitHub App Settings Types
// ====================

export interface GitHubAppSettingResponse {
  isConfigured: boolean;
  appSlug: string | null;
  appId: string | null;
  owner: string | null;
  installationId: string | null;
  permissions: string[] | null;
}

export interface GitHubAppValidationResponse {
  isValid: boolean;
  status: string;
  message: string;
  responseTimeMs: number;
  authenticatedAs?: string;
  installationPermissions?: Record<string, string>;
}

// ====================
// GitHub App Resource Types
// ====================

export interface GitHubAppPackage {
  id: number;
  name: string;
  packageType: string;
  visibility: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  owner: string;
  repository: string | null;
  versionsCount?: number;
}

export interface GitHubAppPackageVersion {
  id: number;
  name: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  htmlUrl: string;
  metadata?: {
    container?: {
      tags: string[];
    };
  };
}

export interface GitHubAppRepository {
  id: number;
  name: string;
  fullName: string;
  description: string | null;
  private: boolean;
  htmlUrl: string;
  language: string | null;
  defaultBranch: string;
  updatedAt: string;
  pushedAt: string | null;
  hasActions: boolean;
}

export interface GitHubAppActionsRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
  headBranch: string;
  headSha: string;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  runNumber: number;
  event: string;
}

export interface GitHubAppRegistryTokenResponse {
  success: boolean;
  message: string;
  registryUrl: string;
  credentialId?: string;
  expiresAt?: string;
}
