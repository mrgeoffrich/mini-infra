import { useState } from "react";
import type { DnsCachedZone } from "@mini-infra/types";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { IconChevronRight, IconChevronDown } from "@tabler/icons-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useDnsZoneRecords } from "@/hooks/use-dns";
import { DnsRecordsTable } from "./dns-records-table";

interface DnsZoneCardProps {
  zone: DnsCachedZone;
}

export function DnsZoneCard({ zone }: DnsZoneCardProps) {
  const [isOpen, setIsOpen] = useState(false);

  // Only fetch records when expanded
  const { data, isLoading } = useDnsZoneRecords(isOpen ? zone.id : "");

  return (
    <Card>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                {isOpen ? (
                  <IconChevronDown className="w-4 h-4 text-muted-foreground" />
                ) : (
                  <IconChevronRight className="w-4 h-4 text-muted-foreground" />
                )}
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{zone.name}</span>
                    <Badge
                      variant={zone.status === "active" ? "default" : "secondary"}
                      className="text-xs"
                    >
                      {zone.status}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground mt-1">
                    {zone.nameServers.join(", ")}
                  </p>
                </div>
              </div>
              <span className="text-xs text-muted-foreground">
                {zone.recordCount} record{zone.recordCount !== 1 ? "s" : ""}
              </span>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="pt-0 pb-4">
            {isLoading ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : data?.data?.records ? (
              <DnsRecordsTable records={data.data.records} />
            ) : (
              <p className="text-sm text-muted-foreground">
                Failed to load records.
              </p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}
