import { useState } from "react";
import { IconTemplate, IconPlus } from "@tabler/icons-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { TemplateTable } from "@/components/stack-templates/template-table";
import { CreateTemplateDialog } from "@/components/stack-templates/create-template-dialog";
import { useStackTemplates } from "@/hooks/use-stack-templates";
import type { StackTemplateSource, StackTemplateScope } from "@mini-infra/types";

export default function StackTemplatesPage() {
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [source, setSource] = useState<StackTemplateSource | undefined>(undefined);
  const [scope, setScope] = useState<StackTemplateScope | undefined>(undefined);
  const [includeArchived, setIncludeArchived] = useState(false);

  const { data: templates, isLoading, error } = useStackTemplates({
    source,
    scope,
    includeArchived,
  });

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
              <IconTemplate className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Stack Templates</h1>
              <p className="text-muted-foreground">
                Manage reusable templates for deploying application stacks.
              </p>
            </div>
          </div>
          <Button onClick={() => setCreateDialogOpen(true)}>
            <IconPlus className="h-4 w-4 mr-2" />
            Create Template
          </Button>
        </div>

        {/* Filters */}
        <div className="mt-4 flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <Label htmlFor="source-filter" className="text-sm text-muted-foreground shrink-0">
              Source
            </Label>
            <Select
              value={source ?? "all"}
              onValueChange={(val) =>
                setSource(val === "all" ? undefined : (val as StackTemplateSource))
              }
            >
              <SelectTrigger id="source-filter" className="w-[130px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="system">System</SelectItem>
                <SelectItem value="user">User</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Label htmlFor="scope-filter" className="text-sm text-muted-foreground shrink-0">
              Scope
            </Label>
            <Select
              value={scope ?? "all"}
              onValueChange={(val) =>
                setScope(val === "all" ? undefined : (val as StackTemplateScope))
              }
            >
              <SelectTrigger id="scope-filter" className="w-[140px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All</SelectItem>
                <SelectItem value="host">Host</SelectItem>
                <SelectItem value="environment">Environment</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Checkbox
              id="include-archived"
              checked={includeArchived}
              onCheckedChange={(checked) => setIncludeArchived(!!checked)}
            />
            <Label
              htmlFor="include-archived"
              className="text-sm cursor-pointer"
            >
              Include archived
            </Label>
          </div>
        </div>
      </div>

      <div className="px-4 lg:px-6 max-w-6xl">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-14 w-full" />
            ))}
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {error instanceof Error
                ? error.message
                : "Failed to load stack templates"}
            </AlertDescription>
          </Alert>
        ) : (
          <>
            <TemplateTable templates={templates ?? []} />
            {templates && templates.length > 0 && (
              <p className="mt-2 text-sm text-muted-foreground">
                {templates.length} template{templates.length !== 1 ? "s" : ""}
              </p>
            )}
          </>
        )}
      </div>

      <CreateTemplateDialog
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
      />
    </div>
  );
}
