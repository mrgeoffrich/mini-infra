import { HttpClient } from '../../../lib/http-client';

// ====================
// Mixin Type Helpers
// ====================

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Constructor<T = {}> = new (...args: any[]) => T;

export interface IHAProxyClientBase {
  httpClient: HttpClient;
  handleApiError(error: unknown, operation: string, context?: Record<string, any>): void;
  getVersion(): Promise<number>;
  beginTransaction(): Promise<string>;
  commitTransaction(transactionId: string): Promise<void>;
  rollbackTransaction(transactionId: string): Promise<void>;
  withRetry<T>(operation: () => Promise<T>, maxRetries?: number, baseDelay?: number): Promise<T>;
}

export type HAProxyBaseConstructor = Constructor<IHAProxyClientBase>;

// ====================
// Types and Interfaces
// ====================

export interface ServerConfig {
  name: string;
  address: string;
  port: number;
  check?: 'enabled' | 'disabled';
  check_path?: string;
  inter?: number; // health check interval in ms
  rise?: number; // number of checks to consider server up
  fall?: number; // number of checks to consider server down
  maintenance?: 'enabled' | 'disabled';
  enabled?: boolean;
  weight?: number;
}

export interface BackendConfig {
  name: string;
  mode?: 'http' | 'tcp';
  balance?: 'roundrobin' | 'leastconn' | 'source';
  check_timeout?: number;
  connect_timeout?: number;
  server_timeout?: number;
}

export interface FrontendConfig {
  name: string;
  mode?: 'http' | 'tcp';
  default_backend?: string;
  bind_port?: number;
  bind_address?: string;
}

export interface FrontendRule {
  id: number;
  type: 'use_backend' | 'redirect' | 'http-request';
  cond: 'if' | 'unless';
  cond_test: string;
  backend?: string;
  redirect_code?: number;
  redirect_value?: string;
}

export interface Backend {
  name: string;
  mode: string;
  balance: {
    algorithm: string;
  };
  servers?: Server[];
}

export interface Server {
  name: string;
  address: string;
  port: number;
  weight: number;
  enabled: boolean;
  stats: {
    status: string;
    health: string;
  };
}

export interface ServerStats {
  name: string;
  status: 'UP' | 'DOWN' | 'MAINT' | 'DRAIN';
  check_status: string;
  check_duration: number;
  weight: number;
  current_sessions: number;
  max_sessions: number;
  total_sessions: number;
  bytes_in: number;
  bytes_out: number;
  denied_requests: number;
  errors_con: number;
  errors_resp: number;
  warnings_retr: number;
  warnings_redis: number;
}

export interface BackendStats {
  name: string;
  status: string;
  current_sessions: number;
  max_sessions: number;
  total_sessions: number;
  bytes_in: number;
  bytes_out: number;
  denied_requests: number;
  errors_con: number;
  errors_resp: number;
  weight: number;
  act_servers: number;
  bck_servers: number;
}

export interface HAProxyEndpointInfo {
  baseUrl: string;
  containerName: string;
  containerId: string;
}

export interface Version {
  version: number;
}

export interface ApiResponse<T> {
  data: T;
  version?: number;
}

export interface ErrorResponse {
  code: number;
  message: string;
}
