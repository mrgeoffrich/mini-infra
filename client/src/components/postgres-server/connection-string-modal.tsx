import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import { ManagedDatabaseInfo } from "@mini-infra/types";

interface ConnectionStringModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  database: ManagedDatabaseInfo;
  serverHost: string;
  serverPort: number;
}

export function ConnectionStringModal({
  open,
  onOpenChange,
  database,
  serverHost,
  serverPort,
}: ConnectionStringModalProps) {
  const [copied, setCopied] = useState(false);

  // Build the connection string with password placeholder
  const connectionString = `postgresql://${database.owner}:<password>@${serverHost}:${serverPort}/${database.databaseName}`;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(connectionString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Database Connection String</DialogTitle>
          <DialogDescription>
            Use this connection string to connect to{" "}
            <span className="font-mono font-semibold">
              {database.databaseName}
            </span>
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Connection String */}
          <div className="space-y-2">
            <Label>Connection String</Label>
            <div className="flex gap-2">
              <div className="flex-1 p-3 bg-muted rounded-md font-mono text-sm break-all">
                {connectionString}
              </div>
              <Button
                variant="outline"
                size="icon"
                onClick={handleCopy}
                className="shrink-0"
              >
                {copied ? (
                  <IconCheck className="h-4 w-4 text-green-600" />
                ) : (
                  <IconCopy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Replace <span className="font-mono">&lt;password&gt;</span> with
              the actual password for user{" "}
              <span className="font-mono font-semibold">{database.owner}</span>
            </p>
          </div>

          {/* Connection Details */}
          <div className="space-y-3 pt-2 border-t">
            <h4 className="text-sm font-semibold">Connection Details</h4>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <Label className="text-xs text-muted-foreground">Host</Label>
                <div className="font-mono">{serverHost}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Port</Label>
                <div className="font-mono">{serverPort}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">Database</Label>
                <div className="font-mono">{database.databaseName}</div>
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">User</Label>
                <div className="font-mono">{database.owner}</div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
