import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { parseDotenv } from "@/lib/parse-dotenv";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (entries: { key: string; value: string }[]) => void;
}

export function PasteEnvDialog({ open, onOpenChange, onApply }: Props) {
  const [text, setText] = useState("");

  const handleApply = () => {
    const entries = parseDotenv(text);
    onApply(entries);
    setText("");
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setText("");
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Paste .env</DialogTitle>
          <DialogDescription>
            Paste the contents of a <code>.env</code> file. Lines like{" "}
            <code>KEY=value</code> are parsed. Comments and blank lines are
            skipped. Duplicate keys overwrite existing values.
          </DialogDescription>
        </DialogHeader>

        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={"# database\nDB_HOST=localhost\nDB_PORT=5432\n\n# api\nAPI_KEY=\"secret\""}
          className="min-h-[220px] font-mono text-sm"
          autoFocus
        />

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleApply}
            disabled={text.trim().length === 0}
          >
            Apply
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
