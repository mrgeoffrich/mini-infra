import { useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import * as yaml from "js-yaml";
import { toast } from "sonner";
import {
  IconAlertTriangle,
  IconBan,
  IconInfoCircle,
  IconLoader2,
  IconUpload,
} from "@tabler/icons-react";
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
import { useCreateStackTemplate } from "@/hooks/use-stack-templates";
import {
  mapComposeToTemplate,
  type ComposeImportIssue,
  type ComposeImportResult,
} from "@mini-infra/types";

/**
 * Turn a `compose.yml` into a template draft.
 *
 * Most people arriving at Mini Infra already have a compose file, so this is the
 * on-ramp. The mapping itself lives in `@mini-infra/types` (pure, and shared with
 * anything server-side that wants it later); this is just the paste-box and,
 * more importantly, the **report**.
 *
 * The report is the point. Compose is a much bigger surface than a stack
 * template, so an import always leaves something behind — `build:`, `deploy:`,
 * host-env interpolation. The Code view used to discard what it couldn't
 * represent and say nothing, and the failure mode was always the same: the user
 * discovered it when the thing they'd configured didn't happen. So everything not
 * carried across is shown here, before the template exists.
 */
const LEVEL_META: Record<
  ComposeImportIssue["level"],
  { label: string; icon: typeof IconBan; className: string }
> = {
  error: {
    label: "Blocking",
    icon: IconBan,
    className: "text-destructive",
  },
  unsupported: {
    label: "Not imported",
    icon: IconAlertTriangle,
    className: "text-amber-600 dark:text-amber-400",
  },
  lossy: {
    label: "Changed",
    icon: IconAlertTriangle,
    className: "text-amber-600 dark:text-amber-400",
  },
  defaulted: {
    label: "Assumed",
    icon: IconInfoCircle,
    className: "text-muted-foreground",
  },
};

const LEVEL_ORDER: ComposeImportIssue["level"][] = ["error", "unsupported", "lossy", "defaulted"];

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100);
}

export function ImportComposeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const createMutation = useCreateStackTemplate();
  const fileRef = useRef<HTMLInputElement>(null);

  const [text, setText] = useState("");
  const [displayName, setDisplayName] = useState("");
  // A YAML syntax error is distinct from a mapping issue: the file never parsed,
  // so there is nothing to report about its contents.
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<ComposeImportResult | null>(null);

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
    setResult(mapComposeToTemplate(doc));
  }

  async function onFile(file: File) {
    const content = await file.text();
    if (!displayName) setDisplayName(file.name.replace(/\.(ya?ml)$/i, ""));
    analyse(content);
  }

  function reset() {
    setText("");
    setDisplayName("");
    setParseError(null);
    setResult(null);
  }

  async function onCreate() {
    if (!result?.draft) return;
    const name = slugify(displayName);
    try {
      const created = await createMutation.mutateAsync({
        name,
        displayName,
        description: "Imported from a Docker Compose file",
        scope: "environment",
        networks: result.draft.networks,
        volumes: result.draft.volumes,
        services: result.draft.services,
      });
      toast.success(`Imported ${result.draft.services.length} service(s) into "${displayName}"`);
      onOpenChange(false);
      reset();
      navigate(`/stack-templates/${created.id}`);
    } catch {
      // The global MutationCache.onError already raises an actionable toast; keep
      // the dialog open so the operator can adjust and retry.
    }
  }

  const blocking = result?.issues.filter((i) => i.level === "error") ?? [];
  const canCreate =
    result?.ok === true &&
    result.draft != null &&
    blocking.length === 0 &&
    displayName.trim() !== "" &&
    slugify(displayName) !== "" &&
    !createMutation.isPending;

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
          <DialogTitle>Import from Docker Compose</DialogTitle>
          <DialogDescription>
            Paste a <code>compose.yml</code> to turn it into a template. Anything Compose can
            express that a stack template can&apos;t is listed below rather than dropped.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="compose-yaml">Compose file</Label>
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
              id="compose-yaml"
              data-tour="compose-import-input"
              value={text}
              onChange={(e) => analyse(e.target.value)}
              placeholder={"services:\n  web:\n    image: nginx:1.25\n    ports:\n      - \"8080:80\""}
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
              {result.draft && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Imports as</span>
                  <Badge variant="secondary">
                    {result.draft.services.length} service
                    {result.draft.services.length === 1 ? "" : "s"}
                  </Badge>
                  {result.draft.volumes.length > 0 && (
                    <Badge variant="secondary">{result.draft.volumes.length} volume(s)</Badge>
                  )}
                  {result.draft.networks.length > 0 && (
                    <Badge variant="secondary">{result.draft.networks.length} network(s)</Badge>
                  )}
                </div>
              )}

              {result.issues.length > 0 && (
                <div className="max-h-56 space-y-3 overflow-y-auto rounded-md border p-3">
                  {LEVEL_ORDER.map((level) => {
                    const forLevel = result.issues.filter((i) => i.level === level);
                    if (forLevel.length === 0) return null;
                    const meta = LEVEL_META[level];
                    const Icon = meta.icon;

                    return (
                      <div key={level}>
                        <div
                          className={`mb-1 flex items-center gap-1.5 text-sm font-medium ${meta.className}`}
                        >
                          <Icon className="h-4 w-4" />
                          {meta.label}
                          <span className="text-muted-foreground">({forLevel.length})</span>
                        </div>
                        <ul className="space-y-1">
                          {forLevel.map((issue, i) => (
                            <li key={`${issue.path}-${i}`} className="text-xs">
                              {issue.path && (
                                <code className="mr-1 rounded bg-muted px-1 py-0.5">
                                  {issue.path}
                                </code>
                              )}
                              <span className="text-muted-foreground">{issue.message}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* A blocking issue means at least one service can't be represented
                  at all. Importing the rest would produce a template that quietly
                  does less than the compose file did — so say what's wrong and
                  what to do, rather than leaving a disabled button with no
                  explanation. */}
              {blocking.length > 0 ? (
                <Alert variant="destructive">
                  <IconBan className="h-4 w-4" />
                  <AlertDescription>
                    {blocking.length === 1
                      ? "One service can't be imported"
                      : `${blocking.length} services can't be imported`}
                    , so the template would be missing part of what this file
                    describes. Fix the blocking issue above — or drop those services from the file
                    — then paste it again.
                  </AlertDescription>
                </Alert>
              ) : (
                result.ok && (
                  <div className="space-y-2">
                    <Label htmlFor="compose-name">Template name</Label>
                    <Input
                      id="compose-name"
                      data-tour="compose-import-name"
                      value={displayName}
                      onChange={(e) => setDisplayName(e.target.value)}
                      placeholder="My application"
                    />
                    {displayName.trim() !== "" && (
                      <p className="text-xs text-muted-foreground">
                        Identifier: <code>{slugify(displayName) || "—"}</code>
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
            disabled={createMutation.isPending}
          >
            Cancel
          </Button>
          <Button onClick={() => void onCreate()} disabled={!canCreate}>
            {createMutation.isPending && <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />}
            Create template
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
