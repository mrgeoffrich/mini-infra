import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTemplatePredicates } from "@/hooks/use-stack-templates";
import {
  PREREQUISITE_MIN_STATES,
  PREREQUISITE_SCOPE_MATCHES,
  type MinState,
  type ScopeMatch,
  type StackTemplatePrerequisite,
} from "@mini-infra/types";

/**
 * Author a template's `requires` — the things that must already be true before a
 * stack from this template can be applied.
 *
 * Two kinds:
 *  - `stack` — a stack from the named template must exist and be at least
 *    `minState`. (e.g. the NATS template requires a synced `vault` stack.)
 *  - `predicate` — a named server-side check must pass (e.g. `vault-bootstrapped`).
 *
 * These were API-only, which is a shame: they drive the prerequisites banner and
 * hard-block apply with a 409, so a template author had no way to express "this
 * needs Vault first" without POSTing a draft by hand.
 */
export function TemplateRequiresSection({
  requires,
  readOnly = false,
  onChange,
}: {
  requires: StackTemplatePrerequisite[];
  readOnly?: boolean;
  onChange: (requires: StackTemplatePrerequisite[]) => void;
}) {
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>Prerequisites</CardTitle>
            <CardDescription>
              What must already be in place before a stack from this template can be
              applied. Unmet prerequisites block Apply and are explained in a banner.
            </CardDescription>
          </div>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
              <IconPlus className="mr-1 h-4 w-4" />
              Add prerequisite
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {requires.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            None. This template can be applied on its own.
          </p>
        ) : (
          <ul className="space-y-2">
            {requires.map((req, i) => (
              <li
                key={`${req.kind}-${i}`}
                className="flex items-center gap-3 rounded-md border px-3 py-2 text-sm"
              >
                <Badge variant="secondary" className="text-xs">
                  {req.kind}
                </Badge>
                {req.kind === "stack" ? (
                  <span className="flex flex-wrap items-center gap-x-2">
                    <span className="font-mono">{req.templateName}</span>
                    <span className="text-muted-foreground">
                      must be at least <strong>{req.minState}</strong>, matched{" "}
                      <strong>{req.scopeMatch}</strong>
                    </span>
                  </span>
                ) : (
                  <span className="font-mono">{req.name}</span>
                )}
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-auto h-7 w-7"
                    onClick={() => onChange(requires.filter((_, x) => x !== i))}
                    aria-label="Remove prerequisite"
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AddPrerequisiteDialog
        open={adding}
        onOpenChange={setAdding}
        onAdd={(req) => {
          onChange([...requires, req]);
          setAdding(false);
        }}
      />
    </Card>
  );
}

function AddPrerequisiteDialog({
  open,
  onOpenChange,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (req: StackTemplatePrerequisite) => void;
}) {
  const { data: predicates } = useTemplatePredicates();
  const [kind, setKind] = useState<"stack" | "predicate">("stack");
  const [templateName, setTemplateName] = useState("");
  const [minState, setMinState] = useState<MinState>("synced");
  const [scopeMatch, setScopeMatch] = useState<ScopeMatch>("host");
  const [predicateName, setPredicateName] = useState("");

  // The server's regex for a template name — surfaced here rather than as a 400.
  const templateNameValid = /^[a-zA-Z0-9_-]+$/.test(templateName);
  const canAdd =
    kind === "stack" ? templateName.length > 0 && templateNameValid : !!predicateName;

  function handleAdd() {
    onAdd(
      kind === "stack"
        ? { kind: "stack", templateName, minState, scopeMatch }
        : { kind: "predicate", name: predicateName },
    );
    setTemplateName("");
    setPredicateName("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add prerequisite</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label>Kind</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as "stack" | "predicate")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="stack">Stack — another stack must be deployed</SelectItem>
                <SelectItem value="predicate">Predicate — a named check must pass</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {kind === "stack" ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="req-template">Template name</Label>
                <Input
                  id="req-template"
                  value={templateName}
                  onChange={(e) => setTemplateName(e.target.value)}
                  placeholder="vault"
                />
                {templateName && !templateNameValid && (
                  <p className="text-xs text-destructive">
                    Letters, numbers, _ and - only
                  </p>
                )}
              </div>

              <div className="grid gap-2">
                <Label>Minimum state</Label>
                <Select value={minState} onValueChange={(v) => setMinState(v as MinState)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PREREQUISITE_MIN_STATES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label>Scope match</Label>
                <Select
                  value={scopeMatch}
                  onValueChange={(v) => setScopeMatch(v as ScopeMatch)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PREREQUISITE_SCOPE_MATCHES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {s}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  <strong>host</strong> matches host-scoped stacks;{" "}
                  <strong>environment</strong> any environment;{" "}
                  <strong>same-environment</strong> only the applying stack&apos;s own
                  (and is rejected for host-scoped stacks).
                </p>
              </div>
            </>
          ) : (
            <div className="grid gap-2">
              <Label>Predicate</Label>
              {/* Fetched from the server registry, not hardcoded — a free-text
                  field here would just 400 on a typo. */}
              <Select value={predicateName} onValueChange={setPredicateName}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a predicate" />
                </SelectTrigger>
                <SelectContent>
                  {(predicates ?? []).map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canAdd} onClick={handleAdd}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
