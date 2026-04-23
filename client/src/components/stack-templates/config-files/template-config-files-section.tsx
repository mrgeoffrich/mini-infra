import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconPlus, IconEdit, IconTrash, IconFile } from "@tabler/icons-react";
import type {
  StackTemplateConfigFileInfo,
  StackTemplateConfigFileInput,
} from "@mini-infra/types";
import { ConfigFileDrawer } from "./config-file-drawer";

interface TemplateConfigFilesSectionProps {
  configFiles: StackTemplateConfigFileInfo[];
  serviceNames: string[];
  volumeNames: string[];
  readOnly?: boolean;
  onConfigFilesChange: (files: StackTemplateConfigFileInput[]) => void;
}

function toInput(
  f: StackTemplateConfigFileInfo,
): StackTemplateConfigFileInput {
  return {
    serviceName: f.serviceName,
    fileName: f.fileName,
    volumeName: f.volumeName,
    mountPath: f.mountPath,
    content: f.content,
    permissions: f.permissions ?? undefined,
    owner: f.owner ?? undefined,
  };
}

export function TemplateConfigFilesSection({
  configFiles,
  serviceNames,
  volumeNames,
  readOnly = false,
  onConfigFilesChange,
}: TemplateConfigFilesSectionProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const drawerOpen = isAdding || editingIndex !== null;
  const drawerFile = isAdding ? null : editingIndex !== null ? toInput(configFiles[editingIndex]!) : null;

  function handleSave(file: StackTemplateConfigFileInput) {
    const list = configFiles.map(toInput);
    if (isAdding) {
      onConfigFilesChange([...list, file]);
    } else if (editingIndex !== null) {
      const next = [...list];
      next[editingIndex] = file;
      onConfigFilesChange(next);
    }
    setIsAdding(false);
    setEditingIndex(null);
  }

  function handleDelete(index: number) {
    const next = configFiles.map(toInput).filter((_, i) => i !== index);
    onConfigFilesChange(next);
  }

  function handleDrawerOpenChange(open: boolean) {
    if (!open) {
      setIsAdding(false);
      setEditingIndex(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Config Files ({configFiles.length})</h3>
        {!readOnly && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setIsAdding(true)}
          >
            <IconPlus className="mr-1 h-4 w-4" />
            Add Config File
          </Button>
        )}
      </div>

      {configFiles.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No config files defined.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {configFiles.map((f, index) => {
            const lines = f.content.split("\n").length;
            return (
              <button
                type="button"
                key={`${f.serviceName}-${f.volumeName}-${f.mountPath}`}
                onClick={() => !readOnly && setEditingIndex(index)}
                disabled={readOnly}
                className="w-full text-left rounded-md border bg-card p-3 transition-colors hover:bg-muted/30 disabled:cursor-default disabled:hover:bg-card"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <IconFile className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="font-mono text-sm">{f.fileName}</span>
                  <Badge variant="outline" className="text-xs">{f.serviceName}</Badge>
                  <span className="text-xs text-muted-foreground">
                    {lines} line{lines === 1 ? "" : "s"}
                  </span>
                  {!readOnly && (
                    <div
                      className="ml-auto flex items-center gap-1"
                      onClick={(e) => e.stopPropagation()}
                    >
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
                  )}
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  <span className="font-mono">{f.volumeName}</span>
                  <span className="mx-1">→</span>
                  <span className="font-mono">{f.mountPath}</span>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <ConfigFileDrawer
        open={drawerOpen}
        onOpenChange={handleDrawerOpenChange}
        file={drawerFile}
        serviceNames={serviceNames}
        volumeNames={volumeNames}
        onSave={handleSave}
      />
    </div>
  );
}
