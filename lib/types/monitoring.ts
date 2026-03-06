import { ServiceStatus, ApplicationServiceHealthStatus, ServiceMetadata, ServiceHealth } from './services';

export interface HostService {
  id: string;
  serviceName: string;
  serviceType: string;
  status: ServiceStatus;
  health: ApplicationServiceHealthStatus;
  config: Record<string, any>;
  startedAt?: Date;
  stoppedAt?: Date;
  lastError?: {
    message: string;
    timestamp: Date;
    details?: Record<string, any>;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface HostServiceStatusResponse {
  service: HostService;
  metadata: ServiceMetadata;
  healthDetails: ServiceHealth;
}

export interface MonitoringQueryRequest {
  query: string;
  time?: string;
}

export interface MonitoringRangeQueryRequest {
  query: string;
  start: string;
  end: string;
  step?: string;
}

export interface PrometheusQueryResult {
  status: string;
  data: {
    resultType: string;
    result: Array<{
      metric: Record<string, string>;
      value?: [number, string];
      values?: Array<[number, string]>;
    }>;
  };
}

export interface MonitoringTargetsResponse {
  status: string;
  data: {
    activeTargets: Array<{
      labels: Record<string, string>;
      scrapeUrl: string;
      lastScrape: string;
      health: string;
    }>;
  };
}
