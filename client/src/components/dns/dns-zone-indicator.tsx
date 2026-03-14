import { Badge } from "@/components/ui/badge";
import { IconLoader2 } from "@tabler/icons-react";
import { useDnsValidateHostname } from "@/hooks/use-dns";

interface DnsZoneIndicatorProps {
  hostname: string;
}

export function DnsZoneIndicator({ hostname }: DnsZoneIndicatorProps) {
  const { data, isLoading } = useDnsValidateHostname(hostname);

  if (!hostname || !hostname.includes(".")) return null;

  if (isLoading) {
    return (
      <div className="flex items-center gap-1 mt-1">
        <IconLoader2 className="w-3 h-3 animate-spin text-muted-foreground" />
        <span className="text-xs text-muted-foreground">Checking DNS...</span>
      </div>
    );
  }

  if (!data?.data) return null;

  const { matchedZone, zoneName, existingRecords } = data.data;

  return (
    <div className="flex flex-wrap items-center gap-2 mt-1">
      {matchedZone ? (
        <Badge
          variant="outline"
          className="text-xs border-green-300 text-green-700 bg-green-50 dark:border-green-700 dark:text-green-400 dark:bg-green-950"
        >
          Zone: {zoneName}
        </Badge>
      ) : (
        <Badge
          variant="outline"
          className="text-xs border-yellow-300 text-yellow-700 bg-yellow-50 dark:border-yellow-700 dark:text-yellow-400 dark:bg-yellow-950"
        >
          No matching DNS zone
        </Badge>
      )}
      {existingRecords && existingRecords.length > 0 && (
        <span className="text-xs text-muted-foreground">
          Existing: {existingRecords.map((r) => `${r.type} → ${r.content}`).join(", ")}
        </span>
      )}
    </div>
  );
}
