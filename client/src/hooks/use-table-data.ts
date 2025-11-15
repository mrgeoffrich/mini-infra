import { useQuery } from "@tanstack/react-query";
import type {
  DatabaseTableListResponse,
  TableDataResponse,
  TableDataRequest,
} from "@mini-infra/types";

// Generate correlation ID for debugging
function generateCorrelationId(): string {
  return `table-data-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// ====================
// Table Data API Functions
// ====================

async function fetchTables(
  serverId: string,
  databaseId: string,
  correlationId: string
): Promise<DatabaseTableListResponse> {
  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/${databaseId}/tables`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch tables: ${response.statusText}`);
  }

  const data: DatabaseTableListResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch tables");
  }

  return data;
}

async function fetchTableData(
  serverId: string,
  databaseId: string,
  tableName: string,
  params: TableDataRequest,
  correlationId: string
): Promise<TableDataResponse> {
  // Build query string
  const queryParams = new URLSearchParams();
  if (params.page) queryParams.append("page", params.page.toString());
  if (params.pageSize) queryParams.append("pageSize", params.pageSize.toString());
  if (params.sortColumn) queryParams.append("sortColumn", params.sortColumn);
  if (params.sortDirection) queryParams.append("sortDirection", params.sortDirection);
  if (params.filters) queryParams.append("filters", JSON.stringify(params.filters));

  const response = await fetch(
    `/api/postgres-server/servers/${serverId}/databases/${databaseId}/tables/${encodeURIComponent(tableName)}/data?${queryParams}`,
    {
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-ID": correlationId,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch table data: ${response.statusText}`);
  }

  const data: TableDataResponse = await response.json();

  if (!data.success) {
    throw new Error(data.message || "Failed to fetch table data");
  }

  return data;
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
    queryKey: ["postgres-servers", serverId, "databases", databaseId, "tables"],
    queryFn: () => fetchTables(serverId!, databaseId!, generateCorrelationId()),
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
    queryKey: [
      "postgres-servers",
      serverId,
      "databases",
      databaseId,
      "tables",
      tableName,
      "data",
      params,
    ],
    queryFn: () =>
      fetchTableData(serverId!, databaseId!, tableName!, params, generateCorrelationId()),
    enabled: !!serverId && !!databaseId && !!tableName,
    staleTime: 30000, // Consider data fresh for 30 seconds
    keepPreviousData: true, // Keep previous page data while fetching new page
  });
}
