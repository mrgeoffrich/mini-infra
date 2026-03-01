import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  PermissionPresetRecord,
  CreatePermissionPresetRequest,
  UpdatePermissionPresetRequest,
} from "@mini-infra/types";

async function fetchPermissionPresets(): Promise<PermissionPresetRecord[]> {
  const response = await fetch("/api/permission-presets", {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch permission presets: ${response.statusText}`);
  }
  const data = await response.json();
  return data.data || [];
}

async function createPermissionPreset(
  data: CreatePermissionPresetRequest,
): Promise<PermissionPresetRecord> {
  const response = await fetch("/api/permission-presets", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `Failed to create permission preset: ${response.statusText}`);
  }
  const result = await response.json();
  return result.data;
}

async function updatePermissionPreset({
  id,
  ...data
}: { id: string } & UpdatePermissionPresetRequest): Promise<PermissionPresetRecord> {
  const response = await fetch(`/api/permission-presets/${id}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `Failed to update permission preset: ${response.statusText}`);
  }
  const result = await response.json();
  return result.data;
}

async function deletePermissionPreset(id: string): Promise<void> {
  const response = await fetch(`/api/permission-presets/${id}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.message || `Failed to delete permission preset: ${response.statusText}`);
  }
}

export function usePermissionPresets() {
  return useQuery({
    queryKey: ["permissionPresets"],
    queryFn: fetchPermissionPresets,
    retry: 1,
  });
}

export function useCreatePermissionPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createPermissionPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["permissionPresets"] });
    },
  });
}

export function useUpdatePermissionPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updatePermissionPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["permissionPresets"] });
    },
  });
}

export function useDeletePermissionPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePermissionPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["permissionPresets"] });
    },
  });
}
