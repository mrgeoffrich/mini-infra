import { useState } from "react";
import type {
  StackParameterDefinition,
  StackParameterValue,
} from "@mini-infra/types";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { IconPlus, IconEdit, IconTrash } from "@tabler/icons-react";
import { ParameterEditDialog } from "./parameter-edit-dialog";

interface TemplateParametersSectionProps {
  parameters: StackParameterDefinition[];
  defaultParameterValues: Record<string, StackParameterValue>;
  readOnly?: boolean;
  onParametersChange: (
    params: StackParameterDefinition[],
    defaults: Record<string, StackParameterValue>,
  ) => void;
}

export function TemplateParametersSection({
  parameters,
  defaultParameterValues,
  readOnly = false,
  onParametersChange,
}: TemplateParametersSectionProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

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

    onParametersChange(newParams, newDefaults);
    setIsAdding(false);
    setEditingIndex(null);
  }

  function handleDelete(index: number) {
    const param = parameters[index];
    const newParams = parameters.filter((_, i) => i !== index);
    const newDefaults = { ...defaultParameterValues };
    if (param) {
      delete newDefaults[param.name];
    }
    onParametersChange(newParams, newDefaults);
  }

  function handleDialogOpenChange(open: boolean) {
    if (!open) {
      setIsAdding(false);
      setEditingIndex(null);
    }
  }

  const dialogOpen = isAdding || editingIndex !== null;
  const dialogParameter = isAdding ? null : editingParameter;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">
          Parameters ({parameters.length})
        </h3>
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

      {parameters.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">No parameters defined.</p>
        </div>
      ) : (
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
