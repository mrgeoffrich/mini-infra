import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  AzureContainerInfo,
  ConnectivityStatusFilter,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  StorageProviderId,
  ValidationResult,
} from "@mini-infra/types";

// ====================
// Storage settings types (provider-agnostic)
// ====================

export type StorageSlotKey =
  | "locations.postgres_backup"
  | "locations.self_backup"
  | "locations.tls_certificates";

export const STORAGE_SLOT_KEYS = {
  POSTGRES_BACKUP: "locations.postgres_backup",
  SELF_BACKUP: "locations.self_backup",
  TLS_CERTIFICATES: "locations.tls_certificates",
} as const satisfies Record<string, StorageSlotKey>;

export interface StorageLocationsByName {
  postgresBackup: string | null;
  selfBackup: string | null;
  tlsCertificates: string | null;
}

export interface StorageSettings {
  activeProviderId: StorageProviderId | null;
  locations: StorageLocationsByName;
}

export interface AzureProviderConfig {
  connectionConfigured: boolean;
  accountName: string | null;
  validationStatus: string | null;
  validationMessage: string | null;
  lastValidatedAt: string | null;
}

export interface UpdateAzureProviderInput {
  connectionString?: string;
  accountName?: string;
}

export interface ValidateAzureInput {
  connectionString?: string;
}

export interface GoogleDriveProviderConfig {
  clientIdConfigured: boolean;
  clientId: string | null;
  isConnected: boolean;
  accountEmail: string | null;
  tokenExpiresAt: string | null;
  validationStatus: string | null;
  validationMessage: string | null;
  lastValidatedAt: string | null;
}

export interface UpdateGoogleDriveProviderInput {
  clientId?: string;
  clientSecret?: string;
}

export interface GoogleDriveFolder {
  id: string;
  name: string;
  lastModified: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface GoogleDriveFolderList {
  accountEmail: string | null;
  folderCount: number;
  folders: GoogleDriveFolder[];
  hasMore: boolean;
}

export interface StorageLocationsList {
  accountName: string;
  locationCount: number;
  locations: AzureContainerInfo[];
  hasMore: boolean;
  nextMarker?: string;
}

export interface TestStorageLocationResult {
  id: string;
  displayName: string;
  accessible: boolean;
  lastModified?: string;
  metadata?: Record<string, unknown>;
}

// Generic table-filters state for the lifted object/location list. The
// fields are Azure-flavoured today (lease status, public access) — Drive in
// Phase 3 will broaden this where needed.
export interface StorageObjectFiltersState {
  namePrefix?: string;
  leaseStatus?: "locked" | "unlocked";
  leaseState?: "available" | "leased" | "expired" | "breaking" | "broken";
  publicAccess?: "container" | "blob" | null;
  hasMetadata?: boolean;
  lastModifiedAfter?: Date;
  lastModifiedBefore?: Date;
  sortBy: "name" | "lastModified" | "leaseStatus";
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

export interface StorageConnectivityFiltersState {
  status?: "connected" | "failed" | "timeout" | "unreachable";
  checkInitiatedBy?: string;
  startDate?: Date;
  endDate?: Date;
  sortBy: "checkedAt" | "status" | "responseTimeMs";
  sortOrder: "asc" | "desc";
  page: number;
  limit: number;
}

// ====================
// Helpers
// ====================

function generateCorrelationId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function jsonRequest<T>(
  url: string,
  init: RequestInit,
  correlationId: string,
): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
      ...(init.headers ?? {}),
    },
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `Request failed (${response.status} ${response.statusText}): ${text}`,
    );
  }
  return (await response.json()) as T;
}

// ====================
// API functions
// ====================

interface StorageSettingsApiResponse {
  success: boolean;
  data?: {
    activeProviderId: StorageProviderId | null;
    locations: StorageLocationsByName;
  };
  message?: string;
}

async function fetchStorageSettings(
  correlationId: string,
): Promise<StorageSettings> {
  const raw = await jsonRequest<StorageSettingsApiResponse>(
    `/api/storage`,
    { method: "GET" },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to fetch storage settings");
  }
  return raw.data;
}

async function putActiveProvider(
  providerId: StorageProviderId,
  correlationId: string,
): Promise<{ activeProviderId: StorageProviderId }> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: { activeProviderId: StorageProviderId };
    error?: string;
  }>(
    `/api/storage/active-provider`,
    {
      method: "PUT",
      body: JSON.stringify({ providerId }),
    },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.error || "Failed to update active storage provider");
  }
  return raw.data;
}

async function fetchAzureProviderConfig(
  correlationId: string,
): Promise<AzureProviderConfig> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: AzureProviderConfig;
    message?: string;
  }>(`/api/storage/azure`, { method: "GET" }, correlationId);
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to fetch Azure provider config");
  }
  return raw.data;
}

async function putAzureProviderConfig(
  body: UpdateAzureProviderInput,
  correlationId: string,
): Promise<AzureProviderConfig> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: { connectionConfigured: boolean; accountName: string | null };
    message?: string;
  }>(
    `/api/storage/azure`,
    {
      method: "PUT",
      body: JSON.stringify(body),
    },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to update Azure provider config");
  }
  return {
    connectionConfigured: raw.data.connectionConfigured,
    accountName: raw.data.accountName,
    validationStatus: null,
    validationMessage: null,
    lastValidatedAt: null,
  };
}

async function deleteAzureProviderConfig(
  correlationId: string,
): Promise<void> {
  const raw = await jsonRequest<{ success: boolean; message?: string }>(
    `/api/storage/azure`,
    { method: "DELETE" },
    correlationId,
  );
  if (!raw.success) {
    throw new Error(raw.message || "Failed to delete Azure provider config");
  }
}

async function postValidateAzure(
  body: ValidateAzureInput,
  correlationId: string,
): Promise<ValidationResult> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: ValidationResult;
    message?: string;
  }>(
    `/api/storage/azure/validate`,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to validate Azure connection");
  }
  return raw.data;
}

async function fetchAzureLocations(
  correlationId: string,
): Promise<StorageLocationsList> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: {
      accountName: string;
      containerCount: number;
      containers: AzureContainerInfo[];
      hasMore: boolean;
      nextMarker?: string;
    };
    message?: string;
  }>(`/api/storage/azure/locations`, { method: "GET" }, correlationId);
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to fetch storage locations");
  }
  return {
    accountName: raw.data.accountName,
    locationCount: raw.data.containerCount,
    locations: raw.data.containers,
    hasMore: raw.data.hasMore,
    nextMarker: raw.data.nextMarker,
  };
}

async function postTestAzureLocation(
  locationId: string,
  correlationId: string,
): Promise<TestStorageLocationResult> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: TestStorageLocationResult;
    message?: string;
  }>(
    `/api/storage/azure/test-location`,
    {
      method: "POST",
      body: JSON.stringify({ locationId }),
    },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to test storage location");
  }
  return raw.data;
}

// ----- Google Drive provider -----

async function fetchGoogleDriveProviderConfig(
  correlationId: string,
): Promise<GoogleDriveProviderConfig> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: GoogleDriveProviderConfig;
    message?: string;
  }>(`/api/storage/google-drive`, { method: "GET" }, correlationId);
  if (!raw.success || !raw.data) {
    throw new Error(
      raw.message || "Failed to fetch Google Drive provider config",
    );
  }
  return raw.data;
}

async function putGoogleDriveProviderConfig(
  body: UpdateGoogleDriveProviderInput,
  correlationId: string,
): Promise<GoogleDriveProviderConfig> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: GoogleDriveProviderConfig;
    message?: string;
  }>(
    `/api/storage/google-drive`,
    { method: "PUT", body: JSON.stringify(body) },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(
      raw.message || "Failed to update Google Drive provider config",
    );
  }
  // Server returns a partial shape — round-trip through GET so we always
  // surface the full provider state.
  return await fetchGoogleDriveProviderConfig(correlationId);
}

async function deleteGoogleDriveProviderConfig(
  correlationId: string,
): Promise<void> {
  const raw = await jsonRequest<{ success: boolean; message?: string }>(
    `/api/storage/google-drive`,
    { method: "DELETE" },
    correlationId,
  );
  if (!raw.success) {
    throw new Error(
      raw.message || "Failed to delete Google Drive provider config",
    );
  }
}

async function postDisconnectGoogleDrive(correlationId: string): Promise<void> {
  const raw = await jsonRequest<{ success: boolean; message?: string }>(
    `/api/storage/google-drive/disconnect`,
    { method: "POST", body: JSON.stringify({}) },
    correlationId,
  );
  if (!raw.success) {
    throw new Error(raw.message || "Failed to disconnect Google Drive");
  }
}

async function fetchGoogleDriveFolders(
  correlationId: string,
): Promise<GoogleDriveFolderList> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: GoogleDriveFolderList;
    message?: string;
  }>(`/api/storage/google-drive/locations`, { method: "GET" }, correlationId);
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to fetch Google Drive folders");
  }
  return raw.data;
}

async function postTestGoogleDriveLocation(
  locationId: string,
  correlationId: string,
): Promise<TestStorageLocationResult> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: TestStorageLocationResult;
    message?: string;
  }>(
    `/api/storage/google-drive/test-location`,
    {
      method: "POST",
      body: JSON.stringify({ locationId }),
    },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to test Google Drive folder");
  }
  return raw.data;
}

async function postCreateGoogleDriveFolder(
  name: string,
  correlationId: string,
): Promise<{ id: string; displayName: string }> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: { id: string; displayName: string };
    message?: string;
  }>(
    `/api/storage/google-drive/create-folder`,
    {
      method: "POST",
      body: JSON.stringify({ name }),
    },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to create Google Drive folder");
  }
  return raw.data;
}

async function putStorageLocation(
  slot: StorageSlotKey,
  locationId: string,
  correlationId: string,
): Promise<{ slot: StorageSlotKey; locationId: string }> {
  const raw = await jsonRequest<{
    success: boolean;
    data?: { slot: StorageSlotKey; locationId: string };
    error?: string;
  }>(
    `/api/storage/locations/${encodeURIComponent(slot)}`,
    {
      method: "PUT",
      body: JSON.stringify({ locationId }),
    },
    correlationId,
  );
  if (!raw.success || !raw.data) {
    throw new Error(raw.error || "Failed to update storage location");
  }
  return raw.data;
}

async function fetchStorageConnectivity(
  correlationId: string,
): Promise<ConnectivityStatusInfo> {
  const response = await fetch(`/api/connectivity/storage`, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });
  if (!response.ok) {
    if (response.status === 404) {
      return {
        id: "no-status",
        service: "storage",
        status: "unreachable",
        responseTimeMs: null,
        errorMessage: "No connectivity status available",
        errorCode: null,
        lastSuccessfulAt: null,
        checkedAt: new Date().toISOString(),
        checkInitiatedBy: "system",
        metadata: null,
      };
    }
    throw new Error(
      `Failed to fetch storage connectivity status: ${response.statusText}`,
    );
  }
  const data = (await response.json()) as {
    success: boolean;
    data?: ConnectivityStatusInfo;
    message?: string;
  };
  if (!data.success || !data.data) {
    throw new Error(
      data.message || "Failed to fetch storage connectivity status",
    );
  }
  return data.data;
}

async function fetchStorageConnectivityHistory(
  filters: ConnectivityStatusFilter,
  page: number,
  limit: number,
  sortBy: "checkedAt" | "status" | "responseTimeMs",
  sortOrder: "asc" | "desc",
  correlationId: string,
): Promise<ConnectivityStatusListResponse> {
  const url = new URL(
    `/api/connectivity/storage/history`,
    window.location.origin,
  );
  url.searchParams.set("page", page.toString());
  url.searchParams.set("limit", limit.toString());
  url.searchParams.set("sortBy", sortBy);
  url.searchParams.set("sortOrder", sortOrder);
  if (filters.status) url.searchParams.set("status", filters.status);
  if (filters.checkInitiatedBy)
    url.searchParams.set("checkInitiatedBy", filters.checkInitiatedBy);
  if (filters.startDate)
    url.searchParams.set("startDate", filters.startDate.toISOString());
  if (filters.endDate)
    url.searchParams.set("endDate", filters.endDate.toISOString());

  const response = await fetch(url.toString(), {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch storage connectivity history: ${response.statusText}`,
    );
  }
  const data = (await response.json()) as ConnectivityStatusListResponse;
  if (!data.success) {
    throw new Error(
      data.message || "Failed to fetch storage connectivity history",
    );
  }
  return data;
}

// ====================
// Hooks
// ====================

export interface StorageSwitchPrecheckInFlightOp {
  id: string;
  type: string;
  status: string;
  startedAt: string;
}

export interface StorageSwitchPrecheck {
  activeCerts: {
    count: number;
    soonestExpiryDays: number | null;
    anyWithin30Days: boolean;
  };
  acme: { hasInFlightChallenge: boolean };
  selfBackupHistoryCount: number;
  postgresBackupHistoryCount: number;
  inFlightOperations: StorageSwitchPrecheckInFlightOp[];
  canSwitch: boolean;
  blockReasons: string[];
  warnings: string[];
}

export interface ForgetProviderResult {
  provider: StorageProviderId;
  referencingRowCount: number;
  deletedConfigRowCount: number;
  forced: boolean;
}

async function fetchStorageSwitchPrecheck(
  targetProvider: StorageProviderId,
  correlationId: string,
): Promise<StorageSwitchPrecheck> {
  const url = new URL(
    `/api/storage/switch-precheck`,
    window.location.origin,
  );
  url.searchParams.set("targetProvider", targetProvider);
  const raw = await jsonRequest<{
    success: boolean;
    data?: StorageSwitchPrecheck;
    message?: string;
  }>(url.pathname + url.search, { method: "GET" }, correlationId);
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to compute switch precheck");
  }
  return raw.data;
}

async function postForgetProvider(
  provider: StorageProviderId,
  force: boolean,
  correlationId: string,
): Promise<ForgetProviderResult> {
  const url = new URL(
    `/api/storage/${encodeURIComponent(provider)}/forget`,
    window.location.origin,
  );
  if (force) url.searchParams.set("force", "true");
  const response = await fetch(url.pathname + url.search, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Correlation-ID": correlationId,
    },
    body: JSON.stringify({}),
  });
  const json = (await response.json().catch(() => ({}))) as {
    success?: boolean;
    error?: string;
    message?: string;
    data?: ForgetProviderResult & { referencingRowCount?: number };
  };
  if (!response.ok || !json.success) {
    const detail = json.message || json.error || `HTTP ${response.status}`;
    const err = new Error(detail) as Error & {
      status?: number;
      data?: typeof json.data;
      code?: string;
    };
    err.status = response.status;
    err.data = json.data;
    err.code = json.error;
    throw err;
  }
  if (!json.data) {
    throw new Error("Forget provider response missing data");
  }
  return json.data;
}

export function useStorageSwitchPrecheck(
  targetProvider: StorageProviderId | null,
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ["storage", "switch-precheck", targetProvider],
    queryFn: () =>
      fetchStorageSwitchPrecheck(
        targetProvider as StorageProviderId,
        generateCorrelationId("storage-precheck"),
      ),
    enabled: enabled && targetProvider !== null,
    staleTime: 0,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
  });
}

export function useForgetStorageProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      provider,
      force,
    }: {
      provider: StorageProviderId;
      force?: boolean;
    }) =>
      postForgetProvider(
        provider,
        !!force,
        generateCorrelationId("storage-forget"),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

export interface UseStorageSettingsOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

export function useStorageSettings(options: UseStorageSettingsOptions = {}) {
  const { enabled = true, refetchInterval } = options;
  return useQuery({
    queryKey: ["storage", "settings"],
    queryFn: () => fetchStorageSettings(generateCorrelationId("storage")),
    enabled,
    refetchInterval,
    staleTime: 5_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useUpdateActiveProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (providerId: StorageProviderId) =>
      putActiveProvider(providerId, generateCorrelationId("storage")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
  });
}

export function useUpdateStorageLocation(slot: StorageSlotKey) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (locationId: string) =>
      putStorageLocation(slot, locationId, generateCorrelationId("storage")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage", "settings"] });
    },
  });
}

export function useAzureProviderConfig(
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ["storage", "azure", "config"],
    queryFn: () =>
      fetchAzureProviderConfig(generateCorrelationId("storage-azure")),
    enabled,
    staleTime: 5_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useUpdateAzureProviderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateAzureProviderInput) =>
      putAzureProviderConfig(body, generateCorrelationId("storage-azure")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

export function useDeleteAzureProviderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      deleteAzureProviderConfig(generateCorrelationId("storage-azure")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      queryClient.removeQueries({ queryKey: ["storage", "azure", "locations"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

export function useValidateAzureConnection() {
  return useMutation({
    mutationFn: (body: ValidateAzureInput = {}) =>
      postValidateAzure(body, generateCorrelationId("storage-azure")),
  });
}

export interface UseStorageLocationsListOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/**
 * List the available storage locations (Azure containers / Drive folders) for
 * the given provider. Returns an Azure-shaped `StorageLocationsList` for the
 * Azure provider; the Google Drive provider has its own dedicated hook
 * (`useGoogleDriveFolders`) that returns folder-shaped rows.
 */
export function useStorageLocationsList(
  provider: StorageProviderId,
  options: UseStorageLocationsListOptions = {},
) {
  const { enabled = true, refetchInterval } = options;
  return useQuery({
    queryKey: ["storage", provider, "locations"],
    queryFn: () => fetchAzureLocations(generateCorrelationId("storage-azure")),
    enabled: enabled && provider === "azure",
    refetchInterval,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function useTestStorageLocationAccess(provider: StorageProviderId) {
  return useMutation({
    mutationFn: (locationId: string) => {
      if (provider === "azure") {
        return postTestAzureLocation(
          locationId,
          generateCorrelationId("storage-azure"),
        );
      }
      return postTestGoogleDriveLocation(
        locationId,
        generateCorrelationId("storage-google-drive"),
      );
    },
  });
}

// ----- Google Drive hooks -----

export function useGoogleDriveProviderConfig(
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ["storage", "google-drive", "config"],
    queryFn: () =>
      fetchGoogleDriveProviderConfig(
        generateCorrelationId("storage-google-drive"),
      ),
    enabled,
    staleTime: 5_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export function useUpdateGoogleDriveProviderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateGoogleDriveProviderInput) =>
      putGoogleDriveProviderConfig(
        body,
        generateCorrelationId("storage-google-drive"),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

export function useDeleteGoogleDriveProviderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      deleteGoogleDriveProviderConfig(
        generateCorrelationId("storage-google-drive"),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage"] });
      queryClient.invalidateQueries({ queryKey: ["connectivityStatus"] });
    },
  });
}

export function useDisconnectGoogleDrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      postDisconnectGoogleDrive(generateCorrelationId("storage-google-drive")),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["storage", "google-drive"] });
      queryClient.invalidateQueries({ queryKey: ["storage", "settings"] });
      queryClient.invalidateQueries({ queryKey: ["storage", "connectivity"] });
    },
  });
}

/**
 * Returns the URL the operator should be redirected to in order to start the
 * Google OAuth dance. The route 302s straight to Google's authorize page and
 * Google redirects back to `/api/storage/google-drive/oauth/callback` which
 * itself redirects back to `/connectivity-storage?google-drive=connected`.
 */
export function useStartGoogleDriveOAuth() {
  return {
    authorizeUrl: "/api/storage/google-drive/oauth/start",
  };
}

export function useGoogleDriveFolders(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: ["storage", "google-drive", "folders"],
    queryFn: () =>
      fetchGoogleDriveFolders(generateCorrelationId("storage-google-drive")),
    enabled,
    staleTime: 30_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

export function useCreateGoogleDriveFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      postCreateGoogleDriveFolder(
        name,
        generateCorrelationId("storage-google-drive"),
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["storage", "google-drive", "folders"],
      });
    },
  });
}

export interface UseStorageConnectivityOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

export function useStorageConnectivity(
  options: UseStorageConnectivityOptions = {},
) {
  const { enabled = true, refetchInterval = 30_000 } = options;
  return useQuery({
    queryKey: ["storage", "connectivity"],
    queryFn: () =>
      fetchStorageConnectivity(generateCorrelationId("storage-conn")),
    enabled,
    refetchInterval,
    staleTime: 10_000,
    gcTime: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });
}

export interface UseStorageConnectivityHistoryOptions {
  enabled?: boolean;
  filters?: ConnectivityStatusFilter;
  page?: number;
  limit?: number;
  sortBy?: "checkedAt" | "status" | "responseTimeMs";
  sortOrder?: "asc" | "desc";
}

export function useStorageConnectivityHistory(
  options: UseStorageConnectivityHistoryOptions = {},
) {
  const {
    enabled = true,
    filters = {},
    page = 1,
    limit = 20,
    sortBy = "checkedAt",
    sortOrder = "desc",
  } = options;
  return useQuery({
    queryKey: [
      "storage",
      "connectivity",
      "history",
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ],
    queryFn: () =>
      fetchStorageConnectivityHistory(
        filters,
        page,
        limit,
        sortBy,
        sortOrder,
        generateCorrelationId("storage-conn-hist"),
      ),
    enabled,
    staleTime: 30_000,
    gcTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: true,
  });
}

// ====================
// Filter state hooks
// ====================

export function useStorageObjectFilters(
  initialFilters: Partial<StorageObjectFiltersState> = {},
) {
  const [filters, setFilters] = useState<StorageObjectFiltersState>({
    sortBy: "name",
    sortOrder: "asc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof StorageObjectFiltersState>(
      key: K,
      value: StorageObjectFiltersState[K],
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        page: key === "page" ? (value as number) : 1,
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      sortBy: "name",
      sortOrder: "asc",
      page: 1,
      limit: 20,
      ...initialFilters,
    });
  }, [initialFilters]);

  return { filters, updateFilter, resetFilters };
}

export function useStorageConnectivityFilters(
  initialFilters: Partial<StorageConnectivityFiltersState> = {},
) {
  const [filters, setFilters] = useState<StorageConnectivityFiltersState>({
    sortBy: "checkedAt",
    sortOrder: "desc",
    page: 1,
    limit: 20,
    ...initialFilters,
  });

  const updateFilter = useCallback(
    <K extends keyof StorageConnectivityFiltersState>(
      key: K,
      value: StorageConnectivityFiltersState[K],
    ) => {
      setFilters((prev) => ({
        ...prev,
        [key]: value,
        page: key === "page" ? (value as number) : 1,
      }));
    },
    [],
  );

  const resetFilters = useCallback(() => {
    setFilters({
      sortBy: "checkedAt",
      sortOrder: "desc",
      page: 1,
      limit: 20,
      ...initialFilters,
    });
  }, [initialFilters]);

  return { filters, updateFilter, resetFilters };
}
