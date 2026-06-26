import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  IconNetwork,
  IconCheck,
  IconAlertTriangle,
  IconBan,
} from "@tabler/icons-react";
import type { EgressNetworkInfo, EgressNetworkStatus } from "@mini-infra/types";

interface EgressNetworkCardProps {
  egressNetwork?: EgressNetworkInfo;
  className?: string;
}

const STATUS_META: Record<
  EgressNetworkStatus,
  { label: string; badgeClass: string; Icon: typeof IconCheck }
> = {
  present: {
    label: "Healthy",
    badgeClass:
      "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300",
    Icon: IconCheck,
  },
  error: {
    label: "Network missing",
    badgeClass: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300",
    Icon: IconAlertTriangle,
  },
  missing: {
    label: "Not provisioned",
    badgeClass: "bg-muted text-muted-foreground",
    Icon: IconBan,
  },
};

function DetailRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium font-mono text-xs">{value ?? "—"}</span>
    </div>
  );
}

export function EgressNetworkCard({
  egressNetwork,
  className,
}: EgressNetworkCardProps) {
  // The environment detail endpoint always populates this; guard for safety
  // (e.g. a cached list entry rendered before detail resolves).
  if (!egressNetwork) return null;

  const meta = STATUS_META[egressNetwork.status];
  const StatusIcon = meta.Icon;

  return (
    <Card className={className}>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div>
          <CardTitle className="text-sm font-medium">Egress Network</CardTitle>
          <CardDescription className="text-xs">
            Managed containers route outbound traffic through this network
          </CardDescription>
        </div>
        <div className="flex items-center gap-2">
          <IconNetwork className="h-4 w-4 text-muted-foreground" />
          <Badge variant="outline" className={meta.badgeClass}>
            <StatusIcon className="h-3 w-3 mr-1" />
            {meta.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {egressNetwork.status === "missing" ? (
          <p className="text-sm text-muted-foreground">
            No egress network has been provisioned for this environment.
          </p>
        ) : (
          <div className="space-y-2.5">
            <DetailRow label="Network" value={egressNetwork.name} />
            <DetailRow label="Subnet" value={egressNetwork.subnet} />
            <DetailRow label="Bridge gateway" value={egressNetwork.bridgeGateway} />
            <DetailRow label="Gateway IP" value={egressNetwork.gatewayContainerIp} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
