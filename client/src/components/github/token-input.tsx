import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { IconLoader2 } from "@tabler/icons-react";

interface TokenInputProps {
  placeholder: string;
  promptText: string;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
  isSaving: boolean;
  disabled?: boolean;
}

export function TokenInput({
  placeholder,
  promptText,
  value,
  onChange,
  onSave,
  onCancel,
  isSaving,
  disabled,
}: TokenInputProps) {
  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-muted-foreground">{promptText}</p>
      <div className="flex gap-2">
        <Input
          type="password"
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSave()}
          className="font-mono text-sm h-9"
        />
        <Button
          size="sm"
          onClick={onSave}
          disabled={isSaving || disabled || !value.trim()}
        >
          {isSaving ? (
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : null}
          Save
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
