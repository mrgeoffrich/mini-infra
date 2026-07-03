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
  ApiRoute,
  queryKeys,
} from "@mini-infra/types";
import { useSocket, useSocketChannel, useSocketEvent } from "./use-socket";
import { apiFetch } from "@/lib/api-client";

// ====================
// Self-Backup Configuration API Functions
// ====================

async function fetchSelfBackupConfig(): Promise<SelfBackupConfigResponse> {
  return apiFetch<SelfBackupConfigResponse>(ApiRoute.settings.selfBackup(), {
    unwrap: false,
    correlationIdPrefix: "self-backup-config",
  });
}

async function updateSelfBackupConfig(
  config: UpdateSelfBackupConfigRequest,
): Promise<SelfBackupConfigResponse> {
  return apiFetch<SelfBackupConfigResponse>(ApiRoute.settings.selfBackup(), {
    method: "PUT",
    body: config,
    unwrap: false,
    correlationIdPrefix: "self-backup-config-update",
  });
}

async function enableSelfBackup(): Promise<{ success: boolean; message?: string }> {
  return apiFetch(ApiRoute.settings.selfBackupEnable(), {
    method: "POST",
    unwrap: false,
    correlationIdPrefix: "self-backup-enable",
  });
}

async function disableSelfBackup(): Promise<{ success: boolean; message?: string }> {
  return apiFetch(ApiRoute.settings.selfBackupDisable(), {
    method: "POST",
    unwrap: false,
    correlationIdPrefix: "self-backup-disable",
  });
}

async function triggerManualBackup(): Promise<TriggerBackupResponse> {
  return apiFetch<TriggerBackupResponse>(ApiRoute.settings.selfBackupTrigger(), {
    method: "POST",
    unwrap: false,
    correlationIdPrefix: "self-backup-trigger",
  });
}

async function fetchScheduleInfo(): Promise<{ success: boolean; scheduleInfo: ScheduleInfo | null }> {
  return apiFetch(ApiRoute.settings.selfBackupScheduleInfo(), {
    unwrap: false,
    correlationIdPrefix: "self-backup-schedule-info",
  });
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
): Promise<BackupHistoryResponse> {
  const url = new URL(ApiRoute.selfBackups.list(), window.location.origin);

  // Add query parameters
  if (params.status) url.searchParams.set("status", params.status);
  if (params.triggeredBy) url.searchParams.set("triggeredBy", params.triggeredBy);
  if (params.startDate) url.searchParams.set("startDate", params.startDate);
  if (params.endDate) url.searchParams.set("endDate", params.endDate);
  if (params.sortBy) url.searchParams.set("sortBy", params.sortBy);
  if (params.sortOrder) url.searchParams.set("sortOrder", params.sortOrder);
  if (params.page) url.searchParams.set("page", params.page.toString());
  if (params.limit) url.searchParams.set("limit", params.limit.toString());

  return apiFetch<BackupHistoryResponse>(url.toString(), {
    unwrap: false,
    correlationIdPrefix: "self-backup-history",
  });
}

async function fetchBackupHealth(): Promise<BackupHealthResponse> {
  return apiFetch<BackupHealthResponse>(ApiRoute.selfBackups.health(), {
    unwrap: false,
    correlationIdPrefix: "self-backup-health",
  });
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

  return useQuery({
    queryKey: queryKeys.selfBackup.config,
    queryFn: () => fetchSelfBackupConfig(),
    enabled,
    refetchInterval,
    staleTime: 30000, // 30 seconds
    gcTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useUpdateSelfBackupConfig() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (config: UpdateSelfBackupConfigRequest) =>
      updateSelfBackupConfig(config),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.config });
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.scheduleInfo });
    },
  });
}

export function useEnableSelfBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => enableSelfBackup(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.config });
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.scheduleInfo });
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.health });
    },
  });
}

export function useDisableSelfBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => disableSelfBackup(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.config });
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.scheduleInfo });
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.health });
    },
  });
}

export function useTriggerManualBackup() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: () => triggerManualBackup(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.historyAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.health });
    },
  });
}

export function useScheduleInfo(options: UseSelfBackupConfigOptions = {}) {
  const { enabled = true, refetchInterval = 60000 } = options; // Refresh every minute

  return useQuery({
    queryKey: queryKeys.selfBackup.scheduleInfo,
    queryFn: () => fetchScheduleInfo(),
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

  return useQuery({
    queryKey: queryKeys.selfBackup.history(
      status,
      triggeredBy,
      startDate,
      endDate,
      sortBy,
      sortOrder,
      page,
      limit,
    ),
    queryFn: () =>
      fetchBackupHistory({ status, triggeredBy, startDate, endDate, sortBy, sortOrder, page, limit }),
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

  // No polling when socket is connected (real-time updates via socket events);
  // fall back to 60s polling when disconnected
  const refetchInterval = customRefetchInterval ?? (connected ? false : 60000);

  // Subscribe to backup-health channel for real-time updates
  useSocketChannel(Channel.BACKUP_HEALTH, enabled);

  // Invalidate query when server pushes new backup health data
  useSocketEvent(
    ServerEvent.BACKUP_HEALTH_STATUS,
    () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.selfBackup.health });
    },
    enabled,
  );

  return useQuery({
    queryKey: queryKeys.selfBackup.health,
    queryFn: () => fetchBackupHealth(),
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
