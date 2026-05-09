import * as React from "react";
import {
  IconCheck,
  IconCopy,
  IconExternalLink,
  IconTerminal2,
  IconWorld,
} from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DeviceStatusBadge,
  type DeviceStatus,
} from "@/components/stacks/device-status-badge";
import type { TailscaleAddonEndpoint } from "@mini-infra/types";

interface EndpointRowProps {
  endpoint: TailscaleAddonEndpoint;
  status: DeviceStatus;
  lastSeenAt?: string | null;
}

/**
 * One row on the Connect card — addon-kind icon, the action affordance
 * (`ssh root@…` for SSH endpoints, `https://…` link for HTTPS), an inline
 * copy button, and the device-status badge. Compact flex layout (not a
 * `<TableRow>`) to keep the card visually quieter than a full table.
 */
export function EndpointRow({ endpoint, status, lastSeenAt }: EndpointRowProps) {
  const Icon = endpoint.kind === "ssh" ? IconTerminal2 : IconWorld;
  const offline = status === "offline";

  const offlineTooltip = "Device offline — connection will time out";

  return (
    <li
      className="flex items-center gap-3 py-2"
      data-tour={`connect-endpoint-${endpoint.targetService}-${endpoint.kind}`}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />

      <div className="min-w-0 flex-1">
        <ActionAffordance endpoint={endpoint} disabled={offline} disabledTooltip={offlineTooltip} />
        <p className="text-xs text-muted-foreground truncate">
          {endpoint.targetService}
        </p>
      </div>

      <CopyButton value={endpoint.url ?? endpoint.hostname} disabled={!endpoint.url} />
      <DeviceStatusBadge status={status} lastSeenAt={lastSeenAt} />
    </li>
  );
}

function ActionAffordance({
  endpoint,
  disabled,
  disabledTooltip,
}: {
  endpoint: TailscaleAddonEndpoint;
  disabled: boolean;
  disabledTooltip: string;
}) {
  // No URL yet (tailnet domain hasn't resolved) — render the hostname so the
  // operator sees the addon attached without rendering a broken link.
  if (!endpoint.url) {
    return (
      <code className="font-mono text-sm text-muted-foreground truncate block">
        {endpoint.hostname}
      </code>
    );
  }

  if (endpoint.kind === "ssh") {
    return (
      <code
        className={cn(
          "font-mono text-sm truncate block",
          disabled && "text-muted-foreground",
        )}
      >
        {endpoint.url}
      </code>
    );
  }

  // HTTPS — render the URL as an actual anchor.
  const link = (
    <a
      href={endpoint.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={disabled || undefined}
      onClick={(e) => {
        // We deliberately do not block the click — operators sometimes want
        // to copy the URL regardless of online status — but we want the
        // visual cue to land first.
        if (disabled) {
          e.stopPropagation();
        }
      }}
      className={cn(
        "font-mono text-sm truncate inline-flex items-center gap-1 hover:underline",
        disabled
          ? "text-muted-foreground"
          : "text-primary",
      )}
    >
      <span className="truncate">{endpoint.url}</span>
      <IconExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
  );

  if (!disabled) return link;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>{link}</TooltipTrigger>
        <TooltipContent>{disabledTooltip}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function CopyButton({ value, disabled }: { value: string; disabled?: boolean }) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(
        "Couldn't copy — your browser blocked clipboard access.",
      );
    }
  };

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onCopy}
      disabled={disabled}
      className="h-7 px-2"
      aria-label={copied ? "Copied" : "Copy to clipboard"}
    >
      {copied ? (
        <IconCheck className="size-3.5" />
      ) : (
        <IconCopy className="size-3.5" />
      )}
    </Button>
  );
}
