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
  DeviceStatusBadge,
  type DeviceStatus,
} from "@/components/stacks/device-status-badge";

/**
 * One row inside the `PoolEndpointsSheet`. Mono `instanceId` chip, the
 * resolved per-instance URL (ssh-as-code or https-as-anchor), a
 * `DeviceStatusBadge`, and an inline copy button. Mirrors `EndpointRow`'s
 * visual language so the Sheet feels like an extension of the card.
 */
export interface PoolInstanceRowProps {
  instanceId: string;
  kind: "ssh" | "https";
  /** Sanitised per-instance hostname (no scheme, no path). */
  hostname: string;
  /** Full reachable URL — null when the tailnet hasn't been resolved yet. */
  url: string | null;
  status: DeviceStatus;
  lastSeenAt?: string | null;
}

export function PoolInstanceRow({
  instanceId,
  kind,
  hostname,
  url,
  status,
  lastSeenAt,
}: PoolInstanceRowProps) {
  const Icon = kind === "ssh" ? IconTerminal2 : IconWorld;
  const offline = status === "offline";

  return (
    <li className="flex items-center gap-3 py-2">
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />

      <code className="font-mono text-xs shrink-0 text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
        {instanceId}
      </code>

      <div className="min-w-0 flex-1">
        <ActionAffordance kind={kind} url={url} hostname={hostname} disabled={offline} />
      </div>

      <CopyButton value={url ?? hostname} disabled={!url} />
      <DeviceStatusBadge status={status} lastSeenAt={lastSeenAt} />
    </li>
  );
}

function ActionAffordance({
  kind,
  url,
  hostname,
  disabled,
}: {
  kind: "ssh" | "https";
  url: string | null;
  hostname: string;
  disabled: boolean;
}) {
  if (!url) {
    return (
      <code className="font-mono text-sm text-muted-foreground truncate block">
        {hostname}
      </code>
    );
  }
  if (kind === "ssh") {
    return (
      <code
        className={cn(
          "font-mono text-sm truncate block",
          disabled && "text-muted-foreground",
        )}
      >
        {url}
      </code>
    );
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      aria-disabled={disabled || undefined}
      className={cn(
        "font-mono text-sm truncate inline-flex items-center gap-1 hover:underline",
        disabled ? "text-muted-foreground" : "text-primary",
      )}
    >
      <span className="truncate">{url}</span>
      <IconExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
    </a>
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
      toast.error("Couldn't copy — your browser blocked clipboard access.");
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
      {copied ? <IconCheck className="size-3.5" /> : <IconCopy className="size-3.5" />}
    </Button>
  );
}
