import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type {
  StackResourceInput,
  StackResourceOutput,
} from "@mini-infra/types";

interface TemplateResourceIOSectionProps {
  resourceInputs: StackResourceInput[];
  resourceOutputs: StackResourceOutput[];
  readOnly?: boolean;
  onChange: (
    inputs: StackResourceInput[],
    outputs: StackResourceOutput[],
  ) => void;
}

const RESOURCE_TYPE_HINT = "e.g. docker-network";
const PURPOSE_HINT = "e.g. applications";

export function TemplateResourceIOSection({
  resourceInputs,
  resourceOutputs,
  readOnly = false,
  onChange,
}: TemplateResourceIOSectionProps) {
  function updateInputs(next: StackResourceInput[]) {
    onChange(next, resourceOutputs);
  }
  function updateOutputs(next: StackResourceOutput[]) {
    onChange(resourceInputs, next);
  }

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-medium">Resource I/O</h3>
      <p className="text-xs text-muted-foreground">
        Declare infrastructure resources this stack produces (outputs) or
        depends on (inputs) — e.g. a shared application network.
      </p>

      {/* Outputs */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium">Outputs ({resourceOutputs.length})</h4>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                updateOutputs([
                  ...resourceOutputs,
                  { type: "", purpose: "", joinSelf: false },
                ])
              }
            >
              <IconPlus className="mr-1 h-4 w-4" />
              Add Output
            </Button>
          )}
        </div>

        {resourceOutputs.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            No resource outputs declared.
          </p>
        ) : (
          <div className="space-y-2">
            {resourceOutputs.map((out, idx) => (
              <div
                key={idx}
                className="flex items-end gap-2 rounded-md border p-2"
              >
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">Type</label>
                  <Input
                    placeholder={RESOURCE_TYPE_HINT}
                    value={out.type}
                    disabled={readOnly}
                    onChange={(e) =>
                      updateOutputs(
                        resourceOutputs.map((o, i) =>
                          i === idx ? { ...o, type: e.target.value } : o,
                        ),
                      )
                    }
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">Purpose</label>
                  <Input
                    placeholder={PURPOSE_HINT}
                    value={out.purpose}
                    disabled={readOnly}
                    onChange={(e) =>
                      updateOutputs(
                        resourceOutputs.map((o, i) =>
                          i === idx ? { ...o, purpose: e.target.value } : o,
                        ),
                      )
                    }
                  />
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <Checkbox
                    id={`out-joinself-${idx}`}
                    checked={out.joinSelf ?? false}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      updateOutputs(
                        resourceOutputs.map((o, i) =>
                          i === idx ? { ...o, joinSelf: checked === true } : o,
                        ),
                      )
                    }
                  />
                  <label
                    htmlFor={`out-joinself-${idx}`}
                    className="text-xs text-muted-foreground cursor-pointer"
                  >
                    Join self
                  </label>
                </div>
                {!readOnly && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="mb-0.5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                    onClick={() =>
                      updateOutputs(resourceOutputs.filter((_, i) => i !== idx))
                    }
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Inputs */}
      <div className="space-y-2 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <h4 className="text-sm font-medium">Inputs ({resourceInputs.length})</h4>
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                updateInputs([
                  ...resourceInputs,
                  { type: "", purpose: "", optional: false },
                ])
              }
            >
              <IconPlus className="mr-1 h-4 w-4" />
              Add Input
            </Button>
          )}
        </div>

        {resourceInputs.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            No resource inputs declared.
          </p>
        ) : (
          <div className="space-y-2">
            {resourceInputs.map((inp, idx) => (
              <div
                key={idx}
                className="flex items-end gap-2 rounded-md border p-2"
              >
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">Type</label>
                  <Input
                    placeholder={RESOURCE_TYPE_HINT}
                    value={inp.type}
                    disabled={readOnly}
                    onChange={(e) =>
                      updateInputs(
                        resourceInputs.map((o, i) =>
                          i === idx ? { ...o, type: e.target.value } : o,
                        ),
                      )
                    }
                  />
                </div>
                <div className="flex-1">
                  <label className="text-xs text-muted-foreground">Purpose</label>
                  <Input
                    placeholder={PURPOSE_HINT}
                    value={inp.purpose}
                    disabled={readOnly}
                    onChange={(e) =>
                      updateInputs(
                        resourceInputs.map((o, i) =>
                          i === idx ? { ...o, purpose: e.target.value } : o,
                        ),
                      )
                    }
                  />
                </div>
                <div className="flex items-center gap-2 pb-2">
                  <Checkbox
                    id={`in-optional-${idx}`}
                    checked={inp.optional ?? false}
                    disabled={readOnly}
                    onCheckedChange={(checked) =>
                      updateInputs(
                        resourceInputs.map((o, i) =>
                          i === idx ? { ...o, optional: checked === true } : o,
                        ),
                      )
                    }
                  />
                  <label
                    htmlFor={`in-optional-${idx}`}
                    className="text-xs text-muted-foreground cursor-pointer"
                  >
                    Optional
                  </label>
                </div>
                {!readOnly && (
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="mb-0.5 h-9 w-9 shrink-0 text-destructive hover:text-destructive"
                    onClick={() =>
                      updateInputs(resourceInputs.filter((_, i) => i !== idx))
                    }
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
