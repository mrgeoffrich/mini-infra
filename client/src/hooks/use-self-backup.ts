import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  SelfBackupInfo,
  SelfBackupConfig,
  SelfBackupConfigResponse,
  ScheduleInfo,
  BackupHealthStatus,
  BackupHealthResponse,
  TriggerBackupResponse,
  BackupHistoryResponse,
  UpdateSelfBackupConfigRequest,
  Channel,
  ServerEvent,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `self-backup-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Self-Backup Configuration API Functions
// ====================

async function fetchSelfBackupConfig(
  correlationId: string
): Promise<SelfBackupConfigResponse> {
  const response = await fetch(`/api/settings/self-backup`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch self-backup configuration: ${response.statusText}`
    );
  }

  const data: SelfBackupConfigResponse = await response.json();

  if (!data.success) {
    throw new Error(
      data.error || "Failed to fetch self-backup configuration"
    );
  }

  return data;
}

async function updateSelfBackupConfig(
  config: UpdateSelfBackupConfigRequest,
  correlationId: string
): Promise<SelfBackupConfigResponse> {
  const response = await fetch(`/api/settings/self-backup`, {
    method: "PUT",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify(config),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to update self-backup configuration: ${response.statusText}`
    );
  }

  const data: SelfBackupConfigResponse = await response.json();

  if (!data.success) {
    throw new Error(
      data.error || "Failed to update self-backup configuration"
    );
  }

  return data;
}

async function enableSelfBackup(
  correlationId: string
): Promise<{ success: boolean; message?: string }> {
  const response = await fetch(`/api/settings/self-backup/enable`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to enable self-backup: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to enable self-backup");
  }

  return data;
}

async function disableSelfBackup(
  correlationId: string
): Promise<{ success: boolean; message?: string }> {
  const response = await fetch(`/api/settings/self-backup/disable`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to disable self-backup: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to disable self-backup");
  }

  return data;
}

async function triggerManualBackup(
  correlationId: string
): Promise<TriggerBackupResponse> {
  const response = await fetch(`/api/settings/self-backup/trigger`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to trigger backup: ${response.statusText}`);
  }

  const data: TriggerBackupResponse = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to trigger backup");
  }

  return data;
}

async function fetchScheduleInfo(
  correlationId: string
): Promise<{ success: boolean; scheduleInfo: ScheduleInfo | null }> {
  const response = await fetch(`/api/settings/self-backup/schedule-info`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch schedule info: ${response.statusText}`);
  }

  const data = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to fetch schedule info");
  }

  return data;
}

// ====================
// Backup History API Functions
// ====================

interface FetchBackupHistoryParams {
  status?: "in_progress" | "completed" | "failed";
  triggeredBy?: "scheduled" | "manual";
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
}

async function fetchBackupHistory(
  params: FetchBackupHistoryParams,
  correlationId: string
): Promise<BackupHistoryResponse> {
  const url = new URL(`/api/self-backups`, window.location.origin);

  // Add query parameters
  if (params.status) url.searchParams.set("status", params.status);
  if (params.triggeredBy) url.searchParams.set("triggeredBy", params.triggeredBy);
  if (params.startDate) url.searchParams.set("startDate", params.startDate);
  if (params.endDate) url.searchParams.set("endDate", params.endDate);
  if (params.sortBy) url.searchParams.set("sortBy", params.sortBy);
  if (params.sortOrder) url.searchParams.set("sortOrder", params.sortOrder);
  if (params.page) url.searchParams.set("page", params.page.toString());
  if (params.limit) url.searchParams.set("limit", params.limit.toString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch backup history: ${response.statusText}`);
  }

  const data: BackupHistoryResponse = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to fetch backup history");
  }

  return data;
}

async function fetchBackupHealth(
  correlationId: string
): Promise<BackupHealthResponse> {
  const response = await fetch(`/api/self-backups/health`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch backup health: ${response.statusText}`);
  }

  const data: BackupHealthResponse = await response.json();

  if (!data.success) {
    throw new Error(data.error || "Failed to fetch backup health");
  }

  return data;
}

// ====================
// Self-Backup Configuration Hooks
// ====================

export interface UseSelfBackupConfigOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

export function useSelfBackupConfig(
  options: UseSelfBackupConfigOptions = {}
) {
  const { enabled = true, refetchInterval } = options;
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["self-backup-config"],
    queryFn: () => fetchSelfBackupConfig(correlationId),
    enabled,
    refetchInterval,
    staleTime: 30000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useUpdateSelfBackupConfig() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: (config: UpdateSelfBackupConfigRequest) =>
      updateSelfBackupConfig(config, correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["self-backup-config"] });
      queryClient.invalidateQueries({ queryKey: ["schedule-info"] });
    },
  });
}

export function useEnableSelfBackup() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: () => enableSelfBackup(correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["self-backup-config"] });
      queryClient.invalidateQueries({ queryKey: ["schedule-info"] });
      queryClient.invalidateQueries({ queryKey: ["backup-health"] });
    },
  });
}

export function useDisableSelfBackup() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: () => disableSelfBackup(correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["self-backup-config"] });
      queryClient.invalidateQueries({ queryKey: ["schedule-info"] });
      queryClient.invalidateQueries({ queryKey: ["backup-health"] });
    },
  });
}

export function useTriggerManualBackup() {
  const queryClient = useQueryClient();
  const correlationId = generateCorrelationId();

  return useMutation({
    mutationFn: () => triggerManualBackup(correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["backup-history"] });
      queryClient.invalidateQueries({ queryKey: ["backup-health"] });
    },
  });
}

export function useScheduleInfo(options: UseSelfBackupConfigOptions = {}) {
  const { enabled = true, refetchInterval = 60000 } = options; // Refresh every minute
  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: ["schedule-info"],
    queryFn: () => fetchScheduleInfo(correlationId),
    enabled,
    refetchInterval,
    staleTime: 30000,
    gcTime: 5 * 60 * 1000,
  });
}

// ====================
// Backup History Hooks
// ====================

export interface UseBackupHistoryOptions {
  enabled?: boolean;
  status?: "in_progress" | "completed" | "failed";
  triggeredBy?: "scheduled" | "manual";
  startDate?: string;
  endDate?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  page?: number;
  limit?: number;
  refetchInterval?: number;
}

export function useBackupHistory(options: UseBackupHistoryOptions = {}) {
  const {
    enabled = true,
    status,
    triggeredBy,
    startDate,
    endDate,
    sortBy = "startedAt",
    sortOrder = "desc",
    page = 1,
    limit = 10,
    refetchInterval,
  } = options;

  const correlationId = generateCorrelationId();

  return useQuery({
    queryKey: [
      "backup-history",
      status,
      triggeredBy,
      startDate,
      endDate,
      sortBy,
      sortOrder,
      page,
      limit,
    ],
    queryFn: () =>
      fetchBackupHistory(
        { status, triggeredBy, startDate, endDate, sortBy, sortOrder, page, limit },
        correlationId
      ),
    enabled,
    refetchInterval,
    staleTime: 10000, // 10 seconds
    gcTime: 5 * 60 * 1000,
  });
}

export interface UseBackupHealthOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

export function useBackupHealth(options: UseBackupHealthOptions = {}) {
  const { enabled = true, refetchInterval: customRefetchInterval } = options;
  const queryClient = useQueryClient();
  const { connected } = useSocket();
  const correlationId = generateCorrelationId();

  // No polling when socket is connected (real-time updates via socket events);
  // fall back to 60s polling when disconnected
  const refetchInterval = customRefetchInterval ?? (connected ? false : 60000);

  // Subscribe to backup-health channel for real-time updates
  useSocketChannel(Channel.BACKUP_HEALTH, enabled);

  // Invalidate query when server pushes new backup health data
  useSocketEvent(
    ServerEvent.BACKUP_HEALTH_STATUS,
    () => {
      queryClient.invalidateQueries({ queryKey: ["backup-health"] });
    },
    enabled,
  );

  return useQuery({
    queryKey: ["backup-health"],
    queryFn: () => fetchBackupHealth(correlationId),
    enabled,
    refetchInterval,
    staleTime: 30000, // 30 seconds
    gcTime: 5 * 60 * 1000,
    refetchOnReconnect: true,
  });
}

// ====================
// Type Exports
// ====================

export type {
  SelfBackupInfo,
  SelfBackupConfig,
  SelfBackupConfigResponse,
  ScheduleInfo,
  BackupHealthStatus,
  BackupHealthResponse,
  TriggerBackupResponse,
  BackupHistoryResponse,
  UpdateSelfBackupConfigRequest,
};
