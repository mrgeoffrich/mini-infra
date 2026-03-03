// ====================
// GitHub Settings Types
// ====================

// GitHub specific request types for settings API
export interface CreateGitHubSettingRequest {
  personal_access_token: string;
  repo_owner: string;
  repo_name: string;
  encrypt?: boolean;
}

export interface UpdateGitHubSettingRequest {
  personal_access_token?: string;
  repo_owner?: string;
  repo_name?: string;
  encrypt?: boolean;
}

export interface ValidateGitHubConnectionRequest {
  personal_access_token?: string; // Optional - if not provided, uses stored token
  repo_owner?: string;
  repo_name?: string;
}

// ====================
// GitHub Response Types
// ====================

// GitHub configuration response
export interface GitHubSettingResponse {
  success: boolean;
  data: {
    isConfigured: boolean;
    hasPersonalAccessToken: boolean;
    repoOwner?: string;
    repoName?: string;
    isValid?: boolean;
    validationMessage?: string;
  };
  message?: string;
}

// GitHub connection validation response
export interface GitHubValidationResponse {
  success: boolean;
  data: {
    isValid: boolean;
    message: string;
    errorCode?: string;
    metadata?: Record<string, any>;
    responseTimeMs: number;
  };
}

// ====================
// Bug Report Types
// ====================

// Auto-collected system information for bug reports
export interface BugReportSystemInfo {
  userAgent: string;
  screenWidth: number;
  screenHeight: number;
  currentRoute: string;
  timestamp: string;
  appVersion?: string;
  platform?: string;
}

// User-provided bug report data
export interface BugReportUserData {
  title: string;
  description: string;
  stepsToReproduce?: string;
  expectedBehavior?: string;
  actualBehavior?: string;
}

// Complete bug report request
export interface BugReportRequest {
  userData: BugReportUserData;
  systemInfo: BugReportSystemInfo;
}

// Bug report response
export interface BugReportResponse {
  success: boolean;
  data: {
    issueNumber: number;
    issueUrl: string;
    title: string;
  };
  message?: string;
}

// ====================
// GitHub Issue Types
// ====================

// GitHub issue creation request (internal service use)
export interface CreateGitHubIssueRequest {
  title: string;
  body: string;
  labels?: string[];
  assignees?: string[];
}

// GitHub issue response (from GitHub API)
export interface GitHubIssue {
  id: number;
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  html_url: string;
  created_at: string;
  updated_at: string;
  labels: Array<{
    name: string;
    color: string;
  }>;
}
