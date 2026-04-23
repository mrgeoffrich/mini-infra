import { useState } from "react";
import {
  IconShieldLock,
  IconLock,
  IconLockOpen,
  IconAlertCircle,
  IconCheck,
  IconRefresh,
} from "@tabler/icons-react";
import {
  useVaultStatus,
  useLockPassphrase,
} from "@/hooks/use-vault";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { BootstrapDialog } from "./components/BootstrapDialog";
import { PassphraseUnlockDialog } from "./components/PassphraseUnlockDialog";
import { UnsealDialog } from "./components/UnsealDialog";
import { Link } from "react-router-dom";

export default function VaultPage() {
  const { data: status, isLoading, refetch } = useVaultStatus();
  const [bootstrapOpen, setBootstrapOpen] = useState(false);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unsealOpen, setUnsealOpen] = useState(false);
  const lockMutation = useLockPassphrase();

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
        <div className="px-4 lg:px-6">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="mt-4 h-64 w-full" />
        </div>
      </div>
    );
  }

  const notBootstrapped = !status?.initialised;
  const locked = status?.passphrase.state !== "unlocked";
  const needsUnlock =
    status?.passphrase.state === "locked" && status?.sealed === true;
  const sealed =
    status?.sealed === true && status?.passphrase.state === "unlocked";

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300">
              <IconShieldLock className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Vault</h1>
              <p className="text-muted-foreground">
                Managed OpenBao — bootstrap, unseal, and policy management
              </p>
            </div>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => refetch()}
              data-tour="vault-refresh"
            >
              <IconRefresh className="h-4 w-4 mr-2" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-5xl flex flex-col gap-4">
        <Card data-tour="vault-status-card">
          <CardHeader>
            <CardTitle>Status</CardTitle>
            <CardDescription>
              Current seal state of the managed Vault
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <StatusGrid status={status} />
            {notBootstrapped && (
              <Alert>
                <IconAlertCircle className="h-4 w-4" />
                <AlertDescription>
                  Vault has not been bootstrapped. Deploy the Vault stack first,
                  then press <b>Bootstrap</b> to initialise it.
                </AlertDescription>
              </Alert>
            )}
            {needsUnlock && (
              <Alert>
                <IconLock className="h-4 w-4" />
                <AlertDescription>
                  Vault is sealed and the operator passphrase is locked. Enter
                  it to auto-unseal.
                </AlertDescription>
              </Alert>
            )}
            <div className="flex flex-wrap gap-2">
              {notBootstrapped && (
                <Button
                  onClick={() => setBootstrapOpen(true)}
                  data-tour="vault-bootstrap"
                >
                  Bootstrap Vault
                </Button>
              )}
              {!notBootstrapped && locked && (
                <Button
                  onClick={() => setUnlockOpen(true)}
                  data-tour="vault-unlock"
                >
                  <IconLockOpen className="h-4 w-4 mr-2" />
                  Unlock Passphrase
                </Button>
              )}
              {!notBootstrapped && !locked && (
                <Button
                  variant="outline"
                  onClick={() => lockMutation.mutate()}
                  data-tour="vault-lock"
                >
                  <IconLock className="h-4 w-4 mr-2" />
                  Lock Passphrase
                </Button>
              )}
              {sealed && (
                <Button
                  variant="secondary"
                  onClick={() => setUnsealOpen(true)}
                  data-tour="vault-unseal"
                >
                  Unseal Now
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Policies & AppRoles</CardTitle>
            <CardDescription>
              Manage HCL policies and AppRole credentials
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/vault/policies" data-tour="vault-policies-link">
                Manage Policies
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/vault/approles" data-tour="vault-approles-link">
                Manage AppRoles
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>

      <BootstrapDialog
        open={bootstrapOpen}
        onOpenChange={setBootstrapOpen}
        address={status?.address ?? null}
        stackId={status?.stackId ?? null}
      />
      <PassphraseUnlockDialog
        open={unlockOpen}
        onOpenChange={setUnlockOpen}
      />
      <UnsealDialog open={unsealOpen} onOpenChange={setUnsealOpen} />
    </div>
  );
}

function StatusGrid({
  status,
}: {
  status: import("@mini-infra/types").VaultStatus | undefined;
}) {
  if (!status) return null;
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div>
        <dt className="text-sm font-medium text-muted-foreground">
          Bootstrapped
        </dt>
        <dd>
          {status.initialised ? (
            <Badge variant="default">
              <IconCheck className="h-3 w-3 mr-1" /> Yes
            </Badge>
          ) : (
            <Badge variant="secondary">No</Badge>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-sm font-medium text-muted-foreground">
          Reachable
        </dt>
        <dd>
          {status.reachable ? (
            <Badge variant="default">Yes</Badge>
          ) : (
            <Badge variant="destructive">No</Badge>
          )}
        </dd>
      </div>
      <div>
        <dt className="text-sm font-medium text-muted-foreground">Seal</dt>
        <dd>
          <Badge
            variant={
              status.sealState === "unsealed"
                ? "default"
                : status.sealState === "sealed"
                  ? "destructive"
                  : "secondary"
            }
          >
            {status.sealState}
          </Badge>
        </dd>
      </div>
      <div>
        <dt className="text-sm font-medium text-muted-foreground">
          Passphrase
        </dt>
        <dd>
          <Badge
            variant={
              status.passphrase.state === "unlocked" ? "default" : "secondary"
            }
          >
            {status.passphrase.state}
          </Badge>
        </dd>
      </div>
      {status.address && (
        <div className="sm:col-span-2">
          <dt className="text-sm font-medium text-muted-foreground">
            Address
          </dt>
          <dd className="font-mono text-sm">{status.address}</dd>
        </div>
      )}
    </dl>
  );
}
