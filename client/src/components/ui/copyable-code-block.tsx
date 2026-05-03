import * as React from "react";
import { IconCopy, IconCheck } from "@tabler/icons-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface CopyableCodeBlockProps {
  value: string;
  /** Hint for syntax highlighting; v1 is plain `<pre>` so it's display-only. */
  language?: "json" | "hujson" | "shell";
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}

/**
 * Read-only `<pre>` with a top-right click-to-copy button. The button flips
 * from `IconCopy` → `IconCheck` for ~1.5s after a successful copy, matching
 * the pattern at `client/src/app/api-keys/new/page.tsx`.
 *
 * Reused across Tailscale settings (ACL snippet) and later Service Addons
 * phases (Caddyfile / Vault path snippets). v1 has no syntax highlighting —
 * the `language` prop is wired so an upgrade is non-breaking.
 */
export function CopyableCodeBlock({
  value,
  ariaLabel,
  className,
  disabled = false,
}: CopyableCodeBlockProps) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(
        "Couldn't copy — your browser blocked clipboard access. Select the snippet manually.",
      );
    }
  };

  return (
    <div
      className={cn(
        "relative rounded-md border bg-muted/50",
        disabled && "opacity-60",
        className,
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onCopy}
        disabled={disabled}
        aria-label={`Copy ${ariaLabel}`}
        className="absolute top-1.5 right-1.5 h-7 px-2"
      >
        {copied ? (
          <IconCheck className="size-3.5" />
        ) : (
          <IconCopy className="size-3.5" />
        )}
        <span className="ml-1 text-xs">{copied ? "Copied" : "Copy"}</span>
      </Button>
      <pre
        aria-label={ariaLabel}
        className="max-h-96 overflow-auto p-4 pr-20 text-xs font-mono whitespace-pre"
      >
        {value}
      </pre>
    </div>
  );
}
