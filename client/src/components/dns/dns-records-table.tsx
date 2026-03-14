import type { DnsCachedRecord } from "@mini-infra/types";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { IconShield, IconShieldOff } from "@tabler/icons-react";

const typeColors: Record<string, string> = {
  A: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300",
  AAAA: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300",
  CNAME: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
  MX: "bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300",
  TXT: "bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-300",
  NS: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-300",
  SRV: "bg-pink-100 text-pink-800 dark:bg-pink-900 dark:text-pink-300",
  CAA: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300",
};

function formatTtl(ttl: number): string {
  if (ttl === 1) return "Auto";
  if (ttl < 60) return `${ttl}s`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}m`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}h`;
  return `${Math.floor(ttl / 86400)}d`;
}

interface DnsRecordsTableProps {
  records: DnsCachedRecord[];
}

export function DnsRecordsTable({ records }: DnsRecordsTableProps) {
  if (records.length === 0) {
    return (
      <p className="text-sm text-muted-foreground py-4 text-center">
        No DNS records found in this zone.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left text-muted-foreground">
            <th className="pb-2 pr-4 font-medium w-20">Type</th>
            <th className="pb-2 pr-4 font-medium">Name</th>
            <th className="pb-2 pr-4 font-medium">Content</th>
            <th className="pb-2 pr-4 font-medium w-16">TTL</th>
            <th className="pb-2 font-medium w-20">Proxied</th>
          </tr>
        </thead>
        <tbody>
          {records.map((record) => (
            <tr key={record.id} className="border-b last:border-0">
              <td className="py-2 pr-4">
                <Badge
                  variant="secondary"
                  className={`text-xs font-mono ${typeColors[record.type] || ""}`}
                >
                  {record.type}
                </Badge>
              </td>
              <td className="py-2 pr-4 font-mono text-xs break-all">
                {record.name}
              </td>
              <td className="py-2 pr-4 text-xs max-w-[300px]">
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="block truncate">{record.content}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="font-mono text-xs max-w-[400px] break-all">
                        {record.content}
                      </p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              </td>
              <td className="py-2 pr-4 text-xs text-muted-foreground">
                {formatTtl(record.ttl)}
              </td>
              <td className="py-2">
                {record.proxiable ? (
                  record.proxied ? (
                    <IconShield className="w-4 h-4 text-orange-500" />
                  ) : (
                    <IconShieldOff className="w-4 h-4 text-muted-foreground" />
                  )
                ) : (
                  <span className="text-xs text-muted-foreground">--</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
