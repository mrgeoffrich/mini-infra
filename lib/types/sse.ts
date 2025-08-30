import { JobStatus, JobProgress } from './job.js';

export interface BaseSSEEvent {
  type: string;
  timestamp: string;
  sessionId: string;
}

export interface JobStartedEvent extends BaseSSEEvent {
  type: 'job-started';
  jobId: string;
  message: string;
}

export interface JobProgressEvent extends BaseSSEEvent {
  type: 'job-progress';
  jobId: string;
  progress: JobProgress;
}

export interface JobLogEvent extends BaseSSEEvent {
  type: 'job-log';
  jobId: string;
  level: 'info' | 'error' | 'warning' | 'debug';
  message: string;
  source?: string;
}

export interface JobStatusEvent extends BaseSSEEvent {
  type: 'job-status';
  jobId: string;
  status: JobStatus;
  message?: string;
}

export interface JobCompletedEvent extends BaseSSEEvent {
  type: 'job-completed';
  jobId: string;
  status: JobStatus;
  result?: any;
  message: string;
}

export interface JobErrorEvent extends BaseSSEEvent {
  type: 'job-error';
  jobId: string;
  error: string;
  details?: any;
}

export interface ConnectionEvent extends BaseSSEEvent {
  type: 'connected';
  jobId?: string;
}

export interface HeartbeatEvent extends BaseSSEEvent {
  type: 'heartbeat';
}

export type SSEEvent = 
  | JobStartedEvent
  | JobProgressEvent 
  | JobLogEvent
  | JobStatusEvent
  | JobCompletedEvent
  | JobErrorEvent
  | ConnectionEvent
  | HeartbeatEvent;

export interface SSEConnection {
  sessionId: string;
  jobId?: string;
  connected: boolean;
  lastHeartbeat: Date;
}