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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconTrash, IconPlus, IconNetwork } from "@tabler/icons-react";
import { cn } from "@/lib/utils";
interface Port {
  containerPort: number;
  hostPort?: number;
  protocol?: "tcp" | "udp";
}

interface PortEditorProps {
  form: UseFormReturn<any>;
  className?: string;
}

export function PortEditor({ form, className }: PortEditorProps) {
  const { control } = form;
  const { fields, append, remove } = useFieldArray({
    control,
    name: "containerConfig.ports",
  });

  const [newPort, setNewPort] = useState<Port>({
    containerPort: 3000,
    hostPort: undefined,
    protocol: "tcp",
  });

  const handleAdd = () => {
    if (newPort.containerPort) {
      append({
        ...newPort,
        hostPort: newPort.hostPort || undefined,
      });
      setNewPort({
        containerPort: 3000,
        hostPort: undefined,
        protocol: "tcp",
      });
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && newPort.containerPort) {
      e.preventDefault();
      handleAdd();
    }
  };

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader>
        <div className="flex items-center space-x-2">
          <IconNetwork className="w-5 h-5 text-green-500" />
          <div>
            <CardTitle>Port Mappings</CardTitle>
            <CardDescription>
              Configure port mappings between container and host
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Add new port mapping */}
        <div className="grid grid-cols-12 gap-2 items-end">
          <div className="col-span-4">
            <Label htmlFor="container-port">Container Port</Label>
            <Input
              id="container-port"
              type="number"
              placeholder="3000"
              min="1"
              max="65535"
              value={newPort.containerPort}
              onChange={(e) =>
                setNewPort((prev) => ({
                  ...prev,
                  containerPort: parseInt(e.target.value) || 0,
                }))
              }
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="col-span-4">
            <Label htmlFor="host-port">Host Port (Optional)</Label>
            <Input
              id="host-port"
              type="number"
              placeholder="Auto"
              min="1"
              max="65535"
              value={newPort.hostPort || ""}
              onChange={(e) =>
                setNewPort((prev) => ({
                  ...prev,
                  hostPort: e.target.value
                    ? parseInt(e.target.value)
                    : undefined,
                }))
              }
              onKeyDown={handleKeyDown}
            />
          </div>
          <div className="col-span-3">
            <Label htmlFor="protocol">Protocol</Label>
            <Select
              value={newPort.protocol || "tcp"}
              onValueChange={(value) =>
                setNewPort((prev) => ({
                  ...prev,
                  protocol: value as "tcp" | "udp",
                }))
              }
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="tcp">TCP</SelectItem>
                <SelectItem value="udp">UDP</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="col-span-1">
            <Button
              type="button"
              onClick={handleAdd}
              disabled={!newPort.containerPort || newPort.containerPort < 1}
              size="sm"
            >
              <IconPlus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        {/* List existing port mappings */}
        {fields.length > 0 && (
          <div className="space-y-2">
            <Label className="text-sm font-medium">Current Port Mappings</Label>
            <div className="max-h-48 overflow-y-auto space-y-2 border rounded-md p-3 bg-muted/30">
              {fields.map((field, index) => (
                <div
                  key={field.id}
                  className="flex items-center justify-between p-2 bg-background border rounded-md"
                >
                  <div className="flex-1 grid grid-cols-3 gap-4">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Container Port
                      </Label>
                      <Input
                        type="number"
                        min="1"
                        max="65535"
                        {...control.register(
                          `containerConfig.ports.${index}.containerPort` as const,
                          {
                            valueAsNumber: true,
                          },
                        )}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Host Port
                      </Label>
                      <Input
                        type="number"
                        min="1"
                        max="65535"
                        placeholder="Auto"
                        {...control.register(
                          `containerConfig.ports.${index}.hostPort` as const,
                          {
                            valueAsNumber: true,
                          },
                        )}
                        className="h-8 text-xs"
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Protocol
                      </Label>
                      <Select
                        value={
                          form.getValues(
                            `containerConfig.ports.${index}.protocol`,
                          ) || "tcp"
                        }
                        onValueChange={(value) =>
                          form.setValue(
                            `containerConfig.ports.${index}.protocol`,
                            value as "tcp" | "udp",
                          )
                        }
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tcp">TCP</SelectItem>
                          <SelectItem value="udp">UDP</SelectItem>
                        </SelectContent>
                      </Select>
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
            <IconNetwork className="w-8 h-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No port mappings configured</p>
            <p className="text-xs">Add port mappings using the form above</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
