import { useState } from "react";
import { Link } from "react-router-dom";
import { IconKey, IconPlus, IconTrash, IconUpload } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  useVaultAppRoles,
  useVaultPolicies,
  useCreateVaultAppRole,
  useApplyVaultAppRole,
  useDeleteVaultAppRole,
} from "@/hooks/use-vault";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";

export default function VaultAppRolesPage() {
  const { data: roles, isLoading } = useVaultAppRoles();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300">
            <IconKey className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Vault AppRoles</h1>
            <p className="text-muted-foreground">
              Role definitions used to mint short-lived tokens for apps
            </p>
          </div>
        </div>
        <Button onClick={() => setOpen(true)} data-tour="vault-approle-new">
          <IconPlus className="h-4 w-4 mr-2" /> New AppRole
        </Button>
      </div>
      <div className="px-4 lg:px-6 max-w-5xl">
        <Card data-tour="vault-approles-list">
          <CardHeader>
            <CardTitle>AppRoles</CardTitle>
            <CardDescription>{roles?.length ?? 0} AppRoles</CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <AppRoleTable roles={roles ?? []} />
            )}
          </CardContent>
        </Card>
      </div>
      <CreateAppRoleDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function AppRoleTable({
  roles,
}: {
  roles: import("@mini-infra/types").VaultAppRoleInfo[];
}) {
  const apply = useApplyVaultAppRole();
  const del = useDeleteVaultAppRole();
  if (roles.length === 0)
    return <p className="text-muted-foreground">No AppRoles yet.</p>;
  return (
    <div className="flex flex-col gap-2">
      {roles.map((r) => (
        <div
          key={r.id}
          className="flex items-center justify-between border rounded p-3"
        >
          <div>
            <div className="flex items-center gap-2">
              <Link
                to={`/vault/approles/${r.id}`}
                className="font-medium hover:underline"
              >
                {r.name}
              </Link>
              <Badge variant="secondary">policy:{r.policyName}</Badge>
              {r.cachedRoleId ? (
                <Badge>applied</Badge>
              ) : (
                <Badge variant="outline">not applied</Badge>
              )}
            </div>
            {r.cachedRoleId && (
              <p className="text-xs text-muted-foreground font-mono mt-1">
                role_id: {r.cachedRoleId}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await apply.mutateAsync(r.id);
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Apply failed",
                  );
                }
              }}
              disabled={apply.isPending}
            >
              <IconUpload className="h-4 w-4 mr-1" /> Apply
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                if (!confirm(`Delete AppRole ${r.name}?`)) return;
                try {
                  await del.mutateAsync(r.id);
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Delete failed",
                  );
                }
              }}
            >
              <IconTrash className="h-4 w-4" />
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}

function CreateAppRoleDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: policies } = useVaultPolicies();
  const [name, setName] = useState("");
  const [policyId, setPolicyId] = useState<string | null>(null);
  const [secretIdNumUses, setSecretIdNumUses] = useState(1);
  const [tokenPeriod, setTokenPeriod] = useState("");
  const create = useCreateVaultAppRole();

  const submit = async () => {
    if (!policyId) return;
    try {
      await create.mutateAsync({
        name,
        policyId,
        secretIdNumUses,
        tokenPeriod: tokenPeriod || undefined,
      });
      onOpenChange(false);
      setName("");
      setPolicyId(null);
      setSecretIdNumUses(1);
      setTokenPeriod("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New AppRole</DialogTitle>
          <DialogDescription>
            Bind a policy to a Vault AppRole. Apply afterwards to push to Vault.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="ar-name">Name</Label>
            <Input
              id="ar-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label>Policy</Label>
            <Select
              value={policyId ?? ""}
              onValueChange={(v) => setPolicyId(v)}
            >
              <SelectTrigger>
                <SelectValue placeholder="Select a policy" />
              </SelectTrigger>
              <SelectContent>
                {(policies ?? []).map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.displayName} ({p.name})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="num-uses">secret_id_num_uses</Label>
            <Input
              id="num-uses"
              type="number"
              min={0}
              value={secretIdNumUses}
              onChange={(e) => setSecretIdNumUses(Number(e.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              0 = unlimited; 1 = boot-once (recommended for most apps)
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="token-period">token_period (optional)</Label>
            <Input
              id="token-period"
              value={tokenPeriod}
              onChange={(e) => setTokenPeriod(e.target.value)}
              placeholder="e.g. 1h"
            />
            <p className="text-xs text-muted-foreground">
              Set for long-running apps that need to renew tokens indefinitely.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!name || !policyId || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
