import { Lock, Unlock, Globe, Shield } from "lucide-react";

/**
 * Container access test result interface
 */
export interface ContainerAccessTest {
  containerName: string;
  status: "testing" | "success" | "failed" | "idle";
  lastTested?: Date;
  responseTime?: number;
  error?: string;
}

/**
 * Lease status badge configuration
 */
export const LEASE_STATUS_VARIANTS = {
  locked: {
    variant: "destructive" as const,
    icon: Lock,
    color: "text-red-600",
    label: "Locked",
  },
  unlocked: {
    variant: "default" as const,
    icon: Unlock,
    color: "text-green-600",
    label: "Unlocked",
  },
} as const;

/**
 * Public access level badge configuration
 */
export const PUBLIC_ACCESS_VARIANTS = {
  container: {
    variant: "secondary" as const,
    icon: Globe,
    color: "text-blue-600",
    label: "Container",
  },
  blob: {
    variant: "outline" as const,
    icon: Globe,
    color: "text-amber-600",
    label: "Blob",
  },
  null: {
    variant: "outline" as const,
    icon: Shield,
    color: "text-gray-600",
    label: "Private",
  },
} as const;

/**
 * Column widths for the container table
 */
export const COLUMN_WIDTHS = {
  containerName: "w-[250px] min-w-[250px] max-w-[250px]",
  lastModified: "w-[200px] min-w-[200px] max-w-[200px]",
  leaseStatus: "w-[140px] min-w-[140px] max-w-[140px]",
  accessLevel: "w-[120px] min-w-[120px] max-w-[120px]",
  metadata: "w-[140px] min-w-[140px] max-w-[140px]",
  actions: "w-[180px] min-w-[180px] max-w-[180px]",
} as const;

/**
 * Get column width by index
 */
export function getColumnWidth(index: number): string {
  switch (index) {
    case 0:
      return COLUMN_WIDTHS.containerName;
    case 1:
      return COLUMN_WIDTHS.lastModified;
    case 2:
      return COLUMN_WIDTHS.leaseStatus;
    case 3:
      return COLUMN_WIDTHS.accessLevel;
    case 4:
      return COLUMN_WIDTHS.metadata;
    case 5:
      return COLUMN_WIDTHS.actions;
    default:
      return "";
  }
}
