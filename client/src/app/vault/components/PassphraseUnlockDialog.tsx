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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useUnlockPassphrase } from "@/hooks/use-vault";

export function PassphraseUnlockDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [passphrase, setPassphrase] = useState("");
  const mutation = useUnlockPassphrase();

  const submit = async () => {
    if (!passphrase) return;
    await mutation.mutateAsync(passphrase);
    setPassphrase("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unlock Vault Passphrase</DialogTitle>
          <DialogDescription>
            Enter the operator passphrase you set at bootstrap. Mini Infra
            keeps it in memory to auto-unseal Vault on restart. Never stored on
            disk.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <Label htmlFor="passphrase">Passphrase</Label>
          <Input
            id="passphrase"
            type="password"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
            autoFocus
            data-tour="vault-passphrase-input"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!passphrase || mutation.isPending}
            data-tour="vault-passphrase-submit"
          >
            {mutation.isPending ? "Unlocking…" : "Unlock"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
