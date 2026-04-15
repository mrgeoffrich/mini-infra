import { useState } from "react";
import { Environment, EnvironmentNetworkType } from "@mini-infra/types";
import { useEnvironments } from "@/hooks/use-environments";
import { EnvironmentCard } from "./environment-card";
import { EnvironmentCreateDialog } from "./environment-create-dialog";
import { EnvironmentEditDialog } from "./environment-edit-dialog";
import { EnvironmentDeleteDialog } from "./environment-delete-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { IconPlus, IconAlertCircle } from "@tabler/icons-react";

interface EnvironmentListProps {
  className?: string;
}

export function EnvironmentList({ className }: EnvironmentListProps) {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedEnvironment, setSelectedEnvironment] = useState<Environment | null>(null);

  const {
    data: environmentsData,
    isLoading,
    isError,
    error,
    refetch,
  } = useEnvironments({
    // Always fetch both slots on a single page; there are at most two.
    filters: { page: 1, limit: 100 },
    refetchInterval: 10000,
  });

  const environments = environmentsData?.environments || [];
  const localEnv = environments.find((e) => e.networkType === "local") ?? null;
  const internetEnv = environments.find((e) => e.networkType === "internet") ?? null;
  const canCreate = !localEnv || !internetEnv;

  const handleEdit = (environment: Environment) => {
    setSelectedEnvironment(environment);
    setEditDialogOpen(true);
  };

  const handleDelete = (environment: Environment) => {
    setSelectedEnvironment(environment);
    setDeleteDialogOpen(true);
  };

  if (isError) {
    return (
      <div className={className}>
        <Alert variant="destructive">
          <IconAlertCircle className="h-4 w-4" />
          <AlertDescription>
            Failed to load environments: {error instanceof Error ? error.message : "Unknown error"}
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const existingNetworkTypes: EnvironmentNetworkType[] = [];
  if (localEnv) existingNetworkTypes.push("local");
  if (internetEnv) existingNetworkTypes.push("internet");

  return (
    <div className={className}>
      {/* Header Actions */}
      {canCreate && (
        <div className="flex items-center justify-between mb-6">
          <Button
            onClick={() => setCreateDialogOpen(true)}
            className="flex items-center gap-2"
          >
            <IconPlus className="h-4 w-4" />
            Create Environment
          </Button>
        </div>
      )}

      {/* Content — fixed two-slot layout: Local left, Internet right */}
      {isLoading ? (
        <div className="grid gap-6 md:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Skeleton className="h-6 w-32" />
                    <Skeleton className="h-6 w-20" />
                  </div>
                  <Skeleton className="h-4 w-full" />
                  <Skeleton className="h-4 w-2/3" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          {localEnv && (
            <div className="md:col-start-1">
              <EnvironmentCard
                environment={localEnv}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            </div>
          )}
          {internetEnv && (
            <div className="md:col-start-2">
              <EnvironmentCard
                environment={internetEnv}
                onEdit={handleEdit}
                onDelete={handleDelete}
              />
            </div>
          )}
        </div>
      )}

      {/* Dialogs */}
      <EnvironmentCreateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        existingNetworkTypes={existingNetworkTypes}
        onSuccess={() => refetch()}
      />

      {selectedEnvironment && (
        <>
          <EnvironmentEditDialog
            open={editDialogOpen}
            onOpenChange={setEditDialogOpen}
            environment={selectedEnvironment}
            onSuccess={() => {
              refetch();
              setSelectedEnvironment(null);
            }}
          />

          <EnvironmentDeleteDialog
            open={deleteDialogOpen}
            onOpenChange={setDeleteDialogOpen}
            environment={selectedEnvironment}
            onSuccess={() => {
              refetch();
              setSelectedEnvironment(null);
            }}
          />
        </>
      )}
    </div>
  );
}
