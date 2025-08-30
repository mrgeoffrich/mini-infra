export const JobStatus = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress', 
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled'
} as const;

export type JobStatus = typeof JobStatus[keyof typeof JobStatus];

export interface JobProgress {
  current: number;
  total: number;
  percentage: number;
  message?: string;
}

export interface Job {
  id: string;
  userId: string;
  repositoryUrl: string;
  githubToken: string; // Encrypted
  storyFile: string;
  architectureDoc: string;
  branchPrefix?: string;
  featureBranch?: string;
  status: JobStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface JobExecution {
  id: string;
  jobId: string;
  sessionId: string;
  status: JobStatus;
  progress?: JobProgress;
  startedAt?: Date;
  completedAt?: Date;
  error?: string;
  logs: string[];
}

export interface JobLog {
  id: string;
  jobId: string;
  timestamp: Date;
  level: 'info' | 'error' | 'warning' | 'debug';
  message: string;
  source?: string;
}