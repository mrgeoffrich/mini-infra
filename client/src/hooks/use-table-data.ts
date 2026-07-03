import { useQuery } from "@tanstack/react-query";
import type {
  DatabaseTableListResponse,
  TableDataResponse,
  TableDataRequest,
} from "@mini-infra/types";
import { ApiRoute, queryKeys } from "@mini-infra/types";
import { apiFetch } from "@/lib/api-client";

// ====================
// Table Data API Functions
// ====================

async function fetchTables(
  serverId: string,
  databaseId: string,
): Promise<DatabaseTableListResponse> {
  return apiFetch<DatabaseTableListResponse>(
    ApiRoute.postgresServer.databaseTables(serverId, databaseId),
    { correlationIdPrefix: "table-data", unwrap: false },
  );
}

async function fetchTableData(
  serverId: string,
  databaseId: string,
  tableName: string,
  params: TableDataRequest,
): Promise<TableDataResponse> {
  // Build query string
  const queryParams = new URLSearchParams();
  if (params.page) queryParams.append("page", params.page.toString());
  if (params.pageSize) queryParams.append("pageSize", params.pageSize.toString());
  if (params.sortColumn) queryParams.append("sortColumn", params.sortColumn);
  if (params.sortDirection) queryParams.append("sortDirection", params.sortDirection);
  if (params.filters) queryParams.append("filters", JSON.stringify(params.filters));

  // ApiRoute.postgresServer.databaseTableData() doesn't encode its tableName
  // segment, so encode it here (as the pre-migration code did) before it
  // becomes part of the path.
  return apiFetch<TableDataResponse>(
    `${ApiRoute.postgresServer.databaseTableData(serverId, databaseId, encodeURIComponent(tableName))}?${queryParams}`,
    { correlationIdPrefix: "table-data", unwrap: false },
  );
}

// ====================
// React Query Hooks
// ====================

/**
 * Hook to fetch all tables in a database
 */
export function useDatabaseTables(
  serverId: string | undefined,
  databaseId: string | undefined
) {
  return useQuery({
    queryKey: queryKeys.postgresServer.tablesForDatabase(serverId ?? "", databaseId ?? ""),
    queryFn: () => fetchTables(serverId!, databaseId!),
    enabled: !!serverId && !!databaseId,
    staleTime: 60000, // Consider data fresh for 60 seconds
  });
}

/**
 * Hook to fetch paginated data from a table
 */
export function useTableData(
  serverId: string | undefined,
  databaseId: string | undefined,
  tableName: string | undefined,
  params: TableDataRequest
) {
  return useQuery({
    queryKey: queryKeys.postgresServer.tableData(
      serverId ?? "",
      databaseId ?? "",
      tableName ?? "",
      params,
    ),
    queryFn: () =>
      fetchTableData(serverId!, databaseId!, tableName!, params),
    enabled: !!serverId && !!databaseId && !!tableName,
    staleTime: 30000, // Consider data fresh for 30 seconds
    placeholderData: (previousData) => previousData, // Keep previous page data while fetching new page
  });
}
