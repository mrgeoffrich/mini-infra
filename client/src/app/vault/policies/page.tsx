import { useState } from "react";
import { Link } from "react-router-dom";
import { IconFileText, IconPlus, IconTrash, IconUpload } from "@tabler/icons-react";
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
  useVaultPolicies,
  useCreateVaultPolicy,
  usePublishVaultPolicy,
  useDeleteVaultPolicy,
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
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";

export default function VaultPoliciesPage() {
  const { data: policies, isLoading } = useVaultPolicies();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-3 rounded-md bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300">
            <IconFileText className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-3xl font-bold">Vault Policies</h1>
            <p className="text-muted-foreground">
              HCL policy documents managed by Mini Infra
            </p>
          </div>
        </div>
        <Button onClick={() => setCreateOpen(true)} data-tour="vault-policy-new">
          <IconPlus className="h-4 w-4 mr-2" /> New Policy
        </Button>
      </div>
      <div className="px-4 lg:px-6 max-w-5xl">
        <Card data-tour="vault-policies-list">
          <CardHeader>
            <CardTitle>Policies</CardTitle>
            <CardDescription>
              {policies?.length ?? 0} policies
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : (
              <PolicyTable policies={policies ?? []} />
            )}
          </CardContent>
        </Card>
      </div>
      <CreatePolicyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function PolicyTable({
  policies,
}: {
  policies: import("@mini-infra/types").VaultPolicyInfo[];
}) {
  const publish = usePublishVaultPolicy();
  const del = useDeleteVaultPolicy();
  if (policies.length === 0) {
    return <p className="text-muted-foreground">No policies yet.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {policies.map((p) => (
        <div
          key={p.id}
          className="flex items-center justify-between border rounded p-3"
        >
          <div>
            <div className="flex items-center gap-2">
              <Link
                to={`/vault/policies/${p.id}`}
                className="font-medium hover:underline"
                data-tour={`vault-policy-link-${p.name}`}
              >
                {p.displayName}
              </Link>
              {p.isSystem && <Badge variant="secondary">system</Badge>}
              {p.publishedVersion > 0 ? (
                <Badge>published v{p.publishedVersion}</Badge>
              ) : (
                <Badge variant="outline">draft</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">{p.name}</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await publish.mutateAsync(p.id);
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Publish failed");
                }
              }}
              disabled={publish.isPending}
            >
              <IconUpload className="h-4 w-4 mr-1" /> Publish
            </Button>
            {!p.isSystem && (
              <Button
                variant="ghost"
                size="sm"
                onClick={async () => {
                  if (!confirm(`Delete policy ${p.name}?`)) return;
                  try {
                    await del.mutateAsync(p.id);
                  } catch (err) {
                    toast.error(
                      err instanceof Error ? err.message : "Delete failed",
                    );
                  }
                }}
              >
                <IconTrash className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function CreatePolicyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [hcl, setHcl] = useState(
    `path "secret/data/example/*" {\n  capabilities = ["read", "list"]\n}\n`,
  );
  const create = useCreateVaultPolicy();

  const submit = async () => {
    try {
      await create.mutateAsync({
        name,
        displayName,
        description: description || undefined,
        draftHclBody: hcl,
      });
      onOpenChange(false);
      setName("");
      setDisplayName("");
      setDescription("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New Vault Policy</DialogTitle>
          <DialogDescription>
            Define an HCL policy. Publish afterwards to push to Vault.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="name">Name (lowercase, alphanum + hyphen)</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app-secrets"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="displayName">Display Name</Label>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="desc">Description (optional)</Label>
            <Input
              id="desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="hcl">HCL Body</Label>
            <Textarea
              id="hcl"
              value={hcl}
              onChange={(e) => setHcl(e.target.value)}
              rows={12}
              className="font-mono text-sm"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={!name || !displayName || !hcl || create.isPending}
          >
            {create.isPending ? "Creating…" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
