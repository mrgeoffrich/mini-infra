import { useState, useEffect, useRef } from "react";
import { useParams, Link } from "react-router-dom";
import { IconArrowLeft, IconUpload, IconDeviceFloppy } from "@tabler/icons-react";
import {
  useVaultPolicy,
  useUpdateVaultPolicy,
  usePublishVaultPolicy,
} from "@/hooks/use-vault";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";

export default function VaultPolicyDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: policy, isLoading } = useVaultPolicy(id);
  const update = useUpdateVaultPolicy();
  const publish = usePublishVaultPolicy();
  const [draft, setDraft] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");

  // Initialise the editable form fields from the loaded policy. We track the
  // last-seen policy id via a ref so the setState calls live inside a
  // ref-controlled branch (avoids set-state-in-effect) and we only re-init
  // when the policy id actually changes — preserving in-progress edits.
  const lastInitialisedIdRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!policy) return;
    const prev = lastInitialisedIdRef.current;
    if (prev === policy.id) return;
    lastInitialisedIdRef.current = policy.id;
    setDraft(policy.draftHclBody ?? "");
    setDisplayName(policy.displayName);
    setDescription(policy.description ?? "");
  }, [policy]);

  if (isLoading) {
    return (
      <div className="p-6">
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }
  if (!policy) return <div className="p-6">Policy not found</div>;

  const save = async () => {
    try {
      await update.mutateAsync({
        id: policy.id,
        input: {
          displayName,
          description,
          draftHclBody: draft,
        },
      });
      toast.success("Draft saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  };

  const publishNow = async () => {
    try {
      await save();
      await publish.mutateAsync(policy.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Publish failed");
    }
  };

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button asChild variant="ghost" size="sm">
            <Link to="/vault/policies">
              <IconArrowLeft className="h-4 w-4 mr-1" /> Back
            </Link>
          </Button>
          <div>
            <h1 className="text-2xl font-bold font-mono">{policy.name}</h1>
            <p className="text-muted-foreground text-sm">
              Published v{policy.publishedVersion}
              {policy.publishedAt &&
                ` · ${new Date(policy.publishedAt).toLocaleString()}`}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={save}
            disabled={update.isPending || policy.isSystem}
          >
            <IconDeviceFloppy className="h-4 w-4 mr-1" /> Save Draft
          </Button>
          <Button onClick={publishNow} disabled={publish.isPending}>
            <IconUpload className="h-4 w-4 mr-1" /> Save & Publish
          </Button>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-5xl">
        <Card>
          <CardHeader>
            <CardTitle>Policy</CardTitle>
            <CardDescription>
              {policy.isSystem
                ? "System-managed policy. Edits are saved locally but not persisted back to disk."
                : "Edit the HCL body below. Save creates a draft; Publish pushes it to Vault."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-col gap-2">
              <Label htmlFor="displayName">Display Name</Label>
              <Input
                id="displayName"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="desc">Description</Label>
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
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={24}
                className="font-mono text-sm"
              />
            </div>
            {policy.publishedHclBody &&
              policy.publishedHclBody !== draft && (
                <Card>
                  <CardHeader>
                    <CardTitle className="text-sm">
                      Published (v{policy.publishedVersion})
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <pre className="text-xs font-mono bg-muted p-2 rounded whitespace-pre-wrap">
                      {policy.publishedHclBody}
                    </pre>
                  </CardContent>
                </Card>
              )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
