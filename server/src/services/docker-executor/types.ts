import { Readable } from "stream";

export interface ContainerExecutionOptions {
  image: string;
  env: Record<string, string>;
  timeout?: number; // in milliseconds
  removeContainer?: boolean;
  outputHandler?: (stream: Readable) => void;
  cmd?: string[]; // Custom command to run in container
  networkMode?: string; // Docker network to attach to
  binds?: string[]; // Volume binds in format "volume:/path:ro" or "/host/path:/container/path"
  // Compose-style grouping options
  projectName?: string; // Docker Compose project name
  serviceName?: string; // Docker Compose service name
  labels?: Record<string, string>; // Additional custom labels
}

export interface ContainerExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  containerId?: string;
}

export interface ContainerProgress {
  status: "starting" | "running" | "completed" | "failed" | "timeout";
  containerId?: string;
  executionTimeMs?: number;
  exitCode?: number;
  errorMessage?: string;
}

export interface DockerRegistryTestOptions {
  image: string;
  registryUsername?: string;
  registryPassword?: string;
}

export interface DockerRegistryTestResult {
  success: boolean;
  message: string;
  details: {
    image: string;
    authenticated: boolean;
    pullTimeMs?: number;
    errorCode?: string;
  };
}
