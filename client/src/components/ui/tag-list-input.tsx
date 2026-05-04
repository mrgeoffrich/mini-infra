import * as React from "react";
import { IconX } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface TagListInputProps {
  value: string[];
  onChange: (next: string[]) => void;
  /** Chips rendered before `value` with no remove affordance. */
  pinnedHead?: string[];
  /** Tooltip body for pinned chips (e.g. why the tag can't be removed). */
  pinnedTooltip?: string;
  /** Return null when valid, an error string when invalid. */
  validate?: (raw: string) => string | null;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}

/**
 * Chip-style multi-value input for tags. Pressing Enter or `,` commits the
 * current input as a chip; Backspace on an empty input removes the last
 * (non-pinned) chip. Pinned chips render before user-entered chips and
 * carry no remove button.
 *
 * Designed to be used inside a controlled RHF FormField — the parent owns
 * `value` / `onChange`. Validation lives on the parent's zod schema; this
 * component only exposes a per-character `validate` for inline feedback so
 * an invalid token never lands as a chip.
 */
export function TagListInput({
  value,
  onChange,
  pinnedHead = [],
  pinnedTooltip,
  validate,
  placeholder = "Add tag and press Enter",
  disabled = false,
  className,
  ariaLabel,
}: TagListInputProps) {
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const commit = React.useCallback(
    (raw: string) => {
      const trimmed = raw.trim().replace(/,$/, "");
      if (trimmed.length === 0) return;
      const validationError = validate?.(trimmed) ?? null;
      if (validationError) {
        setError(validationError);
        return;
      }
      if (pinnedHead.includes(trimmed) || value.includes(trimmed)) {
        setError("Tag already added");
        return;
      }
      onChange([...value, trimmed]);
      setDraft("");
      setError(null);
    },
    [onChange, pinnedHead, validate, value],
  );

  const removeAt = React.useCallback(
    (index: number) => {
      const next = [...value];
      next.splice(index, 1);
      onChange(next);
    },
    [onChange, value],
  );

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft.length === 0 && value.length > 0) {
      event.preventDefault();
      removeAt(value.length - 1);
    }
  };

  return (
    <div className={cn("space-y-1", className)} aria-label={ariaLabel}>
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-input bg-transparent px-2 py-1.5 focus-within:ring-2 focus-within:ring-ring/50">
        <TooltipProvider>
          {pinnedHead.map((tag) => (
            <Tooltip key={`pinned-${tag}`}>
              <TooltipTrigger asChild>
                <Badge variant="secondary" className="font-mono">
                  {tag}
                </Badge>
              </TooltipTrigger>
              {pinnedTooltip && (
                <TooltipContent>{pinnedTooltip}</TooltipContent>
              )}
            </Tooltip>
          ))}
        </TooltipProvider>
        {value.map((tag, idx) => (
          <Badge
            key={`tag-${idx}-${tag}`}
            variant="secondary"
            className="font-mono pr-1"
          >
            <span>{tag}</span>
            {!disabled && (
              <button
                type="button"
                aria-label={`Remove ${tag}`}
                onClick={() => removeAt(idx)}
                className="ml-1 rounded-sm hover:bg-muted-foreground/20"
              >
                <IconX className="size-3" />
              </button>
            )}
          </Badge>
        ))}
        <Input
          type="text"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            if (error) setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          placeholder={value.length === 0 && pinnedHead.length === 0 ? placeholder : ""}
          disabled={disabled}
          className="border-0 shadow-none focus-visible:ring-0 px-1 py-0 h-6 flex-1 min-w-[8rem]"
        />
      </div>
      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
