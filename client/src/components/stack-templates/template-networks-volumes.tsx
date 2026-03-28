import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { IconPlus, IconTrash } from "@tabler/icons-react";
import type { StackNetwork, StackVolume } from "@mini-infra/types";

interface AddItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onAdd: (name: string, driver: string) => void;
  driverPlaceholder: string;
}

function AddItemDialog({
  open,
  onOpenChange,
  title,
  onAdd,
  driverPlaceholder,
}: AddItemDialogProps) {
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("");

  function handleAdd() {
    if (!name.trim()) return;
    onAdd(name.trim(), driver.trim());
    setName("");
    setDriver("");
    onOpenChange(false);
  }

  function handleOpenChange(value: boolean) {
    if (!value) {
      setName("");
      setDriver("");
    }
    onOpenChange(value);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <label className="text-sm font-medium">Name</label>
            <Input
              placeholder="Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
          <div className="space-y-1">
            <label className="text-sm font-medium">Driver</label>
            <Input
              placeholder={driverPlaceholder}
              value={driver}
              onChange={(e) => setDriver(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleAdd} disabled={!name.trim()}>
            Add
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface TemplateNetworksVolumesProps {
  networks: StackNetwork[];
  volumes: StackVolume[];
  readOnly?: boolean;
  onNetworksChange: (networks: StackNetwork[]) => void;
  onVolumesChange: (volumes: StackVolume[]) => void;
}

export function TemplateNetworksVolumes({
  networks,
  volumes,
  readOnly = false,
  onNetworksChange,
  onVolumesChange,
}: TemplateNetworksVolumesProps) {
  const [addNetworkOpen, setAddNetworkOpen] = useState(false);
  const [addVolumeOpen, setAddVolumeOpen] = useState(false);

  function handleAddNetwork(name: string, driver: string) {
    onNetworksChange([
      ...networks,
      { name, driver: driver || undefined },
    ]);
  }

  function handleDeleteNetwork(index: number) {
    onNetworksChange(networks.filter((_, i) => i !== index));
  }

  function handleAddVolume(name: string, driver: string) {
    onVolumesChange([
      ...volumes,
      { name, driver: driver || undefined },
    ]);
  }

  function handleDeleteVolume(index: number) {
    onVolumesChange(volumes.filter((_, i) => i !== index));
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* Networks */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            Networks{" "}
            <span className="text-muted-foreground font-normal">
              ({networks.length})
            </span>
          </span>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddNetworkOpen(true)}
            >
              <IconPlus className="h-4 w-4 mr-1" />
              Add
            </Button>
          )}
        </div>
        {networks.length === 0 ? (
          <div className="border border-dashed rounded-md px-3 py-4 text-center text-sm text-muted-foreground">
            No networks
          </div>
        ) : (
          <div className="space-y-1">
            {networks.map((network, index) => (
              <div
                key={index}
                className="flex items-center justify-between border rounded-md px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">
                    {network.name}
                  </span>
                  {network.driver && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {network.driver}
                    </span>
                  )}
                </div>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleDeleteNetwork(index)}
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Volumes */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">
            Volumes{" "}
            <span className="text-muted-foreground font-normal">
              ({volumes.length})
            </span>
          </span>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAddVolumeOpen(true)}
            >
              <IconPlus className="h-4 w-4 mr-1" />
              Add
            </Button>
          )}
        </div>
        {volumes.length === 0 ? (
          <div className="border border-dashed rounded-md px-3 py-4 text-center text-sm text-muted-foreground">
            No volumes
          </div>
        ) : (
          <div className="space-y-1">
            {volumes.map((volume, index) => (
              <div
                key={index}
                className="flex items-center justify-between border rounded-md px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium truncate">
                    {volume.name}
                  </span>
                  {volume.driver && (
                    <span className="text-xs text-muted-foreground shrink-0">
                      {volume.driver}
                    </span>
                  )}
                </div>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 shrink-0"
                    onClick={() => handleDeleteVolume(index)}
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <AddItemDialog
        open={addNetworkOpen}
        onOpenChange={setAddNetworkOpen}
        title="Add Network"
        onAdd={handleAddNetwork}
        driverPlaceholder="bridge"
      />
      <AddItemDialog
        open={addVolumeOpen}
        onOpenChange={setAddVolumeOpen}
        title="Add Volume"
        onAdd={handleAddVolume}
        driverPlaceholder="local"
      />
    </div>
  );
}
