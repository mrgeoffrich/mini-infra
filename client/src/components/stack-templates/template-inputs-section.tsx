import { useState } from "react";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { TemplateInputDeclaration } from "@mini-infra/types";

/**
 * Author a template's `inputs` — the values an operator must supply when the
 * template is installed (an API key, a password), stored encrypted on the stack.
 *
 * These were API-only: the graphical editor had no section for them and the Code
 * view dropped them entirely, so a template with inputs could only be authored by
 * POSTing a draft by hand. They are high-leverage — `required` inputs drive the
 * Install dialog's fields, and `rotateOnUpgrade` drives the upgrade flow's
 * "supply fresh values" step.
 *
 * Fully controlled, no local draft state — mirrors TemplateParametersSection: any
 * edit builds the complete next array and calls onChange, which saves a draft.
 */
export function TemplateInputsSection({
  inputs,
  readOnly = false,
  onChange,
}: {
  inputs: TemplateInputDeclaration[];
  readOnly?: boolean;
  onChange: (inputs: TemplateInputDeclaration[]) => void;
}) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const editing =
    editingIndex !== null ? inputs[editingIndex] : isAdding ? emptyInput() : null;

  function handleSave(next: TemplateInputDeclaration) {
    if (editingIndex !== null) {
      const copy = [...inputs];
      copy[editingIndex] = next;
      onChange(copy);
    } else {
      onChange([...inputs, next]);
    }
    setEditingIndex(null);
    setIsAdding(false);
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle>Inputs</CardTitle>
            <CardDescription>
              Values the operator supplies at install. Stored encrypted on the stack
              and never returned by the API.
            </CardDescription>
          </div>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={() => setIsAdding(true)}>
              <IconPlus className="mr-1 h-4 w-4" />
              Add input
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {inputs.length === 0 ? (
          <p className="py-2 text-sm text-muted-foreground">
            No inputs. Add one if installing this template requires a secret.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Flags</TableHead>
                {!readOnly && <TableHead className="w-10" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {inputs.map((input, i) => (
                <TableRow key={input.name}>
                  <TableCell>
                    <button
                      type="button"
                      disabled={readOnly}
                      className="font-mono text-sm hover:underline disabled:no-underline"
                      onClick={() => setEditingIndex(i)}
                    >
                      {input.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {input.description || "—"}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {input.required && (
                        <Badge variant="secondary" className="text-xs">
                          required
                        </Badge>
                      )}
                      {input.sensitive && (
                        <Badge variant="secondary" className="text-xs">
                          sensitive
                        </Badge>
                      )}
                      {input.rotateOnUpgrade && (
                        <Badge variant="outline" className="text-xs">
                          rotate on upgrade
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  {!readOnly && (
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => onChange(inputs.filter((_, x) => x !== i))}
                        aria-label={`Remove ${input.name}`}
                      >
                        <IconTrash className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <InputEditDialog
        open={editing !== null}
        input={editing}
        existingNames={inputs
          .filter((_, i) => i !== editingIndex)
          .map((i) => i.name)}
        onOpenChange={(open) => {
          if (!open) {
            setEditingIndex(null);
            setIsAdding(false);
          }
        }}
        onSave={handleSave}
      />
    </Card>
  );
}

function emptyInput(): TemplateInputDeclaration {
  // Matches the Zod defaults (sensitive/required true, rotateOnUpgrade false) —
  // an input is a secret you must supply unless the author says otherwise.
  return { name: "", sensitive: true, required: true, rotateOnUpgrade: false };
}

function InputEditDialog({
  open,
  input,
  existingNames,
  onOpenChange,
  onSave,
}: {
  open: boolean;
  input: TemplateInputDeclaration | null;
  existingNames: string[];
  onOpenChange: (open: boolean) => void;
  onSave: (input: TemplateInputDeclaration) => void;
}) {
  const [draft, setDraft] = useState<TemplateInputDeclaration>(emptyInput());
  const [touched, setTouched] = useState(false);

  // Re-seed whenever the dialog opens on a different input.
  const key = input?.name ?? "__new__";
  const [seededKey, setSeededKey] = useState<string | null>(null);
  if (open && seededKey !== key) {
    setDraft(input ?? emptyInput());
    setSeededKey(key);
    setTouched(false);
  }
  if (!open && seededKey !== null) setSeededKey(null);

  // The server's regex — surfaced here so the author isn't told by a 400.
  const nameValid = /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(draft.name);
  const nameTaken = existingNames.includes(draft.name);
  const error = !draft.name
    ? "Name is required"
    : !nameValid
      ? "Must start with a letter, then letters, numbers, _ or -"
      : nameTaken
        ? "An input with this name already exists"
        : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{input?.name ? "Edit input" : "Add input"}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-2">
            <Label htmlFor="input-name">Name</Label>
            <Input
              id="input-name"
              value={draft.name}
              onChange={(e) => {
                setDraft({ ...draft, name: e.target.value });
                setTouched(true);
              }}
              placeholder="apiKey"
            />
            {touched && error && <p className="text-xs text-destructive">{error}</p>}
          </div>

          <div className="grid gap-2">
            <Label htmlFor="input-description">Description</Label>
            <Input
              id="input-description"
              value={draft.description ?? ""}
              onChange={(e) =>
                setDraft({ ...draft, description: e.target.value || undefined })
              }
              placeholder="Shown to the operator at install"
            />
          </div>

          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.required}
                onCheckedChange={(v) => setDraft({ ...draft, required: v === true })}
              />
              Required — install won&apos;t proceed without it
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.sensitive}
                onCheckedChange={(v) => setDraft({ ...draft, sensitive: v === true })}
              />
              Sensitive — masked in the UI
            </label>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.rotateOnUpgrade}
                onCheckedChange={(v) =>
                  setDraft({ ...draft, rotateOnUpgrade: v === true })
                }
              />
              Rotate on upgrade — a fresh value must be supplied every upgrade
            </label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!!error}
            onClick={() => {
              onSave(draft);
              onOpenChange(false);
            }}
          >
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
