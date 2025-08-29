export interface ContainerInfo {
  id: string;
  name: string;
  status: "running" | "stopped" | "restarting" | "paused" | "exited";
  image: string;
  imageTag: string;
  ports: Array<{
    private: number;
    public?: number;
    type: "tcp" | "udp";
  }>;
  volumes: Array<{
    source: string;
    destination: string;
    mode: "rw" | "ro";
  }>;
  ipAddress?: string;
  createdAt: Date;
  startedAt?: Date;
  labels: Record<string, string>;
}

export interface ContainerListResponse {
  containers: ContainerInfo[];
  totalCount: number;
  lastUpdated: Date;
  page?: number;
  limit?: number;
}

export interface ContainerFilters {
  status?: string;
  name?: string;
  image?: string;
}

export interface ContainerQueryParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  filters?: ContainerFilters;
}
