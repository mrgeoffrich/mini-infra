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
import { IconTrash, IconPlus, IconSettings } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
interface EnvVar {
  name: string;
  value: string;
}

interface EnvVarEditorProps {
  form: UseFormReturn<any>;
  className?: string;
}

export function EnvVarEditor({ form, className }: EnvVarEditorProps) {
  const { control } = form;
  const { fields, append, remove } = useFieldArray({
    control,
    name: "containerConfig.environment",
  });

  const [newEnvVar, setNewEnvVar] = useState<EnvVar>({
    name: "",
    value: "",
  });

  const handleAdd = () => {
    if (newEnvVar.name.trim() && newEnvVar.value.trim()) {
      append(newEnvVar);
      setNewEnvVar({ name: "", value: "" });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newEnvVar.name.trim() && newEnvVar.value.trim()) {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <div className="flex items-center space-x-2">
          <IconSettings className="w-5 h-5 text-blue-500" />
          <div>
            <CardTitle>Environment Variables</CardTitle>
            <CardDescription>
              Configure environment variables for the container
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new environment variable */}
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-5">
            <Label htmlFor="env-name">Name</Label>
            <Input
              id="env-name"
              placeholder="ENV_VAR_NAME"
              value={newEnvVar.name}
              onChange={(e) =>
                setNewEnvVar((prev) => ({
                  ...prev,
                  name: e.target.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9_]/g, "_"),
                }))
              }
              onKeyDown={handleKeyDown}
              className="font-mono"
            />
          </div>
          <div className="col-span-6">
            <Label htmlFor="env-value">Value</Label>
            <Input
              id="env-value"
              placeholder="environment variable value"
              value={newEnvVar.value}
              onChange={(e) =>
                setNewEnvVar((prev) => ({ ...prev, value: e.target.value }))
              }
              onKeyDown={handleKeyDown}
              className="font-mono"
            />
          </div>
          <div className="col-span-1">
            <Button
              type="button"
              onClick={handleAdd}
              disabled={!newEnvVar.name.trim() || !newEnvVar.value.trim()}
              size="sm"
            >
              <IconPlus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* List existing environment variables */}
        {fields.length > 0 && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">
              Current Environment Variables
            </Label>
            <div className="max-h-64 overflow-y-auto space-y-2 border rounded-md p-3 bg-muted/30">
              {fields.map((field, index) => (
                <div
                  key={field.id}
                  className="flex items-center justify-between p-2 bg-background border rounded-md"
                >
                  <div className="flex-1 grid grid-cols-2 gap-4">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Name
                      </Label>
                      <Input
                        {...control.register(
                          `containerConfig.environment.${index}.name` as const,
                        )}
                        className="h-8 text-xs font-mono"
                        onChange={(e) => {
                          const sanitizedName = e.target.value
                            .toUpperCase()
                            .replace(/[^A-Z0-9_]/g, "_");
                          form.setValue(
                            `containerConfig.environment.${index}.name`,
                            sanitizedName,
                          );
                        }}
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Value
                      </Label>
                      <Input
                        {...control.register(
                          `containerConfig.environment.${index}.value` as const,
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
            <IconSettings className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No environment variables configured</p>
            <p className="text-xs">
              Add environment variables using the form above
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
