import { useEffect, useRef, useState } from "react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconAlertCircle, IconCheck, IconDownload } from "@tabler/icons-react";
import { useBootstrapVault } from "@/hooks/use-vault";
import { Channel, ServerEvent } from "@mini-infra/types";
import type { VaultBootstrapResult } from "@mini-infra/types";
import { useSocketChannel, useSocketEvent } from "@/hooks/use-socket";

const DEFAULT_ADDRESS = "http://mini-infra-vault-vault:8200";

export function BootstrapDialog({
  open,
  onOpenChange,
  address: initialAddress,
  stackId: initialStackId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  address: string | null;
  stackId: string | null;
}) {
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [address, setAddress] = useState(initialAddress ?? DEFAULT_ADDRESS);
  const [phase, setPhase] = useState<
    "form" | "running" | "complete" | "failed"
  >("form");
  const [progress, setProgress] = useState<{
    completed: number;
    total: number;
    lastStep?: string;
  }>({ completed: 0, total: 0 });
  const [result, setResult] = useState<VaultBootstrapResult | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [operationId, setOperationId] = useState<string | null>(null);
  const bootstrap = useBootstrapVault();

  useSocketChannel(Channel.VAULT, open);
  useSocketEvent(
    ServerEvent.VAULT_BOOTSTRAP_STARTED,
    (p) => {
      if (operationId && p.operationId !== operationId) return;
      setPhase("running");
      setProgress({ completed: 0, total: p.totalSteps });
    },
    open,
  );
  useSocketEvent(
    ServerEvent.VAULT_BOOTSTRAP_STEP,
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
  // Note: VAULT_BOOTSTRAP_COMPLETED no longer carries credentials to avoid
  // leaking them to every socket subscriber. The result is returned via the
  // HTTP mutation's resolved value; see submit() below.

  // Reset dialog state whenever we transition into the open state, or while
  // open and the parent-supplied initial address changes. We snapshot the
  // previous deps via a ref so the setState calls live inside a
  // ref-controlled branch (avoids set-state-in-effect). Behaviour matches
  // the original effect that ran on every change of [open, initialAddress]
  // while open is true.
  const prevResetKeyRef = useRef<{ open: boolean; addr: string | null } | null>(
    null,
  );
  useEffect(() => {
    const prev = prevResetKeyRef.current;
    prevResetKeyRef.current = { open, addr: initialAddress };
    if (!open) return;
    if (prev && prev.open === open && prev.addr === initialAddress) return;
    setPhase("form");
    setProgress({ completed: 0, total: 0 });
    setResult(null);
    setErrors([]);
    setAddress(initialAddress ?? DEFAULT_ADDRESS);
  }, [open, initialAddress]);

  const canSubmit =
    passphrase.length >= 8 && passphrase === confirm && address.length > 0;

  const submit = async () => {
    setPhase("running");
    try {
      const res = await bootstrap.mutateAsync({
        passphrase,
        address,
        stackId: initialStackId ?? undefined,
      });
      setOperationId(res.operationId);
      setResult(res.result);
      setPhase("complete");
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
      setPhase("failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Bootstrap Vault</DialogTitle>
          <DialogDescription>
            Initialises OpenBao, generates unseal keys, and sets up the{" "}
            <code>mini-infra-admin</code> AppRole. Run once per install.
          </DialogDescription>
        </DialogHeader>

        {phase === "form" && (
          <div className="flex flex-col gap-3">
            <Alert>
              <IconAlertCircle className="h-4 w-4" />
              <AlertDescription>
                Choose a strong operator passphrase. This passphrase is never
                stored — you'll need it to auto-unseal Vault after every
                restart. If lost, recovery requires the unseal keys only.
              </AlertDescription>
            </Alert>
            <div className="flex flex-col gap-2">
              <Label htmlFor="address">Vault Address</Label>
              <Input
                id="address"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="http://mini-infra-vault-vault:8200"
                data-tour="vault-bootstrap-address"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="bs-passphrase">Operator Passphrase</Label>
              <Input
                id="bs-passphrase"
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                data-tour="vault-bootstrap-passphrase"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="bs-confirm">Confirm Passphrase</Label>
              <Input
                id="bs-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          </div>
        )}

        {phase === "running" && (
          <div className="flex flex-col gap-2">
            <p>
              Running… step {progress.completed} of {progress.total || "?"}
            </p>
            {progress.lastStep && (
              <p className="text-sm text-muted-foreground">
                {progress.lastStep}
              </p>
            )}
          </div>
        )}

        {phase === "failed" && (
          <Alert variant="destructive">
            <IconAlertCircle className="h-4 w-4" />
            <AlertDescription>
              Bootstrap failed:
              <ul className="list-disc pl-5 mt-1">
                {errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {phase === "complete" && result && <BootstrapComplete result={result} />}

        <DialogFooter>
          {phase === "form" && (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                onClick={submit}
                disabled={!canSubmit || bootstrap.isPending}
                data-tour="vault-bootstrap-submit"
              >
                {bootstrap.isPending ? "Starting…" : "Bootstrap"}
              </Button>
            </>
          )}
          {phase === "complete" && result && (
            <>
              <Button variant="outline" onClick={() => downloadCredentials(result)}>
                <IconDownload className="h-4 w-4 mr-2" /> Download
              </Button>
              <Button onClick={() => onOpenChange(false)}>
                <IconCheck className="h-4 w-4 mr-2" /> I've saved these
              </Button>
            </>
          )}
          {phase === "failed" && (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Close
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function downloadCredentials(result: VaultBootstrapResult) {
  const lines = [
    "=== Vault Bootstrap Credentials ===",
    `Generated: ${new Date().toISOString()}`,
    "",
    "IMPORTANT: Store this file securely and delete it when no longer needed.",
    "",
    "--- Unseal Keys (2 of 3 required to unseal) ---",
    ...result.unsealKeys.map((k, i) => `Key ${i + 1}: ${k}`),
    "",
    "--- Root Token (revoked after bootstrap — kept for record-keeping) ---",
    result.rootToken,
    "",
    "--- Operator Credentials (Vault UI userpass login) ---",
    `Username: ${result.operatorUsername}`,
    `Password: ${result.operatorPassword}`,
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "vault-credentials.txt";
  a.click();
  URL.revokeObjectURL(url);
}

function BootstrapComplete({ result }: { result: VaultBootstrapResult }) {
  return (
    <div className="flex flex-col gap-3">
      <Alert>
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          Save these immediately — they are shown <b>once</b>. You'll need the
          unseal keys for disaster recovery and the operator credentials to log
          into the Vault UI.
        </AlertDescription>
      </Alert>
      <div>
        <div className="text-sm font-medium">Unseal Keys</div>
        <pre className="text-xs font-mono bg-muted p-2 rounded whitespace-pre-wrap break-all">
          {result.unsealKeys.join("\n")}
        </pre>
      </div>
      <div>
        <div className="text-sm font-medium">Root Token</div>
        <pre className="text-xs font-mono bg-muted p-2 rounded break-all">
          {result.rootToken}
        </pre>
        <p className="text-xs text-muted-foreground mt-1">
          (Already revoked after this bootstrap. Kept here for record-keeping.)
        </p>
      </div>
      <div>
        <div className="text-sm font-medium">Vault UI Login</div>
        <pre className="text-xs font-mono bg-muted p-2 rounded break-all">
          Method: userpass{"\n"}Username: {result.operatorUsername}
          {"\n"}Password: {result.operatorPassword}
        </pre>
      </div>
    </div>
  );
}
