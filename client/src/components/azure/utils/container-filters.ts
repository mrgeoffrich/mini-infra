import { AzureContainerInfo } from "@mini-infra/types";
import { AzureContainerFiltersState } from "@/hooks/use-azure-settings";

/**
 * Filter and sort containers based on filter criteria
 */
export function filterAndSortContainers(
  containers: AzureContainerInfo[],
  filters: AzureContainerFiltersState,
): AzureContainerInfo[] {
  let filtered = [...containers];

  // Apply name prefix filter
  if (filters.namePrefix) {
    const prefix = filters.namePrefix.toLowerCase();
    filtered = filtered.filter((container) =>
      container.name.toLowerCase().startsWith(prefix),
    );
  }

  // Apply lease status filter
  if (filters.leaseStatus) {
    filtered = filtered.filter(
      (container) => container.leaseStatus === filters.leaseStatus,
    );
  }

  // Apply public access filter
  if (filters.publicAccess !== undefined) {
    filtered = filtered.filter(
      (container) => container.publicAccess === filters.publicAccess,
    );
  }

  // Apply metadata filter
  if (filters.hasMetadata !== undefined) {
    filtered = filtered.filter((container) => {
      const hasMetadata =
        container.metadata && Object.keys(container.metadata).length > 0;
      return filters.hasMetadata ? hasMetadata : !hasMetadata;
    });
  }

  // Apply date range filters
  if (filters.lastModifiedAfter || filters.lastModifiedBefore) {
    filtered = filtered.filter((container) => {
      const containerDate = new Date(container.lastModified);
      if (
        filters.lastModifiedAfter &&
        containerDate < filters.lastModifiedAfter
      ) {
        return false;
      }
      if (
        filters.lastModifiedBefore &&
        containerDate > filters.lastModifiedBefore
      ) {
        return false;
      }
      return true;
    });
  }

  // Apply sorting
  filtered.sort((a, b) => {
    let aValue: string | Date;
    let bValue: string | Date;

    switch (filters.sortBy) {
      case "name":
        aValue = a.name;
        bValue = b.name;
        break;
      case "lastModified":
        aValue = new Date(a.lastModified);
        bValue = new Date(b.lastModified);
        break;
      case "leaseStatus":
        aValue = a.leaseStatus;
        bValue = b.leaseStatus;
        break;
      default:
        aValue = a.name;
        bValue = b.name;
    }

    if (aValue < bValue) return filters.sortOrder === "asc" ? -1 : 1;
    if (aValue > bValue) return filters.sortOrder === "asc" ? 1 : -1;
    return 0;
  });

  return filtered;
}

/**
 * Paginate a list of containers
 */
export function paginateContainers(
  containers: AzureContainerInfo[],
  page: number,
  limit: number,
) {
  const totalCount = containers.length;
  const totalPages = Math.ceil(totalCount / limit);
  const startIndex = (page - 1) * limit;
  const endIndex = Math.min(startIndex + limit, totalCount);
  const paginatedContainers = containers.slice(startIndex, endIndex);

  return {
    containers: paginatedContainers,
    totalCount,
    totalPages,
    startItem: startIndex + 1,
    endItem: endIndex,
  };
}
