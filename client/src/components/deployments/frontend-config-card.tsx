import React from "react";
import { Card, CardContent, CardHeader, CardTitle, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { HAProxyFrontendInfo } from "@mini-infra/types";
import { FrontendStatusBadge } from "./dns-status-badge";

interface InfoRowProps {
  label: string;
  value: React.ReactNode;
}

function InfoRow({ label, value }: InfoRowProps) {
  return (
    <div className="flex items-center justify-between py-2 border-b last:border-b-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className="text-sm font-medium">{value}</span>
    </div>
  );
}

interface FrontendConfigCardProps {
  frontend: HAProxyFrontendInfo;
  onSync?: () => void;
  isSyncing?: boolean;
  className?: string;
}

export function FrontendConfigCard({
  frontend,
  onSync,
  isSyncing = false,
  className,
}: FrontendConfigCardProps) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg">HAProxy Frontend Configuration</CardTitle>
          <FrontendStatusBadge status={frontend.status} />
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-1">
          <InfoRow label="Frontend Name" value={frontend.frontendName} />
          <InfoRow label="Hostname Routing" value={frontend.hostname} />
          <InfoRow label="Backend" value={frontend.backendName} />
          <InfoRow
            label="Bind Address"
            value={`${frontend.bindAddress}:${frontend.bindPort}`}
          />
          <InfoRow
            label="SSL/TLS"
            value={frontend.useSSL ? "Enabled" : "Disabled"}
          />
          {frontend.errorMessage && (
            <InfoRow
              label="Error"
              value={
                <span className="text-red-600 text-xs">
                  {frontend.errorMessage}
                </span>
              }
            />
          )}
        </div>
      </CardContent>
      {onSync && (
        <CardFooter>
          <Button
            onClick={onSync}
            variant="outline"
            disabled={isSyncing}
            className="w-full"
          >
            {isSyncing ? (
              <>
                <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                Sync Configuration
              </>
            )}
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}

interface EmptyStateProps {
  message: string;
  description?: string;
}

export function EmptyState({ message, description }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-center">
      <p className="text-muted-foreground text-sm">{message}</p>
      {description && (
        <p className="text-muted-foreground text-xs mt-1">{description}</p>
      )}
    </div>
  );
}
