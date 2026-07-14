import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { IconPlus, IconLoader2, IconTrash, IconTemplate, IconFileCode } from "@tabler/icons-react";
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
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ServiceEditDrawer } from "@/components/stack-templates/service-drawer/service-edit-drawer";
import { InstantiateTemplateDialog } from "@/components/stack-templates/instantiate-template-dialog";
import { useCreateStack } from "@/hooks/use-stacks";
import { useStackTemplates } from "@/hooks/use-stack-templates";
import { useEnvironments } from "@/hooks/use-environments";
import type { StackServiceDefinition, StackTemplateInfo } from "@mini-infra/types";

/** Host-scoped stacks have no environment; the Select needs a non-empty value. */
const HOST_SCOPE = "__host__";

/**
 * Create a stack — from a template, or from scratch.
 *
 * `POST /api/stacks` (templateless stacks) has existed all along with zero client
 * callers: such a stack could only be born via the API, yet appeared on the
 * /stacks page like any other. That is a half-supported feature, and the roadmap's
 * instruction was to decide rather than leave it that way. This is the decision —
 * ad-hoc stacks are supported, and here is the UI.
 *
 * The from-scratch path reuses `ServiceEditDrawer` unchanged. It was already
 * template-agnostic: it edits the shared `StackServiceDefinition`, which is the
 * same shape a stack's services take. Only the sink differs — a template draft
 * there, `POST /api/stacks` here.
 */
export function CreateStackDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [mode, setMode] = useState<"choose" | "scratch">("choose");
  const [template, setTemplate] = useState<StackTemplateInfo | null>(null);

  function reset() {
    setMode("choose");
    setTemplate(null);
  }

  return (
    <>
      <Dialog
        open={open && template === null}
        onOpenChange={(next) => {
          if (!next) reset();
          onOpenChange(next);
        }}
      >
        <DialogContent className="max-w-2xl">
          {mode === "choose" ? (
            <ChooseSource onPickTemplate={setTemplate} onScratch={() => setMode("scratch")} />
          ) : (
            <FromScratch
              onDone={() => {
                reset();
                onOpenChange(false);
              }}
              onBack={() => setMode("choose")}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* The P2 install dialog already collects name + environment + parameters +
          input values for a template, and navigates to the new stack. Reusing it
          means the from-template path here and Install on the template page
          cannot drift apart. */}
      {template && (
        <InstantiateTemplateDialog
          template={template}
          open
          onOpenChange={(next) => {
            if (!next) {
              reset();
              onOpenChange(false);
            }
          }}
        />
      )}
    </>
  );
}

function ChooseSource({
  onPickTemplate,
  onScratch,
}: {
  onPickTemplate: (template: StackTemplateInfo) => void;
  onScratch: () => void;
}) {
  const { data: templates, isLoading } = useStackTemplates();
  // A template with no published version cannot be instantiated (the server
  // 400s), and an archived one is deliberately retired — don't offer either.
  const installable = (templates ?? []).filter((t) => !!t.currentVersionId && !t.isArchived);

  return (
    <>
      <DialogHeader>
        <DialogTitle>Create a stack</DialogTitle>
        <DialogDescription>
          Install a published template, or define the services yourself.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div>
          <div className="mb-2 flex items-center gap-2 text-sm font-medium">
            <IconTemplate className="h-4 w-4" />
            From a template
          </div>
          {isLoading ? (
            <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
              <IconLoader2 className="h-4 w-4 animate-spin" />
              Loading templates…
            </div>
          ) : installable.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">
              No templates with a published version yet.
            </p>
          ) : (
            <ul className="max-h-56 space-y-1 overflow-y-auto">
              {installable.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => onPickTemplate(t)}
                    className="w-full rounded-md border p-2 text-left text-sm transition-colors hover:border-primary/50 hover:bg-muted/50"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{t.displayName || t.name}</span>
                      <Badge variant="outline" className="text-xs">
                        {t.source}
                      </Badge>
                      <Badge variant="secondary" className="ml-auto text-xs">
                        {t.scope}
                      </Badge>
                    </div>
                    {t.description && (
                      <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
                        {t.description}
                      </p>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="border-t pt-4">
          <Button variant="outline" className="w-full" onClick={onScratch}>
            <IconFileCode className="mr-2 h-4 w-4" />
            Define services from scratch
          </Button>
          <p className="mt-2 text-xs text-muted-foreground">
            Creates a stack with no template behind it. It won&apos;t offer upgrades —
            there is no template to publish new versions of — but you can edit its
            definition directly at any time.
          </p>
        </div>
      </div>
    </>
  );
}

function FromScratch({ onDone, onBack }: { onDone: () => void; onBack: () => void }) {
  const navigate = useNavigate();
  const createStack = useCreateStack();
  const { data: envData } = useEnvironments();
  const environments = envData?.environments ?? [];

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [environmentId, setEnvironmentId] = useState<string>(HOST_SCOPE);
  const [services, setServices] = useState<StackServiceDefinition[]>([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [editing, setEditing] = useState<StackServiceDefinition | null>(null);

  // A StatelessWeb service is load-balanced by HAProxy, so the server refuses one
  // with no routing. The drawer defaults new services to StatelessWeb, which means
  // the straight-line path through this dialog produced an invalid stack and a bare
  // "Validation failed" toast — the server's actual complaint never reached the
  // person who could act on it. Say it here, next to the service, before they submit.
  const unroutedServices = services.filter(
    (s) => s.serviceType === "StatelessWeb" && !s.routing,
  );

  const canSubmit =
    name.trim().length > 0 &&
    services.length > 0 &&
    unroutedServices.length === 0 &&
    !createStack.isPending;

  function handleSaveService(service: StackServiceDefinition) {
    setServices((prev) => {
      const i = prev.findIndex((s) => s.serviceName === editing?.serviceName);
      if (i === -1) return [...prev, { ...service, order: prev.length }];
      const next = [...prev];
      next[i] = { ...service, order: prev[i].order };
      return next;
    });
    setDrawerOpen(false);
    setEditing(null);
  }

  async function handleCreate() {
    const stack = await createStack.mutateAsync({
      name: name.trim(),
      ...(description.trim() ? { description: description.trim() } : {}),
      ...(environmentId !== HOST_SCOPE ? { environmentId } : {}),
      networks: [],
      volumes: [],
      services: services.map((s, i) => ({ ...s, order: i })),
    });
    toast.success(`Stack '${stack.name}' created`, {
      description: "It is Undeployed — Apply to deploy it.",
    });
    onDone();
    navigate(`/stacks/${stack.id}`);
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>New stack</DialogTitle>
        <DialogDescription>
          Nothing is deployed on create — the stack starts Undeployed and you Apply
          when the definition is right.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        <div className="grid gap-2">
          <Label htmlFor="stack-name">Name</Label>
          <Input
            id="stack-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-stack"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="stack-description">Description (optional)</Label>
          <Input
            id="stack-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>

        <div className="grid gap-2">
          <Label>Scope</Label>
          <Select value={environmentId} onValueChange={setEnvironmentId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={HOST_SCOPE}>Host (no environment)</SelectItem>
              {environments.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  {env.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-2">
          <div className="flex items-center justify-between">
            <Label>Services</Label>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEditing(null);
                setDrawerOpen(true);
              }}
            >
              <IconPlus className="mr-1 h-4 w-4" />
              Add service
            </Button>
          </div>
          {services.length === 0 ? (
            <p className="rounded-md border border-dashed py-4 text-center text-sm text-muted-foreground">
              A stack needs at least one service.
            </p>
          ) : (
            <ul className="space-y-1">
              {services.map((s) => {
                const unrouted = s.serviceType === "StatelessWeb" && !s.routing;
                return (
                  <li
                    key={s.serviceName}
                    className={cn(
                      "rounded-md border px-3 py-2 text-sm",
                      unrouted && "border-destructive/50",
                    )}
                  >
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="flex-1 text-left hover:underline"
                        onClick={() => {
                          setEditing(s);
                          setDrawerOpen(true);
                        }}
                      >
                        <span className="font-medium">{s.serviceName}</span>
                        <span className="ml-2 font-mono text-xs text-muted-foreground">
                          {s.dockerImage}:{s.dockerTag}
                        </span>
                      </button>
                      <Badge variant="secondary" className="text-xs">
                        {s.serviceType}
                      </Badge>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() =>
                          setServices((prev) =>
                            prev.filter((x) => x.serviceName !== s.serviceName),
                          )
                        }
                        aria-label={`Remove ${s.serviceName}`}
                      >
                        <IconTrash className="h-4 w-4" />
                      </Button>
                    </div>
                    {unrouted && (
                      <p className="mt-1 text-xs text-destructive">
                        A StatelessWeb service is load-balanced, so it needs routing.
                        Open it and set a hostname or path on the Routing tab — or
                        change its type to Stateful.
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onBack} disabled={createStack.isPending}>
          Back
        </Button>
        <Button disabled={!canSubmit} onClick={handleCreate}>
          {createStack.isPending && <IconLoader2 className="mr-1 h-4 w-4 animate-spin" />}
          Create stack
        </Button>
      </DialogFooter>

      <ServiceEditDrawer
        open={drawerOpen}
        onOpenChange={setDrawerOpen}
        service={editing}
        onSave={handleSaveService}
      />
    </>
  );
}
