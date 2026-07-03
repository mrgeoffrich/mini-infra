import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import type {
  PermissionPresetRecord,
  CreatePermissionPresetRequest,
  UpdatePermissionPresetRequest,
} from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

async function fetchPermissionPresets(): Promise<PermissionPresetRecord[]> {
  return (
    (await apiFetch<PermissionPresetRecord[]>(
      ApiRoute.permissionPresets.list(),
      { correlationIdPrefix: "permission-presets" },
    )) ?? []
  );
}

async function createPermissionPreset(
  data: CreatePermissionPresetRequest,
): Promise<PermissionPresetRecord> {
  return apiFetch<PermissionPresetRecord>(ApiRoute.permissionPresets.list(), {
    method: "POST",
    body: data,
    correlationIdPrefix: "permission-presets",
  });
}

async function updatePermissionPreset({
  id,
  ...data
}: { id: string } & UpdatePermissionPresetRequest): Promise<PermissionPresetRecord> {
  return apiFetch<PermissionPresetRecord>(ApiRoute.permissionPresets.get(id), {
    method: "PATCH",
    body: data,
    correlationIdPrefix: "permission-presets",
  });
}

async function deletePermissionPreset(id: string): Promise<void> {
  await apiFetch<void>(ApiRoute.permissionPresets.get(id), {
    method: "DELETE",
    correlationIdPrefix: "permission-presets",
  });
}

export function usePermissionPresets() {
  return useQuery({
    queryKey: queryKeys.permissionPresets.all,
    queryFn: fetchPermissionPresets,
    retry: 1,
  });
}

export function useCreatePermissionPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createPermissionPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.permissionPresets.all,
      });
    },
  });
}

export function useUpdatePermissionPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updatePermissionPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.permissionPresets.all,
      });
    },
  });
}

export function useDeletePermissionPreset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePermissionPreset,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.permissionPresets.all,
      });
    },
  });
}
