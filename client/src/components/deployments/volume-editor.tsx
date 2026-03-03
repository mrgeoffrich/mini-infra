import { useState } from "react";
import { useFieldArray, UseFormReturn } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { IconTrash, IconPlus, IconDatabase } from "@tabler/icons-react";
import { cn } from "@/lib/utils";

interface Volume {
  hostPath: string;
  containerPath: string;
  mode: "rw";
}

interface VolumeEditorProps {
  form: UseFormReturn<any>;
  className?: string;
}

export function VolumeEditor({ form, className }: VolumeEditorProps) {
  const { control } = form;
  const { fields, append, remove } = useFieldArray({
    control,
    name: "containerConfig.volumes",
  });

  const [newVolume, setNewVolume] = useState<Volume>({
    hostPath: "",
    containerPath: "",
    mode: "rw",
  });

  const handleAdd = () => {
    if (newVolume.hostPath.trim() && newVolume.containerPath.trim()) {
      append(newVolume);
      setNewVolume({ hostPath: "", containerPath: "", mode: "rw" });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (
      e.key === "Enter" &&
      newVolume.hostPath.trim() &&
      newVolume.containerPath.trim()
    ) {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <div className="flex items-center space-x-2">
          <IconDatabase className="w-5 h-5 text-orange-500" />
          <div>
            <CardTitle>Volume Mounts</CardTitle>
            <CardDescription>
              Configure volume mounts (all mounts are read-write)
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new volume mount */}
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-5">
            <Label htmlFor="volume-name">Volume Name</Label>
            <Input
              id="volume-name"
              placeholder="my-volume"
              value={newVolume.hostPath}
              onChange={(e) =>
                setNewVolume((prev) => ({ ...prev, hostPath: e.target.value }))
              }
              onKeyDown={handleKeyDown}
              className="font-mono"
            />
          </div>
          <div className="col-span-6">
            <Label htmlFor="container-path">Container Path</Label>
            <Input
              id="container-path"
              placeholder="/container/path"
              value={newVolume.containerPath}
              onChange={(e) =>
                setNewVolume((prev) => ({
                  ...prev,
                  containerPath: e.target.value,
                }))
              }
              onKeyDown={handleKeyDown}
              className="font-mono"
            />
          </div>
          <div className="col-span-1">
            <Button
              type="button"
              onClick={handleAdd}
              disabled={
                !newVolume.hostPath.trim() || !newVolume.containerPath.trim()
              }
              size="sm"
            >
              <IconPlus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* List existing volume mounts */}
        {fields.length > 0 && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Current Volume Mounts</Label>
            <div className="max-h-48 overflow-y-auto space-y-2 border rounded-md p-3 bg-muted/30">
              {fields.map((field, index) => (
                <div
                  key={field.id}
                  className="flex items-center justify-between p-2 bg-background border rounded-md"
                >
                  <div className="flex-1 grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Volume Name
                      </Label>
                      <Input
                        {...control.register(
                          `containerConfig.volumes.${index}.hostPath` as const,
                        )}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Container Path
                      </Label>
                      <Input
                        {...control.register(
                          `containerConfig.volumes.${index}.containerPath` as const,
                        )}
                        className="h-8 text-xs font-mono"
                      />
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(index)}
                    className="ml-2 text-destructive hover:text-destructive"
                  >
                    <IconTrash className="w-4 h-4" />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        )}

        {fields.length === 0 && (
          <div className="text-center py-8 text-muted-foreground">
            <IconDatabase className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No volume mounts configured</p>
            <p className="text-xs">Add volume mounts using the form above</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
