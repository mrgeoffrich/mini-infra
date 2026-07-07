import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import {
  ApiRoute,
  queryKeys,
  AzureContainerInfo,
  ConnectivityStatusFilter,
  ConnectivityStatusInfo,
  ConnectivityStatusListResponse,
  StorageProviderId,
  ValidationResult,
} from "@mini-infra/types";
import { apiFetch, ApiRequestError } from "@/lib/api-client";

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

async function fetchStorageSettings(): Promise<StorageSettings> {
  const raw = await apiFetch<StorageSettingsApiResponse>(ApiRoute.storage.root(), {
    correlationIdPrefix: "storage",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to fetch storage settings");
  }
  return raw.data;
}

async function putActiveProvider(
  providerId: StorageProviderId,
): Promise<{ activeProviderId: StorageProviderId }> {
  const raw = await apiFetch<{
    success: boolean;
    data?: { activeProviderId: StorageProviderId };
    error?: string;
  }>(ApiRoute.storage.activeProvider(), {
    method: "PUT",
    body: { providerId },
    correlationIdPrefix: "storage",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.error || "Failed to update active storage provider");
  }
  return raw.data;
}

async function fetchAzureProviderConfig(): Promise<AzureProviderConfig> {
  const raw = await apiFetch<{
    success: boolean;
    data?: AzureProviderConfig;
    message?: string;
  }>(ApiRoute.storage.azure(), {
    correlationIdPrefix: "storage-azure",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to fetch Azure provider config");
  }
  return raw.data;
}

async function putAzureProviderConfig(
  body: UpdateAzureProviderInput,
): Promise<AzureProviderConfig> {
  const raw = await apiFetch<{
    success: boolean;
    data?: { connectionConfigured: boolean; accountName: string | null };
    message?: string;
  }>(ApiRoute.storage.azure(), {
    method: "PUT",
    body,
    correlationIdPrefix: "storage-azure",
    unwrap: false,
  });
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

async function deleteAzureProviderConfig(): Promise<void> {
  const raw = await apiFetch<{ success: boolean; message?: string }>(
    ApiRoute.storage.azure(),
    { method: "DELETE", correlationIdPrefix: "storage-azure", unwrap: false },
  );
  if (!raw.success) {
    throw new Error(raw.message || "Failed to delete Azure provider config");
  }
}

async function postValidateAzure(
  body: ValidateAzureInput,
): Promise<ValidationResult> {
  const raw = await apiFetch<{
    success: boolean;
    data?: ValidationResult;
    message?: string;
  }>(ApiRoute.storage.azureValidate(), {
    method: "POST",
    body,
    correlationIdPrefix: "storage-azure",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to validate Azure connection");
  }
  return raw.data;
}

async function fetchAzureLocations(): Promise<StorageLocationsList> {
  const raw = await apiFetch<{
    success: boolean;
    data?: {
      accountName: string;
      containerCount: number;
      containers: AzureContainerInfo[];
      hasMore: boolean;
      nextMarker?: string;
    };
    message?: string;
  }>(ApiRoute.storage.azureLocations(), {
    correlationIdPrefix: "storage-azure",
    unwrap: false,
  });
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
): Promise<TestStorageLocationResult> {
  const raw = await apiFetch<{
    success: boolean;
    data?: TestStorageLocationResult;
    message?: string;
  }>(ApiRoute.storage.azureTestLocation(), {
    method: "POST",
    body: { locationId },
    correlationIdPrefix: "storage-azure",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to test storage location");
  }
  return raw.data;
}

// ----- Google Drive provider -----

async function fetchGoogleDriveProviderConfig(): Promise<GoogleDriveProviderConfig> {
  const raw = await apiFetch<{
    success: boolean;
    data?: GoogleDriveProviderConfig;
    message?: string;
  }>(ApiRoute.storage.googleDrive(), {
    correlationIdPrefix: "storage-google-drive",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(
      raw.message || "Failed to fetch Google Drive provider config",
    );
  }
  return raw.data;
}

async function putGoogleDriveProviderConfig(
  body: UpdateGoogleDriveProviderInput,
): Promise<GoogleDriveProviderConfig> {
  const raw = await apiFetch<{
    success: boolean;
    data?: GoogleDriveProviderConfig;
    message?: string;
  }>(ApiRoute.storage.googleDrive(), {
    method: "PUT",
    body,
    correlationIdPrefix: "storage-google-drive",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(
      raw.message || "Failed to update Google Drive provider config",
    );
  }
  // Server returns a partial shape — round-trip through GET so we always
  // surface the full provider state.
  return await fetchGoogleDriveProviderConfig();
}

async function deleteGoogleDriveProviderConfig(): Promise<void> {
  const raw = await apiFetch<{ success: boolean; message?: string }>(
    ApiRoute.storage.googleDrive(),
    { method: "DELETE", correlationIdPrefix: "storage-google-drive", unwrap: false },
  );
  if (!raw.success) {
    throw new Error(
      raw.message || "Failed to delete Google Drive provider config",
    );
  }
}

async function postDisconnectGoogleDrive(): Promise<void> {
  const raw = await apiFetch<{ success: boolean; message?: string }>(
    ApiRoute.storage.googleDriveDisconnect(),
    {
      method: "POST",
      body: {},
      correlationIdPrefix: "storage-google-drive",
      unwrap: false,
    },
  );
  if (!raw.success) {
    throw new Error(raw.message || "Failed to disconnect Google Drive");
  }
}

async function fetchGoogleDriveFolders(): Promise<GoogleDriveFolderList> {
  const raw = await apiFetch<{
    success: boolean;
    data?: GoogleDriveFolderList;
    message?: string;
  }>(ApiRoute.storage.googleDriveLocations(), {
    correlationIdPrefix: "storage-google-drive",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to fetch Google Drive folders");
  }
  return raw.data;
}

async function postTestGoogleDriveLocation(
  locationId: string,
): Promise<TestStorageLocationResult> {
  const raw = await apiFetch<{
    success: boolean;
    data?: TestStorageLocationResult;
    message?: string;
  }>(ApiRoute.storage.googleDriveTestLocation(), {
    method: "POST",
    body: { locationId },
    correlationIdPrefix: "storage-google-drive",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to test Google Drive folder");
  }
  return raw.data;
}

async function postCreateGoogleDriveFolder(
  name: string,
): Promise<{ id: string; displayName: string }> {
  const raw = await apiFetch<{
    success: boolean;
    data?: { id: string; displayName: string };
    message?: string;
  }>(ApiRoute.storage.googleDriveCreateFolder(), {
    method: "POST",
    body: { name },
    correlationIdPrefix: "storage-google-drive",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to create Google Drive folder");
  }
  return raw.data;
}

async function putStorageLocation(
  slot: StorageSlotKey,
  locationId: string,
): Promise<{ slot: StorageSlotKey; locationId: string }> {
  const raw = await apiFetch<{
    success: boolean;
    data?: { slot: StorageSlotKey; locationId: string };
    error?: string;
  }>(ApiRoute.storage.location(encodeURIComponent(slot)), {
    method: "PUT",
    body: { locationId },
    correlationIdPrefix: "storage",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.error || "Failed to update storage location");
  }
  return raw.data;
}

async function fetchStorageConnectivity(): Promise<ConnectivityStatusInfo> {
  try {
    const data = await apiFetch<{
      success: boolean;
      data?: ConnectivityStatusInfo;
      message?: string;
    }>(ApiRoute.connectivity.storage(), {
      correlationIdPrefix: "storage-conn",
      unwrap: false,
    });
    if (!data.success || !data.data) {
      throw new Error(
        data.message || "Failed to fetch storage connectivity status",
      );
    }
    return data.data;
  } catch (err) {
    if (err instanceof ApiRequestError && err.status === 404) {
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
    throw err;
  }
}

async function fetchStorageConnectivityHistory(
  filters: ConnectivityStatusFilter,
  page: number,
  limit: number,
  sortBy: "checkedAt" | "status" | "responseTimeMs",
  sortOrder: "asc" | "desc",
): Promise<ConnectivityStatusListResponse> {
  const url = new URL(ApiRoute.connectivity.storageHistory(), window.location.origin);
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

  const data = await apiFetch<ConnectivityStatusListResponse>(
    url.pathname + url.search,
    { correlationIdPrefix: "storage-conn-hist", unwrap: false },
  );
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
): Promise<StorageSwitchPrecheck> {
  const url = new URL(ApiRoute.storage.switchPrecheck(), window.location.origin);
  url.searchParams.set("targetProvider", targetProvider);
  const raw = await apiFetch<{
    success: boolean;
    data?: StorageSwitchPrecheck;
    message?: string;
  }>(url.pathname + url.search, {
    correlationIdPrefix: "storage-precheck",
    unwrap: false,
  });
  if (!raw.success || !raw.data) {
    throw new Error(raw.message || "Failed to compute switch precheck");
  }
  return raw.data;
}

type ForgetProviderDetails = ForgetProviderResult & { referencingRowCount?: number };

type ForgetProviderEnvelope = {
  success?: boolean;
  error?: string;
  message?: string;
  /** Success-path payload — `{ success: true, data: {...} }`. */
  data?: ForgetProviderDetails;
  /**
   * Error-path payload from the central error middleware's envelope
   * (`server/src/lib/error-handler.ts`) — `409 PROVIDER_HAS_REFERENCING_ROWS`
   * carries the referencing-row breakdown here, not in `data`.
   */
  details?: ForgetProviderDetails;
};

/** Throws an `Error` shaped exactly like the pre-migration `postForgetProvider`
 * error (`.status`/`.data`/`.code`) — `StorageForgetProviderButton.tsx` (outside
 * this migration batch) reads those fields directly off the caught error. */
function throwForgetError(
  status: number,
  code: string | undefined,
  message: string,
  data: ForgetProviderDetails | undefined,
): never {
  const err = new Error(message) as Error & {
    status?: number;
    data?: ForgetProviderDetails;
    code?: string;
  };
  err.status = status;
  err.data = data;
  err.code = code;
  throw err;
}

async function postForgetProvider(
  provider: StorageProviderId,
  force: boolean,
): Promise<ForgetProviderResult> {
  const url = new URL(ApiRoute.storage.forget(provider), window.location.origin);
  if (force) url.searchParams.set("force", "true");

  let json: ForgetProviderEnvelope;
  try {
    json = await apiFetch<ForgetProviderEnvelope>(url.pathname + url.search, {
      method: "POST",
      body: {},
      correlationIdPrefix: "storage-forget",
      unwrap: false,
    });
  } catch (err) {
    if (err instanceof ApiRequestError) {
      const body = err.body as ForgetProviderEnvelope | undefined;
      throwForgetError(
        err.status,
        body?.error ?? err.code,
        body?.message || body?.error || err.message,
        body?.details,
      );
    }
    throw err;
  }

  if (!json.success) {
    throwForgetError(
      200,
      json.error,
      json.message || json.error || "Request failed",
      json.data,
    );
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
    queryKey: queryKeys.storage.switchPrecheck(targetProvider),
    queryFn: () => fetchStorageSwitchPrecheck(targetProvider as StorageProviderId),
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
    }) => postForgetProvider(provider, !!force),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
    // StorageForgetProviderButton.tsx always renders this mutation's errors
    // itself — the initial probe's 409 drives the "needs-ack" warning card,
    // and the force-confirm failure shows its own toast — so opt out of the
    // global default to avoid a redundant second toast.
    meta: { skipErrorToast: true },
  });
}

export interface UseStorageSettingsOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

export function useStorageSettings(options: UseStorageSettingsOptions = {}) {
  const { enabled = true, refetchInterval } = options;
  return useQuery({
    queryKey: queryKeys.settings.storageSettings,
    queryFn: () => fetchStorageSettings(),
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
    mutationFn: (providerId: StorageProviderId) => putActiveProvider(providerId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.all });
    },
  });
}

export function useUpdateStorageLocation(slot: StorageSlotKey) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (locationId: string) => putStorageLocation(slot, locationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.storageSettings });
    },
  });
}

export function useAzureProviderConfig(
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: queryKeys.storage.azureConfig,
    queryFn: () => fetchAzureProviderConfig(),
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
    mutationFn: (body: UpdateAzureProviderInput) => putAzureProviderConfig(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

export function useDeleteAzureProviderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteAzureProviderConfig(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.all });
      queryClient.removeQueries({ queryKey: queryKeys.storage.azureLocations });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

export function useValidateAzureConnection() {
  return useMutation({
    mutationFn: (body: ValidateAzureInput = {}) => postValidateAzure(body),
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
    queryKey: queryKeys.storage.locations(provider),
    queryFn: () => fetchAzureLocations(),
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
        return postTestAzureLocation(locationId);
      }
      return postTestGoogleDriveLocation(locationId);
    },
  });
}

// ----- Google Drive hooks -----

export function useGoogleDriveProviderConfig(
  options: { enabled?: boolean } = {},
) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: queryKeys.storage.googleDriveConfig,
    queryFn: () => fetchGoogleDriveProviderConfig(),
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
      putGoogleDriveProviderConfig(body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

export function useDeleteGoogleDriveProviderConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => deleteGoogleDriveProviderConfig(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.connectivity.status });
    },
  });
}

export function useDisconnectGoogleDrive() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => postDisconnectGoogleDrive(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.googleDriveAll });
      queryClient.invalidateQueries({ queryKey: queryKeys.settings.storageSettings });
      queryClient.invalidateQueries({ queryKey: queryKeys.storage.connectivity });
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
    authorizeUrl: ApiRoute.storage.googleDriveOauthStart(),
  };
}

export function useGoogleDriveFolders(options: { enabled?: boolean } = {}) {
  const { enabled = true } = options;
  return useQuery({
    queryKey: queryKeys.storage.googleDriveFolders,
    queryFn: () => fetchGoogleDriveFolders(),
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
    mutationFn: (name: string) => postCreateGoogleDriveFolder(name),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.storage.googleDriveFolders,
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
    queryKey: queryKeys.storage.connectivity,
    queryFn: () => fetchStorageConnectivity(),
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
    queryKey: queryKeys.storage.connectivityHistory(
      filters,
      page,
      limit,
      sortBy,
      sortOrder,
    ),
    queryFn: () =>
      fetchStorageConnectivityHistory(filters, page, limit, sortBy, sortOrder),
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
