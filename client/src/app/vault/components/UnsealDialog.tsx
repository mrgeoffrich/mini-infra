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
import { useTriggerUnseal } from "@/hooks/use-vault";
import { Channel, ServerEvent } from "@mini-infra/types";
import { useSocketChannel, useSocketEvent } from "@/hooks/use-socket";

export function UnsealDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [phase, setPhase] = useState<"idle" | "running" | "complete" | "failed">(
    "idle",
  );
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    lastStep?: string;
  }>({ completed: 0, total: 0 });
  const [errors, setErrors] = useState<string[]>([]);
  const [operationId, setOperationId] = useState<string | null>(null);
  const unseal = useTriggerUnseal();

  useSocketChannel(Channel.VAULT, open);
  useSocketEvent(
    ServerEvent.VAULT_UNSEAL_STARTED,
    (p) => {
      if (operationId && p.operationId !== operationId) return;
      setProgress({ completed: 0, total: p.totalSteps });
      setPhase("running");
    },
    open,
  );
  useSocketEvent(
    ServerEvent.VAULT_UNSEAL_STEP,
    (p) => {
      if (operationId && p.operationId !== operationId) return;
      setProgress({
        completed: p.completedCount,
        total: p.totalSteps,
        lastStep: p.step.step,
      });
    },
    open,
  );
  useSocketEvent(
    ServerEvent.VAULT_UNSEAL_COMPLETED,
    (p) => {
      if (operationId && p.operationId !== operationId) return;
      if (p.success) setPhase("complete");
      else {
        setErrors(p.errors);
        setPhase("failed");
      }
    },
    open,
  );

  const submit = async () => {
    const res = await unseal.mutateAsync();
    setOperationId(res.operationId);
    setPhase("running");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unseal Vault</DialogTitle>
          <DialogDescription>
            Submits stored unseal shares to unlock the Vault API.
          </DialogDescription>
        </DialogHeader>

        {phase === "running" && (
          <p>
            Running… step {progress.completed} of {progress.total || "?"}
            {progress.lastStep ? ` — ${progress.lastStep}` : ""}
          </p>
        )}
        {phase === "complete" && <p>Vault is unsealed.</p>}
        {phase === "failed" && (
          <p className="text-destructive">Unseal failed: {errors.join("; ")}</p>
        )}

        <DialogFooter>
          {phase === "idle" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={submit} disabled={unseal.isPending}>
                {unseal.isPending ? "Starting…" : "Unseal"}
              </Button>
            </>
          )}
          {phase !== "idle" && phase !== "running" && (
            <Button onClick={() => onOpenChange(false)}>Close</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
