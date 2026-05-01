export interface StorageLocationListProps {
  className?: string;
}

export interface LocationAccessTest {
  locationId: string;
  status: "testing" | "success" | "failed" | "idle";
  lastTested?: Date;
  responseTime?: number;
  error?: string;
}

/**
 * Minimum row shape the lifted table primitives (`LocationTable`, `LocationRow`)
 * require. Concrete providers extend this with provider-specific fields (Azure
 * lease status, public access, etc.) and the table primitives stay generic via
 * a row-type parameter that defaults to this base.
 */
export interface StorageLocationRow {
  name: string;
  lastModified: string;
  metadata?: Record<string, string>;
}
