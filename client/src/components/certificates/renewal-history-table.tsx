import { useFormattedDate } from "@/hooks/use-formatted-date";
import {
  IconCircleCheck,
  IconCircleX,
  IconAlertTriangle,
} from "@tabler/icons-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { TlsCertificateRenewal } from "@mini-infra/types";

interface RenewalHistoryTableProps {
  renewals: TlsCertificateRenewal[];
}

export function RenewalHistoryTable({ renewals }: RenewalHistoryTableProps) {
  const { formatDateTime } = useFormattedDate();

  if (renewals.length === 0) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        No renewal history available
      </div>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Attempt</TableHead>
          <TableHead>Duration</TableHead>
          <TableHead>Triggered By</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {renewals.map((renewal) => (
          <TableRow key={renewal.id}>
            <TableCell>{formatDateTime(renewal.startedAt)}</TableCell>
            <TableCell>
              <RenewalStatusBadge status={renewal.status} />
            </TableCell>
            <TableCell>
              {renewal.attemptNumber}
              {renewal.attemptNumber > 1 && (
                <IconAlertTriangle className="h-3 w-3 inline ml-1 text-orange-600" />
              )}
            </TableCell>
            <TableCell>
              {renewal.durationMs
                ? `${(renewal.durationMs / 1000).toFixed(1)}s`
                : "-"}
            </TableCell>
            <TableCell className="font-mono text-sm">
              {renewal.triggeredBy}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function RenewalStatusBadge({ status }: { status: string }) {
  const config = {
    COMPLETED: {
      icon: IconCircleCheck,
      label: "Completed",
      className: "text-green-600",
    },
    FAILED: {
      icon: IconCircleX,
      label: "Failed",
      className: "text-red-600",
    },
    INITIATED: {
      icon: IconCircleCheck,
      label: "Initiated",
      className: "text-blue-600",
    },
    DNS_CHALLENGE_CREATED: {
      icon: IconCircleCheck,
      label: "DNS Challenge Created",
      className: "text-blue-600",
    },
    DNS_CHALLENGE_VALIDATED: {
      icon: IconCircleCheck,
      label: "DNS Validated",
      className: "text-blue-600",
    },
    CERTIFICATE_ISSUED: {
      icon: IconCircleCheck,
      label: "Certificate Issued",
      className: "text-green-600",
    },
    STORED_IN_VAULT: {
      icon: IconCircleCheck,
      label: "Stored in Vault",
      className: "text-green-600",
    },
    DEPLOYED_TO_HAPROXY: {
      icon: IconCircleCheck,
      label: "Deployed",
      className: "text-green-600",
    },
  };

  const statusConfig =
    config[status as keyof typeof config] || {
      icon: IconCircleX,
      label: status,
      className: "text-gray-600",
    };
  const Icon = statusConfig.icon;

  return (
    <div className={cn("flex items-center gap-1", statusConfig.className)}>
      <Icon className="h-4 w-4" />
      <span className="text-sm">{statusConfig.label}</span>
    </div>
  );
}
