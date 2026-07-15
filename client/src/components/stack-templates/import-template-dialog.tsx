import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as yaml from "js-yaml";
import { toast } from "sonner";
import { IconBan, IconLoader2, IconUpload } from "@tabler/icons-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useImportTemplate } from "@/hooks/use-stack-templates";
import { ImportIssueList } from "@/components/stack-templates/import-issue-list";
import {
  mapTemplateImportDocument,
  type TemplateImportResult,
} from "@mini-infra/types";

/**
 * Import a stack template exported from another Mini Infra instance.
 *
 * Symmetric with the Compose importer: the mapping/validation lives in
 * `@mini-infra/types` (`mapTemplateImportDocument`) and runs here so the report
 * appears *before* anything is created — an export can't carry secrets or
 * origin-instance state (a custom NATS subject prefix is allowlisted by template
 * ID, which the copy doesn't inherit), and those are surfaced, never silent. The
 * server re-runs the same mapping and validation on submit.
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function ImportTemplateDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const importMutation = useImportTemplate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<TemplateImportResult | null>(null);

  function analyse(next: string) {
    setText(next);
    setParseError(null);
    setResult(null);

    if (next.trim() === "") return;

    let doc: unknown;
    try {
      doc = yaml.load(next);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : "Could not parse the file as YAML.");
      return;
    }
    const mapped = mapTemplateImportDocument(doc);
    setResult(mapped);
    // Prefill the name from the file the first time, letting the operator rename
    // (required if a template with that name already exists on this instance).
    if (mapped.request?.displayName && displayName.trim() === "") {
      setDisplayName(mapped.request.displayName);
    }
  }

  async function onFile(file: File) {
    const content = await file.text();
    analyse(content);
  }

  function reset() {
    setText("");
    setDisplayName("");
    setParseError(null);
    setResult(null);
  }

  async function onImport() {
    if (!result?.ok || !result.request) return;
    const name = slugify(displayName);
    try {
      const created = await importMutation.mutateAsync({
        yaml: text,
        name,
        displayName,
      });
      const notices = result.issues.length;
      toast.success(
        notices > 0
          ? `Imported "${displayName}" with ${notices} notice${notices === 1 ? "" : "s"} to review`
          : `Imported "${displayName}"`,
      );
      onOpenChange(false);
      reset();
      navigate(`/stack-templates/${created.id}`);
    } catch {
      // The global MutationCache.onError raises an actionable toast; keep the
      // dialog open so the operator can rename (on a name clash) and retry.
    }
  }

  const blocking = result?.issues.filter((i) => i.level === "error") ?? [];
  const canImport =
    result?.ok === true &&
    result.request != null &&
    blocking.length === 0 &&
    displayName.trim() !== "" &&
    slugify(displayName) !== "" &&
    !importMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Import a template</DialogTitle>
          <DialogDescription>
            Paste or upload a template exported from another Mini Infra instance. Anything the
            file can&apos;t carry across — secrets, an origin-specific NATS prefix — is listed
            below rather than applied silently.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="template-yaml">Template file</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileRef.current?.click()}
              >
                <IconUpload className="mr-1 h-3.5 w-3.5" />
                Choose a file
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".yml,.yaml"
                className="hidden"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) void onFile(file);
                  e.target.value = "";
                }}
              />
            </div>
            <Textarea
              id="template-yaml"
              data-tour="import-template-input"
              value={text}
              onChange={(e) => analyse(e.target.value)}
              placeholder={"format: mini-infra.stack-template/v1\ntemplate:\n  name: my-app\n  ..."}
              className="h-44 font-mono text-xs"
              spellCheck={false}
            />
          </div>

          {parseError && (
            <Alert variant="destructive">
              <IconBan className="h-4 w-4" />
              <AlertDescription>
                <span className="font-medium">That isn&apos;t valid YAML.</span> {parseError}
              </AlertDescription>
            </Alert>
          )}

          {result && (
            <>
              {result.request && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Imports as</span>
                  <Badge variant="secondary">
                    {result.request.services.length} service
                    {result.request.services.length === 1 ? "" : "s"}
                  </Badge>
                  <Badge variant="secondary">{result.request.scope}</Badge>
                </div>
              )}

              <ImportIssueList issues={result.issues} />

              {blocking.length > 0 ? (
                <Alert variant="destructive">
                  <IconBan className="h-4 w-4" />
                  <AlertDescription>
                    This file can&apos;t be imported as it stands. Fix the blocking issue(s)
                    above — usually a wrong or missing <code>format</code>, or a missing name —
                    then try again.
                  </AlertDescription>
                </Alert>
              ) : (
                result.ok && (
                  <div className="space-y-2">
                    <Label htmlFor="template-name">Template name</Label>
                    <Input
                      id="template-name"
                      data-tour="import-template-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="My application"
                    />
                    {displayName.trim() !== "" && (
                      <p className="text-xs text-muted-foreground">
                        Identifier: <code>{slugify(displayName) || "—"}</code>. Rename if a
                        template with this name already exists here.
                      </p>
                    )}
                  </div>
                )
              )}
            </>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={importMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => void onImport()} disabled={!canImport}>
            {importMutation.isPending && <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />}
            Import template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
