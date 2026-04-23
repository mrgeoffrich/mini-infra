import { useState } from "react";
import type {
  StackParameterDefinition,
  StackParameterValue,
  EnvironmentNetworkType,
} from "@mini-infra/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@/components/ui/toggle-group";
import { IconPlus, IconEdit, IconTrash, IconX } from "@tabler/icons-react";
import { ParameterEditDialog } from "./parameter-edit-dialog";

type NetworkTab = "defaults" | EnvironmentNetworkType;

interface TemplateParametersSectionProps {
  parameters: StackParameterDefinition[];
  defaultParameterValues: Record<string, StackParameterValue>;
  networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>;
  templateNetworkType?: EnvironmentNetworkType | null;
  readOnly?: boolean;
  onParametersChange: (
    params: StackParameterDefinition[],
    defaults: Record<string, StackParameterValue>,
    networkTypeDefaults?: Record<string, Record<string, StackParameterValue>>,
  ) => void;
}

function coerceValue(
  raw: string,
  type: StackParameterDefinition["type"],
): StackParameterValue | null {
  if (raw === "") return null;
  if (type === "number") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "boolean") {
    return raw === "true";
  }
  return raw;
}

export function TemplateParametersSection({
  parameters,
  defaultParameterValues,
  networkTypeDefaults = {},
  templateNetworkType,
  readOnly = false,
  onParametersChange,
}: TemplateParametersSectionProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);
  // Network Type tabs are only useful when the template isn't pinned to a
  // specific networkType — a pinned template already knows its env.
  const showNetworkTabs = !templateNetworkType && parameters.length > 0;
  const [networkTab, setNetworkTab] = useState<NetworkTab>("defaults");

  const editingParameter =
    editingIndex !== null ? (parameters[editingIndex] ?? null) : null;
  const editingDefaultValue =
    editingParameter !== null
      ? defaultParameterValues[editingParameter.name]
      : undefined;

  function handleSave(
    param: StackParameterDefinition,
    defaultValue?: StackParameterValue,
  ) {
    const newParams = [...parameters];
    const newDefaults = { ...defaultParameterValues };

    if (isAdding) {
      newParams.push(param);
    } else if (editingIndex !== null) {
      newParams[editingIndex] = param;
    }

    if (defaultValue !== undefined) {
      newDefaults[param.name] = defaultValue;
    } else {
      delete newDefaults[param.name];
    }

    onParametersChange(newParams, newDefaults, networkTypeDefaults);
    setIsAdding(false);
    setEditingIndex(null);
  }

  function handleDelete(index: number) {
    const param = parameters[index];
    const newParams = parameters.filter((_, i) => i !== index);
    const newDefaults = { ...defaultParameterValues };
    const newNetworkDefaults: Record<string, Record<string, StackParameterValue>> = {};
    if (param) {
      delete newDefaults[param.name];
      // Drop override entries for the removed parameter across all network types.
      for (const [nt, map] of Object.entries(networkTypeDefaults)) {
        const cleaned = { ...map };
        delete cleaned[param.name];
        if (Object.keys(cleaned).length > 0) newNetworkDefaults[nt] = cleaned;
      }
    }
    onParametersChange(newParams, newDefaults, newNetworkDefaults);
  }

  function handleDialogOpenChange(open: boolean) {
    if (!open) {
      setIsAdding(false);
      setEditingIndex(null);
    }
  }

  function setOverride(
    nt: EnvironmentNetworkType,
    paramName: string,
    value: StackParameterValue | null,
  ) {
    const next: Record<string, Record<string, StackParameterValue>> = {};
    for (const [key, map] of Object.entries(networkTypeDefaults)) {
      next[key] = { ...map };
    }
    if (!next[nt]) next[nt] = {};
    if (value === null) {
      delete next[nt][paramName];
      if (Object.keys(next[nt]).length === 0) delete next[nt];
    } else {
      next[nt][paramName] = value;
    }
    onParametersChange(parameters, defaultParameterValues, next);
  }

  const dialogOpen = isAdding || editingIndex !== null;
  const dialogParameter = isAdding ? null : editingParameter;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-sm font-medium">Parameters ({parameters.length})</h3>
        <div className="flex items-center gap-2">
          {showNetworkTabs && (
            <ToggleGroup
              type="single"
              size="sm"
              variant="outline"
              value={networkTab}
              onValueChange={(v) => v && setNetworkTab(v as NetworkTab)}
            >
              <ToggleGroupItem value="defaults">Defaults</ToggleGroupItem>
              <ToggleGroupItem value="local">Local</ToggleGroupItem>
              <ToggleGroupItem value="internet">Internet</ToggleGroupItem>
            </ToggleGroup>
          )}
          {!readOnly && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => setIsAdding(true)}
            >
              <IconPlus className="mr-1 h-4 w-4" />
              Add Parameter
            </Button>
          )}
        </div>
      </div>

      {parameters.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">No parameters defined.</p>
        </div>
      ) : networkTab === "defaults" ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Default</TableHead>
              {!readOnly && <TableHead className="w-20">Actions</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {parameters.map((param, index) => {
              const dv =
                defaultParameterValues[param.name] !== undefined
                  ? defaultParameterValues[param.name]
                  : param.default;
              return (
                <TableRow key={param.name}>
                  <TableCell>
                    <div>
                      <span className="font-mono text-sm">{param.name}</span>
                      {param.description && (
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {param.description}
                        </p>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{param.type}</TableCell>
                  <TableCell className="font-mono text-sm">
                    {String(dv)}
                  </TableCell>
                  {!readOnly && (
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setEditingIndex(index)}
                        >
                          <IconEdit className="h-4 w-4" />
                        </Button>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => handleDelete(index)}
                        >
                          <IconTrash className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      ) : (
        <NetworkOverrideTable
          parameters={parameters}
          defaultParameterValues={defaultParameterValues}
          networkType={networkTab}
          overrides={networkTypeDefaults[networkTab] ?? {}}
          readOnly={readOnly}
          onSetOverride={setOverride}
        />
      )}

      <ParameterEditDialog
        open={dialogOpen}
        onOpenChange={handleDialogOpenChange}
        parameter={dialogParameter}
        defaultValue={editingDefaultValue}
        onSave={handleSave}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface NetworkOverrideTableProps {
  parameters: StackParameterDefinition[];
  defaultParameterValues: Record<string, StackParameterValue>;
  networkType: EnvironmentNetworkType;
  overrides: Record<string, StackParameterValue>;
  readOnly: boolean;
  onSetOverride: (
    nt: EnvironmentNetworkType,
    paramName: string,
    value: StackParameterValue | null,
  ) => void;
}

function NetworkOverrideTable({
  parameters,
  defaultParameterValues,
  networkType,
  overrides,
  readOnly,
  onSetOverride,
}: NetworkOverrideTableProps) {
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        Values here override the global default when the template is instantiated
        in a <span className="font-mono">{networkType}</span> environment. Leave
        blank to inherit.
      </p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Parameter</TableHead>
            <TableHead>Inherited default</TableHead>
            <TableHead>Override</TableHead>
            {!readOnly && <TableHead className="w-12" />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {parameters.map((param) => {
            const inherited =
              defaultParameterValues[param.name] !== undefined
                ? defaultParameterValues[param.name]
                : param.default;
            const override = overrides[param.name];
            const hasOverride = override !== undefined;
            return (
              <TableRow key={param.name}>
                <TableCell>
                  <span className="font-mono text-sm">{param.name}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    ({param.type})
                  </span>
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {String(inherited)}
                </TableCell>
                <TableCell>
                  {param.type === "boolean" ? (
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={hasOverride ? Boolean(override) : Boolean(inherited)}
                        disabled={readOnly}
                        onCheckedChange={(checked) =>
                          onSetOverride(networkType, param.name, checked)
                        }
                      />
                      {hasOverride && (
                        <span className="text-xs text-muted-foreground">
                          override
                        </span>
                      )}
                    </div>
                  ) : (
                    <Input
                      type={param.type === "number" ? "number" : "text"}
                      placeholder={String(inherited)}
                      value={hasOverride ? String(override) : ""}
                      disabled={readOnly}
                      onChange={(e) => {
                        const coerced = coerceValue(e.target.value, param.type);
                        onSetOverride(networkType, param.name, coerced);
                      }}
                    />
                  )}
                </TableCell>
                {!readOnly && (
                  <TableCell>
                    {hasOverride && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        onClick={() =>
                          onSetOverride(networkType, param.name, null)
                        }
                      >
                        <IconX className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
