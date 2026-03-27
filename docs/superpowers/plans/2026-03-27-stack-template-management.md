# Stack Template Management UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin pages for creating, editing, versioning, and publishing stack templates under the Admin tab.

**Architecture:** Two new routes (`/stack-templates` list page and `/stack-templates/:id` detail page) following existing admin page patterns. TanStack Query hooks for data fetching against existing API endpoints. Form-based editing with react-hook-form + Zod. Service editing in dialogs.

**Tech Stack:** React, React Router, TanStack Query, react-hook-form, Zod, shadcn/ui components, Tabler Icons, @mini-infra/types

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `client/src/hooks/use-stack-templates.ts` | TanStack Query hooks for all template CRUD operations |
| `client/src/app/stack-templates/page.tsx` | List page — table of all templates with filters |
| `client/src/app/stack-templates/[templateId]/page.tsx` | Detail page — version-focused editor with sidebar |
| `client/src/components/stack-templates/template-table.tsx` | Table component for list page |
| `client/src/components/stack-templates/template-metadata-card.tsx` | Metadata form card (display name, description, category, source, scope) |
| `client/src/components/stack-templates/template-services-section.tsx` | Services card list with add/edit/delete |
| `client/src/components/stack-templates/service-edit-dialog.tsx` | Multi-section dialog for editing a service |
| `client/src/components/stack-templates/template-parameters-section.tsx` | Parameters table with add/edit/delete |
| `client/src/components/stack-templates/parameter-edit-dialog.tsx` | Dialog for editing a parameter definition |
| `client/src/components/stack-templates/template-networks-volumes.tsx` | Networks & volumes compact grids |
| `client/src/components/stack-templates/version-sidebar.tsx` | Version history sidebar |
| `client/src/components/stack-templates/create-template-dialog.tsx` | Dialog for creating a new template (name, scope, etc.) |

### Modified Files

| File | Change |
|------|--------|
| `client/src/lib/route-config.ts` | Add route config entries for `/stack-templates` and child routes |
| `client/src/lib/routes.tsx` | Add router entries and imports for both pages |

---

### Task 1: TanStack Query Hooks

**Files:**
- Create: `client/src/hooks/use-stack-templates.ts`

- [ ] **Step 1: Create the hooks file with all fetch functions and query/mutation hooks**

```typescript
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  StackTemplateInfo,
  StackTemplateListResponse,
  StackTemplateResponse,
  StackTemplateVersionInfo,
  StackTemplateVersionListResponse,
  CreateStackTemplateRequest,
  UpdateStackTemplateRequest,
  DraftVersionInput,
  PublishDraftRequest,
} from "@mini-infra/types";

// --- Fetch functions ---

async function fetchStackTemplates(params?: {
  source?: string;
  scope?: string;
  includeArchived?: boolean;
}): Promise<StackTemplateInfo[]> {
  const searchParams = new URLSearchParams();
  if (params?.source) searchParams.set("source", params.source);
  if (params?.scope) searchParams.set("scope", params.scope);
  if (params?.includeArchived) searchParams.set("includeArchived", "true");

  const url = `/api/stack-templates${searchParams.toString() ? `?${searchParams}` : ""}`;
  const response = await fetch(url, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch stack templates: ${response.statusText}`);
  }
  const data: StackTemplateListResponse = await response.json();
  return data.data;
}

async function fetchStackTemplate(templateId: string): Promise<StackTemplateInfo> {
  const response = await fetch(`/api/stack-templates/${templateId}`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch stack template: ${response.statusText}`);
  }
  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function fetchStackTemplateVersions(
  templateId: string,
): Promise<StackTemplateVersionInfo[]> {
  const response = await fetch(`/api/stack-templates/${templateId}/versions`, {
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch versions: ${response.statusText}`);
  }
  const data: StackTemplateVersionListResponse = await response.json();
  return data.data;
}

async function createStackTemplate(
  request: CreateStackTemplateRequest,
): Promise<StackTemplateInfo> {
  const response = await fetch("/api/stack-templates", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to create template: ${response.statusText}`,
    );
  }
  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function updateStackTemplate(args: {
  templateId: string;
  request: UpdateStackTemplateRequest;
}): Promise<StackTemplateInfo> {
  const response = await fetch(`/api/stack-templates/${args.templateId}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.request),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to update template: ${response.statusText}`,
    );
  }
  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function saveDraft(args: {
  templateId: string;
  request: DraftVersionInput;
}): Promise<StackTemplateInfo> {
  const response = await fetch(`/api/stack-templates/${args.templateId}/draft`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args.request),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to save draft: ${response.statusText}`,
    );
  }
  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function publishDraft(args: {
  templateId: string;
  request: PublishDraftRequest;
}): Promise<StackTemplateInfo> {
  const response = await fetch(
    `/api/stack-templates/${args.templateId}/publish`,
    {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args.request),
    },
  );
  if (!response.ok) {
    const errorData = await response.json().catch(() => null);
    throw new Error(
      errorData?.message || `Failed to publish draft: ${response.statusText}`,
    );
  }
  const data: StackTemplateResponse = await response.json();
  return data.data;
}

async function discardDraft(templateId: string): Promise<void> {
  const response = await fetch(`/api/stack-templates/${templateId}/draft`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to discard draft: ${response.statusText}`);
  }
}

async function archiveTemplate(templateId: string): Promise<void> {
  const response = await fetch(`/api/stack-templates/${templateId}`, {
    method: "DELETE",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to archive template: ${response.statusText}`);
  }
}

// --- Query hooks ---

export function useStackTemplates(params?: {
  source?: string;
  scope?: string;
  includeArchived?: boolean;
}) {
  return useQuery({
    queryKey: ["stackTemplates", params],
    queryFn: () => fetchStackTemplates(params),
    retry: 1,
  });
}

export function useStackTemplate(templateId: string) {
  return useQuery({
    queryKey: ["stackTemplate", templateId],
    queryFn: () => fetchStackTemplate(templateId),
    enabled: !!templateId,
    retry: 1,
  });
}

export function useStackTemplateVersions(templateId: string) {
  return useQuery({
    queryKey: ["stackTemplateVersions", templateId],
    queryFn: () => fetchStackTemplateVersions(templateId),
    enabled: !!templateId,
    retry: 1,
  });
}

// --- Mutation hooks ---

export function useCreateStackTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: createStackTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
    },
  });
}

export function useUpdateStackTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: updateStackTemplate,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplate", variables.templateId],
      });
    },
  });
}

export function useSaveDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: saveDraft,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplate", variables.templateId],
      });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplateVersions", variables.templateId],
      });
    },
  });
}

export function usePublishDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: publishDraft,
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplate", variables.templateId],
      });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplateVersions", variables.templateId],
      });
    },
  });
}

export function useDiscardDraft() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: discardDraft,
    onSuccess: (_data, templateId) => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplate", templateId],
      });
      queryClient.invalidateQueries({
        queryKey: ["stackTemplateVersions", templateId],
      });
    },
  });
}

export function useArchiveTemplate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: archiveTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["stackTemplates"] });
    },
  });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors related to `use-stack-templates.ts`

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/use-stack-templates.ts
git commit -m "feat: add TanStack Query hooks for stack template CRUD"
```

---

### Task 2: Route Registration

**Files:**
- Modify: `client/src/lib/route-config.ts`
- Modify: `client/src/lib/routes.tsx`

- [ ] **Step 1: Add IconTemplate import and route config entries to route-config.ts**

In `client/src/lib/route-config.ts`, add `IconTemplate` to the imports from `@tabler/icons-react`:

```typescript
import {
  type Icon,
  IconActivity,
  IconBook,
  IconBrandDocker,
  IconBrandCloudflare,
  IconBrandAzure,
  IconBrandGithub,
  IconCertificate,
  IconDashboard,
  IconDatabase,
  IconKey,
  IconNetwork,
  IconRobot,
  IconRocket,
  IconServer,
  IconSettings,
  IconShield,
  IconHistory,
  IconDownload,
  IconTemplate,
  IconWorld,
} from "@tabler/icons-react";
```

Then add the route config entry inside the `routeConfig` object, alongside the other administration routes:

```typescript
  "/stack-templates": {
    path: "/stack-templates",
    title: "Stack Templates",
    icon: IconTemplate,
    showInNav: true,
    navGroup: "main",
    navSection: "administration",
    description: "Create and manage reusable stack blueprints",
    children: {
      detail: {
        path: "/stack-templates/:templateId",
        title: "Stack Template",
        breadcrumbLabel: "Details",
        parent: "/stack-templates",
        showInNav: false,
      },
    },
  },
```

- [ ] **Step 2: Add route entries and imports to routes.tsx**

In `client/src/lib/routes.tsx`, add imports at the top with the other page imports:

```typescript
import StackTemplatesPage from "@/app/stack-templates/page";
import StackTemplateDetailPage from "@/app/stack-templates/[templateId]/page";
```

Then add these route entries inside the `children` array of the authenticated layout (alongside the other admin routes):

```typescript
      {
        path: "stack-templates",
        element: <StackTemplatesPage />,
      },
      {
        path: "stack-templates/:templateId",
        element: <StackTemplateDetailPage />,
      },
```

- [ ] **Step 3: Create placeholder page files so TypeScript doesn't error**

Create `client/src/app/stack-templates/page.tsx`:

```typescript
export default function StackTemplatesPage() {
  return <div>Stack Templates — coming soon</div>;
}
```

Create `client/src/app/stack-templates/[templateId]/page.tsx`:

```typescript
export default function StackTemplateDetailPage() {
  return <div>Stack Template Detail — coming soon</div>;
}
```

- [ ] **Step 4: Verify TypeScript compiles and dev server loads**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add client/src/lib/route-config.ts client/src/lib/routes.tsx client/src/app/stack-templates/
git commit -m "feat: register stack template routes in admin nav"
```

---

### Task 3: Template Table Component

**Files:**
- Create: `client/src/components/stack-templates/template-table.tsx`

- [ ] **Step 1: Create the table component**

This component receives templates as a prop and renders a filterable table with status badges and actions dropdown.

```typescript
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { IconDotsVertical } from "@tabler/icons-react";
import type { StackTemplateInfo } from "@mini-infra/types";
import { useArchiveTemplate } from "@/hooks/use-stack-templates";
import { toast } from "sonner";

interface TemplateTableProps {
  templates: StackTemplateInfo[];
}

function getStatusBadge(template: StackTemplateInfo) {
  if (template.isArchived) {
    return <Badge variant="outline">Archived</Badge>;
  }
  if (template.currentVersionId && template.draftVersionId) {
    return (
      <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
        Has Draft
      </Badge>
    );
  }
  if (template.currentVersionId) {
    return (
      <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
        Published
      </Badge>
    );
  }
  return <Badge variant="secondary">Draft Only</Badge>;
}

export function TemplateTable({ templates }: TemplateTableProps) {
  const navigate = useNavigate();
  const archiveMutation = useArchiveTemplate();
  const [archiveTarget, setArchiveTarget] = useState<StackTemplateInfo | null>(
    null,
  );

  const handleArchive = async () => {
    if (!archiveTarget) return;
    try {
      await archiveMutation.mutateAsync(archiveTarget.id);
      toast.success(`Template "${archiveTarget.displayName}" archived`);
    } catch (error: any) {
      toast.error(`Failed to archive: ${error.message}`);
    }
    setArchiveTarget(null);
  };

  if (templates.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <p className="text-muted-foreground">No templates found</p>
      </div>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Template</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Scope</TableHead>
            <TableHead>Version</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-[50px]" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {templates.map((template) => (
            <TableRow
              key={template.id}
              className="cursor-pointer"
              onClick={() => navigate(`/stack-templates/${template.id}`)}
            >
              <TableCell>
                <div className="font-medium">{template.displayName}</div>
                {template.description && (
                  <div className="text-sm text-muted-foreground">
                    {template.description}
                  </div>
                )}
              </TableCell>
              <TableCell>
                <Badge variant="outline">{template.source}</Badge>
              </TableCell>
              <TableCell>
                <Badge variant="outline">{template.scope}</Badge>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {template.currentVersion
                  ? `v${template.currentVersion.version}`
                  : "—"}
              </TableCell>
              <TableCell>{getStatusBadge(template)}</TableCell>
              <TableCell>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <IconDotsVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        navigate(`/stack-templates/${template.id}`);
                      }}
                    >
                      Edit
                    </DropdownMenuItem>
                    {!template.isArchived && (
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          setArchiveTarget(template);
                        }}
                        className="text-destructive"
                      >
                        Archive
                      </DropdownMenuItem>
                    )}
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <AlertDialog
        open={!!archiveTarget}
        onOpenChange={(open) => !open && setArchiveTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive Template</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to archive "
              {archiveTarget?.displayName}"? Existing stacks using this
              template will not be affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleArchive}>
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add client/src/components/stack-templates/template-table.tsx
git commit -m "feat: add TemplateTable component for stack templates list"
```

---

### Task 4: List Page

**Files:**
- Modify: `client/src/app/stack-templates/page.tsx`

- [ ] **Step 1: Implement the full list page**

Replace the placeholder content in `client/src/app/stack-templates/page.tsx`:

```typescript
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

export default function StackTemplatesPage() {
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: templates, isLoading, error } = useStackTemplates({
    source: sourceFilter === "all" ? undefined : sourceFilter,
    scope: scopeFilter === "all" ? undefined : scopeFilter,
    includeArchived,
  });

  return (
    <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6">
      <div className="px-4 lg:px-6">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-3">
            <div className="p-3 rounded-md bg-primary/10 text-primary">
              <IconTemplate className="h-6 w-6" />
            </div>
            <div>
              <h1 className="text-3xl font-bold">Stack Templates</h1>
              <p className="text-muted-foreground">
                Create and manage reusable stack blueprints for deploying
                services
              </p>
            </div>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <IconPlus className="h-4 w-4 mr-2" />
            Create Template
          </Button>
        </div>

        {/* Filters */}
        <div className="flex items-center gap-3 mb-4">
          <Select value={sourceFilter} onValueChange={setSourceFilter}>
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Source" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Sources</SelectItem>
              <SelectItem value="system">System</SelectItem>
              <SelectItem value="user">User</SelectItem>
            </SelectContent>
          </Select>

          <Select value={scopeFilter} onValueChange={setScopeFilter}>
            <SelectTrigger className="w-[160px]">
              <SelectValue placeholder="Scope" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Scopes</SelectItem>
              <SelectItem value="host">Host</SelectItem>
              <SelectItem value="environment">Environment</SelectItem>
            </SelectContent>
          </Select>

          <div className="flex items-center gap-2">
            <Checkbox
              id="includeArchived"
              checked={includeArchived}
              onCheckedChange={(checked) =>
                setIncludeArchived(checked === true)
              }
            />
            <Label htmlFor="includeArchived" className="text-sm">
              Show Archived
            </Label>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-4 lg:px-6 max-w-6xl">
        {isLoading && (
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertDescription>
              Failed to load stack templates: {(error as Error).message}
            </AlertDescription>
          </Alert>
        )}

        {templates && <TemplateTable templates={templates} />}

        {templates && (
          <p className="text-sm text-muted-foreground mt-2">
            {templates.length} template{templates.length !== 1 ? "s" : ""}
          </p>
        )}
      </div>

      <CreateTemplateDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
```

- [ ] **Step 2: Create the CreateTemplateDialog component**

Create `client/src/components/stack-templates/create-template-dialog.tsx`:

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useNavigate } from "react-router-dom";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useCreateStackTemplate } from "@/hooks/use-stack-templates";
import { toast } from "sonner";
import { IconLoader2 } from "@tabler/icons-react";

const createTemplateSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .regex(
      /^[a-z0-9][a-z0-9-]*[a-z0-9]$/,
      "Must be lowercase alphanumeric with hyphens (e.g. my-template)",
    ),
  displayName: z.string().min(1, "Display name is required"),
  description: z.string().optional(),
  scope: z.enum(["host", "environment"]),
  category: z.string().optional(),
});

type CreateTemplateFormValues = z.infer<typeof createTemplateSchema>;

interface CreateTemplateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function CreateTemplateDialog({
  open,
  onOpenChange,
}: CreateTemplateDialogProps) {
  const navigate = useNavigate();
  const createMutation = useCreateStackTemplate();

  const form = useForm<CreateTemplateFormValues>({
    resolver: zodResolver(createTemplateSchema),
    defaultValues: {
      name: "",
      displayName: "",
      description: "",
      scope: "environment",
      category: "",
    },
  });

  const onSubmit = async (values: CreateTemplateFormValues) => {
    try {
      const result = await createMutation.mutateAsync({
        name: values.name,
        displayName: values.displayName,
        description: values.description || undefined,
        scope: values.scope,
        category: values.category || undefined,
        networks: [],
        volumes: [],
        services: [],
      });
      toast.success(`Template "${values.displayName}" created`);
      onOpenChange(false);
      form.reset();
      navigate(`/stack-templates/${result.id}`);
    } catch (error: any) {
      toast.error(`Failed to create template: ${error.message}`);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Create Stack Template</DialogTitle>
          <DialogDescription>
            Create a new reusable stack blueprint. You can add services and
            parameters after creation.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input placeholder="my-stack-template" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="displayName"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Display Name</FormLabel>
                  <FormControl>
                    <Input placeholder="My Stack Template" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What does this template deploy?"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex gap-4">
              <FormField
                control={form.control}
                name="scope"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Scope</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="environment">Environment</SelectItem>
                        <SelectItem value="host">Host</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem className="flex-1">
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <Input placeholder="e.g. Databases" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending && (
                  <IconLoader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Create Template
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add client/src/app/stack-templates/page.tsx client/src/components/stack-templates/create-template-dialog.tsx
git commit -m "feat: implement stack templates list page with filters and create dialog"
```

---

### Task 5: Version Sidebar Component

**Files:**
- Create: `client/src/components/stack-templates/version-sidebar.tsx`

- [ ] **Step 1: Create the version sidebar**

```typescript
import { format } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  StackTemplateInfo,
  StackTemplateVersionInfo,
} from "@mini-infra/types";

interface VersionSidebarProps {
  template: StackTemplateInfo;
  versions: StackTemplateVersionInfo[];
  selectedVersionId: string | null;
  onSelectVersion: (versionId: string | null) => void;
}

function getVersionBadge(version: StackTemplateVersionInfo, template: StackTemplateInfo) {
  if (version.status === "draft") {
    return (
      <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
        editing
      </Badge>
    );
  }
  if (version.id === template.currentVersionId) {
    return (
      <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
        current
      </Badge>
    );
  }
  return <Badge variant="outline">archived</Badge>;
}

export function VersionSidebar({
  template,
  versions,
  selectedVersionId,
  onSelectVersion,
}: VersionSidebarProps) {
  const draft = versions.find((v) => v.status === "draft");
  const published = versions
    .filter((v) => v.status === "published")
    .sort((a, b) => b.version - a.version);
  const archived = versions
    .filter((v) => v.status === "archived")
    .sort((a, b) => b.version - a.version);

  return (
    <div className="flex flex-col h-full">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide px-4 py-3 border-b">
        Version History
      </h3>
      <ScrollArea className="flex-1">
        <div className="p-3 space-y-2">
          {/* Draft */}
          {draft && (
            <button
              className={`w-full text-left rounded-lg p-3 border transition-colors ${
                selectedVersionId === draft.id || (!selectedVersionId && draft)
                  ? "border-orange-500 bg-orange-500/5"
                  : "border-border hover:bg-muted/50"
              }`}
              onClick={() => onSelectVersion(null)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-orange-500">
                  Draft
                </span>
                {getVersionBadge(draft, template)}
              </div>
              <div className="text-xs text-muted-foreground">
                Modified {format(new Date(draft.createdAt), "MMM d, yyyy")}
              </div>
            </button>
          )}

          {/* Published versions */}
          {published.map((version) => (
            <button
              key={version.id}
              className={`w-full text-left rounded-lg p-3 border transition-colors ${
                selectedVersionId === version.id
                  ? "border-green-500 bg-green-500/5"
                  : "border-border hover:bg-muted/50"
              }`}
              onClick={() => onSelectVersion(version.id)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold">
                  v{version.version}
                </span>
                {getVersionBadge(version, template)}
              </div>
              {version.notes && (
                <div className="text-xs text-muted-foreground mb-1">
                  {version.notes}
                </div>
              )}
              {version.publishedAt && (
                <div className="text-xs text-muted-foreground">
                  Published{" "}
                  {format(new Date(version.publishedAt), "MMM d, yyyy")}
                </div>
              )}
            </button>
          ))}

          {/* Archived versions */}
          {archived.length > 0 && (
            <details className="mt-2">
              <summary className="text-xs text-muted-foreground cursor-pointer py-1">
                {archived.length} archived version
                {archived.length !== 1 ? "s" : ""}
              </summary>
              <div className="space-y-2 mt-2">
                {archived.map((version) => (
                  <button
                    key={version.id}
                    className={`w-full text-left rounded-lg p-3 border transition-colors ${
                      selectedVersionId === version.id
                        ? "border-primary bg-primary/5"
                        : "border-border hover:bg-muted/50"
                    }`}
                    onClick={() => onSelectVersion(version.id)}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-semibold text-muted-foreground">
                        v{version.version}
                      </span>
                      {getVersionBadge(version, template)}
                    </div>
                    {version.notes && (
                      <div className="text-xs text-muted-foreground">
                        {version.notes}
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add client/src/components/stack-templates/version-sidebar.tsx
git commit -m "feat: add VersionSidebar component for template version history"
```

---

### Task 6: Template Metadata Card

**Files:**
- Create: `client/src/components/stack-templates/template-metadata-card.tsx`

- [ ] **Step 1: Create the metadata card component**

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { useUpdateStackTemplate } from "@/hooks/use-stack-templates";
import { toast } from "sonner";
import { IconDeviceFloppy, IconLoader2 } from "@tabler/icons-react";
import type { StackTemplateInfo } from "@mini-infra/types";

const metadataSchema = z.object({
  displayName: z.string().min(1, "Display name is required"),
  description: z.string().optional(),
  category: z.string().optional(),
});

type MetadataFormValues = z.infer<typeof metadataSchema>;

interface TemplateMetadataCardProps {
  template: StackTemplateInfo;
  readOnly?: boolean;
}

export function TemplateMetadataCard({
  template,
  readOnly,
}: TemplateMetadataCardProps) {
  const updateMutation = useUpdateStackTemplate();

  const form = useForm<MetadataFormValues>({
    resolver: zodResolver(metadataSchema),
    defaultValues: {
      displayName: template.displayName,
      description: template.description ?? "",
      category: template.category ?? "",
    },
  });

  useEffect(() => {
    form.reset({
      displayName: template.displayName,
      description: template.description ?? "",
      category: template.category ?? "",
    });
  }, [template, form]);

  const onSubmit = async (values: MetadataFormValues) => {
    try {
      await updateMutation.mutateAsync({
        templateId: template.id,
        request: {
          displayName: values.displayName,
          description: values.description || undefined,
          category: values.category || undefined,
        },
      });
      toast.success("Template metadata updated");
    } catch (error: any) {
      toast.error(`Failed to update: ${error.message}`);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between py-3">
        <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Template Info
        </CardTitle>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{template.source}</Badge>
          <Badge variant="outline">{template.scope}</Badge>
        </div>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="displayName"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Display Name</FormLabel>
                    <FormControl>
                      <Input {...field} disabled={readOnly} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="category"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="text-xs">Category</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="e.g. Databases"
                        {...field}
                        disabled={readOnly}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel className="text-xs">Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What does this template deploy?"
                      rows={2}
                      {...field}
                      disabled={readOnly}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            {!readOnly && form.formState.isDirty && (
              <div className="flex justify-end">
                <Button
                  type="submit"
                  size="sm"
                  disabled={updateMutation.isPending}
                >
                  {updateMutation.isPending ? (
                    <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
                  ) : (
                    <IconDeviceFloppy className="h-4 w-4 mr-1" />
                  )}
                  Save
                </Button>
              </div>
            )}
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add client/src/components/stack-templates/template-metadata-card.tsx
git commit -m "feat: add TemplateMetadataCard component"
```

---

### Task 7: Template Services Section

**Files:**
- Create: `client/src/components/stack-templates/template-services-section.tsx`

- [ ] **Step 1: Create the services section component**

This renders the list of service cards from a template version. Editing is handled by a dialog (Task 8).

```typescript
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { IconPlus, IconEdit, IconTrash, IconGripVertical } from "@tabler/icons-react";
import type { StackTemplateServiceInfo } from "@mini-infra/types";
import { ServiceEditDialog } from "./service-edit-dialog";
import type { StackServiceDefinition } from "@mini-infra/types";

interface TemplateServicesSectionProps {
  services: StackTemplateServiceInfo[];
  allServiceNames: string[];
  readOnly?: boolean;
  onServicesChange: (services: StackServiceDefinition[]) => void;
}

function serviceTypeBorderColor(type: string) {
  return type === "Stateful" ? "border-l-blue-500" : "border-l-green-500";
}

function serviceTypeBadge(type: string) {
  if (type === "Stateful") {
    return (
      <Badge className="bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300">
        Stateful
      </Badge>
    );
  }
  return (
    <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
      StatelessWeb
    </Badge>
  );
}

function toServiceDefinition(s: StackTemplateServiceInfo): StackServiceDefinition {
  return {
    serviceName: s.serviceName,
    serviceType: s.serviceType,
    dockerImage: s.dockerImage,
    dockerTag: s.dockerTag,
    containerConfig: s.containerConfig,
    initCommands: s.initCommands ?? undefined,
    dependsOn: s.dependsOn,
    order: s.order,
    routing: s.routing ?? undefined,
  };
}

export function TemplateServicesSection({
  services,
  allServiceNames,
  readOnly,
  onServicesChange,
}: TemplateServicesSectionProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const sorted = [...services].sort((a, b) => a.order - b.order);

  const handleSave = (definition: StackServiceDefinition, index: number | null) => {
    const defs = sorted.map(toServiceDefinition);
    if (index !== null) {
      defs[index] = definition;
    } else {
      defs.push({ ...definition, order: defs.length + 1 });
    }
    onServicesChange(defs);
    setEditingIndex(null);
    setIsAdding(false);
  };

  const handleDelete = (index: number) => {
    const defs = sorted.map(toServiceDefinition);
    defs.splice(index, 1);
    defs.forEach((d, i) => (d.order = i + 1));
    onServicesChange(defs);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Services ({services.length})
        </h3>
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAdding(true)}
          >
            <IconPlus className="h-4 w-4 mr-1" />
            Add Service
          </Button>
        )}
      </div>

      {sorted.length === 0 && (
        <div className="text-center py-8 text-muted-foreground text-sm border border-dashed rounded-lg">
          No services defined. Add a service to get started.
        </div>
      )}

      <div className="space-y-2">
        {sorted.map((service, index) => (
          <div
            key={service.id || service.serviceName}
            className={`rounded-lg border border-l-4 p-4 ${serviceTypeBorderColor(service.serviceType)}`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="flex items-center gap-2">
                {!readOnly && (
                  <IconGripVertical className="h-4 w-4 text-muted-foreground" />
                )}
                <span className="font-semibold">{service.serviceName}</span>
                {serviceTypeBadge(service.serviceType)}
                <span className="text-xs text-muted-foreground">
                  order: {service.order}
                </span>
                {service.dependsOn.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    depends: {service.dependsOn.join(", ")}
                  </span>
                )}
              </div>
              {!readOnly && (
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    onClick={() => setEditingIndex(index)}
                  >
                    <IconEdit className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive"
                    onClick={() => handleDelete(index)}
                  >
                    <IconTrash className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <div>
                <span className="text-muted-foreground">Image: </span>
                <span>
                  {service.dockerImage}:{service.dockerTag}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Ports: </span>
                <span>
                  {service.containerConfig.ports?.length
                    ? service.containerConfig.ports
                        .map((p) => `${p.hostPort}:${p.containerPort}`)
                        .join(", ")
                    : "none"}
                </span>
              </div>
              <div>
                <span className="text-muted-foreground">Env vars: </span>
                <span>
                  {Object.keys(service.containerConfig.env ?? {}).length}{" "}
                  configured
                </span>
              </div>
              {service.routing && (
                <div>
                  <span className="text-muted-foreground">Routing: </span>
                  <span>
                    {service.routing.hostname} → :{service.routing.listeningPort}
                  </span>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Edit dialog */}
      {editingIndex !== null && (
        <ServiceEditDialog
          open
          onOpenChange={(open) => !open && setEditingIndex(null)}
          service={toServiceDefinition(sorted[editingIndex])}
          otherServiceNames={allServiceNames.filter(
            (n) => n !== sorted[editingIndex].serviceName,
          )}
          onSave={(def) => handleSave(def, editingIndex)}
        />
      )}

      {/* Add dialog */}
      {isAdding && (
        <ServiceEditDialog
          open
          onOpenChange={(open) => !open && setIsAdding(false)}
          service={null}
          otherServiceNames={allServiceNames}
          onSave={(def) => handleSave(def, null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: May have errors due to ServiceEditDialog not existing yet — that's expected, will be fixed in Task 8.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/stack-templates/template-services-section.tsx
git commit -m "feat: add TemplateServicesSection component with service cards"
```

---

### Task 8: Service Edit Dialog

**Files:**
- Create: `client/src/components/stack-templates/service-edit-dialog.tsx`

- [ ] **Step 1: Create the service edit dialog**

This is the most complex component — a dialog with sections for all service properties.

```typescript
import { useForm, useFieldArray } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { IconLoader2, IconPlus, IconTrash } from "@tabler/icons-react";
import type { StackServiceDefinition } from "@mini-infra/types";

const portSchema = z.object({
  containerPort: z.coerce.number().int().min(1).max(65535),
  hostPort: z.coerce.number().int().min(0).max(65535),
  protocol: z.enum(["tcp", "udp"]),
});

const envVarSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});

const serviceSchema = z.object({
  serviceName: z
    .string()
    .min(1, "Service name is required")
    .regex(/^[a-z0-9][a-z0-9-]*$/, "Lowercase alphanumeric with hyphens"),
  serviceType: z.enum(["Stateful", "StatelessWeb"]),
  dockerImage: z.string().min(1, "Docker image is required"),
  dockerTag: z.string().min(1, "Docker tag is required"),
  order: z.coerce.number().int().min(1),
  command: z.string().optional(),
  restartPolicy: z.enum(["no", "always", "unless-stopped", "on-failure"]),
  ports: z.array(portSchema),
  envVars: z.array(envVarSchema),
  dependsOn: z.string(),
  routingHostname: z.string().optional(),
  routingPort: z.coerce.number().int().min(1).max(65535).optional(),
});

type ServiceFormValues = z.infer<typeof serviceSchema>;

interface ServiceEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  service: StackServiceDefinition | null;
  otherServiceNames: string[];
  onSave: (service: StackServiceDefinition) => void;
}

function envToArray(env?: Record<string, string>): { key: string; value: string }[] {
  if (!env) return [];
  return Object.entries(env).map(([key, value]) => ({ key, value }));
}

function arrayToEnv(arr: { key: string; value: string }[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const { key, value } of arr) {
    if (key) env[key] = value;
  }
  return env;
}

export function ServiceEditDialog({
  open,
  onOpenChange,
  service,
  otherServiceNames,
  onSave,
}: ServiceEditDialogProps) {
  const isNew = !service;

  const form = useForm<ServiceFormValues>({
    resolver: zodResolver(serviceSchema),
    defaultValues: {
      serviceName: service?.serviceName ?? "",
      serviceType: service?.serviceType ?? "Stateful",
      dockerImage: service?.dockerImage ?? "",
      dockerTag: service?.dockerTag ?? "latest",
      order: service?.order ?? 1,
      command: service?.containerConfig.command?.join(" ") ?? "",
      restartPolicy: service?.containerConfig.restartPolicy ?? "unless-stopped",
      ports: service?.containerConfig.ports?.map((p) => ({
        containerPort: p.containerPort,
        hostPort: p.hostPort,
        protocol: p.protocol,
      })) ?? [],
      envVars: envToArray(service?.containerConfig.env),
      dependsOn: service?.dependsOn.join(", ") ?? "",
      routingHostname: service?.routing?.hostname ?? "",
      routingPort: service?.routing?.listeningPort ?? undefined,
    },
  });

  const {
    fields: portFields,
    append: appendPort,
    remove: removePort,
  } = useFieldArray({ control: form.control, name: "ports" });

  const {
    fields: envFields,
    append: appendEnv,
    remove: removeEnv,
  } = useFieldArray({ control: form.control, name: "envVars" });

  useEffect(() => {
    if (open) {
      form.reset({
        serviceName: service?.serviceName ?? "",
        serviceType: service?.serviceType ?? "Stateful",
        dockerImage: service?.dockerImage ?? "",
        dockerTag: service?.dockerTag ?? "latest",
        order: service?.order ?? 1,
        command: service?.containerConfig.command?.join(" ") ?? "",
        restartPolicy: service?.containerConfig.restartPolicy ?? "unless-stopped",
        ports: service?.containerConfig.ports?.map((p) => ({
          containerPort: p.containerPort,
          hostPort: p.hostPort,
          protocol: p.protocol,
        })) ?? [],
        envVars: envToArray(service?.containerConfig.env),
        dependsOn: service?.dependsOn.join(", ") ?? "",
        routingHostname: service?.routing?.hostname ?? "",
        routingPort: service?.routing?.listeningPort ?? undefined,
      });
    }
  }, [open, service, form]);

  const onSubmit = (values: ServiceFormValues) => {
    const deps = values.dependsOn
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    const definition: StackServiceDefinition = {
      serviceName: values.serviceName,
      serviceType: values.serviceType,
      dockerImage: values.dockerImage,
      dockerTag: values.dockerTag,
      order: values.order,
      dependsOn: deps,
      containerConfig: {
        ports: values.ports.map((p) => ({
          containerPort: p.containerPort,
          hostPort: p.hostPort,
          protocol: p.protocol,
        })),
        env: arrayToEnv(values.envVars),
        restartPolicy: values.restartPolicy,
        command: values.command ? values.command.split(" ") : undefined,
      },
      routing:
        values.serviceType === "StatelessWeb" && values.routingHostname
          ? {
              hostname: values.routingHostname,
              listeningPort: values.routingPort ?? 80,
            }
          : undefined,
    };

    onSave(definition);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[700px] max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Add Service" : `Edit ${service.serviceName}`}
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <Tabs defaultValue="basic">
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="basic">Basic</TabsTrigger>
                <TabsTrigger value="container">Container</TabsTrigger>
                <TabsTrigger value="env">Environment</TabsTrigger>
                <TabsTrigger value="routing">Routing</TabsTrigger>
              </TabsList>

              {/* Basic Tab */}
              <TabsContent value="basic" className="space-y-3 mt-3">
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="serviceName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Service Name</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="my-service"
                            {...field}
                            disabled={!isNew}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="serviceType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Type</FormLabel>
                        <Select
                          onValueChange={field.onChange}
                          value={field.value}
                        >
                          <FormControl>
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="Stateful">Stateful</SelectItem>
                            <SelectItem value="StatelessWeb">
                              StatelessWeb
                            </SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="dockerImage"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Docker Image</FormLabel>
                        <FormControl>
                          <Input placeholder="postgres" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="dockerTag"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Tag</FormLabel>
                        <FormControl>
                          <Input placeholder="latest" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <FormField
                    control={form.control}
                    name="order"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Order</FormLabel>
                        <FormControl>
                          <Input type="number" min={1} {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="dependsOn"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Depends On</FormLabel>
                        <FormControl>
                          <Input
                            placeholder="service1, service2"
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
              </TabsContent>

              {/* Container Tab */}
              <TabsContent value="container" className="space-y-3 mt-3">
                <FormField
                  control={form.control}
                  name="command"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Command Override</FormLabel>
                      <FormControl>
                        <Input
                          placeholder="e.g. postgres -c shared_buffers=256MB"
                          {...field}
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={form.control}
                  name="restartPolicy"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Restart Policy</FormLabel>
                      <Select
                        onValueChange={field.onChange}
                        value={field.value}
                      >
                        <FormControl>
                          <SelectTrigger>
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="no">No</SelectItem>
                          <SelectItem value="always">Always</SelectItem>
                          <SelectItem value="unless-stopped">
                            Unless Stopped
                          </SelectItem>
                          <SelectItem value="on-failure">On Failure</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                {/* Ports */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <FormLabel>Port Mappings</FormLabel>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        appendPort({
                          containerPort: 80,
                          hostPort: 0,
                          protocol: "tcp",
                        })
                      }
                    >
                      <IconPlus className="h-3 w-3 mr-1" />
                      Add Port
                    </Button>
                  </div>
                  {portFields.map((field, index) => (
                    <div key={field.id} className="flex items-center gap-2 mb-2">
                      <FormField
                        control={form.control}
                        name={`ports.${index}.hostPort`}
                        render={({ field }) => (
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="Host"
                              className="w-24"
                              {...field}
                            />
                          </FormControl>
                        )}
                      />
                      <span className="text-muted-foreground">:</span>
                      <FormField
                        control={form.control}
                        name={`ports.${index}.containerPort`}
                        render={({ field }) => (
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="Container"
                              className="w-24"
                              {...field}
                            />
                          </FormControl>
                        )}
                      />
                      <FormField
                        control={form.control}
                        name={`ports.${index}.protocol`}
                        render={({ field }) => (
                          <Select
                            onValueChange={field.onChange}
                            value={field.value}
                          >
                            <SelectTrigger className="w-20">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="tcp">TCP</SelectItem>
                              <SelectItem value="udp">UDP</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => removePort(index)}
                      >
                        <IconTrash className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  ))}
                </div>
              </TabsContent>

              {/* Environment Tab */}
              <TabsContent value="env" className="space-y-3 mt-3">
                <div className="flex items-center justify-between mb-2">
                  <FormLabel>Environment Variables</FormLabel>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => appendEnv({ key: "", value: "" })}
                  >
                    <IconPlus className="h-3 w-3 mr-1" />
                    Add Variable
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  Use {"{{param_name}}"} syntax to reference template parameters.
                </p>
                {envFields.map((field, index) => (
                  <div key={field.id} className="flex items-center gap-2">
                    <FormField
                      control={form.control}
                      name={`envVars.${index}.key`}
                      render={({ field }) => (
                        <FormControl>
                          <Input placeholder="KEY" className="flex-1" {...field} />
                        </FormControl>
                      )}
                    />
                    <span className="text-muted-foreground">=</span>
                    <FormField
                      control={form.control}
                      name={`envVars.${index}.value`}
                      render={({ field }) => (
                        <FormControl>
                          <Input
                            placeholder="value or {{param}}"
                            className="flex-1"
                            {...field}
                          />
                        </FormControl>
                      )}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => removeEnv(index)}
                    >
                      <IconTrash className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ))}
                {envFields.length === 0 && (
                  <p className="text-sm text-muted-foreground text-center py-4">
                    No environment variables configured.
                  </p>
                )}
              </TabsContent>

              {/* Routing Tab */}
              <TabsContent value="routing" className="space-y-3 mt-3">
                {form.watch("serviceType") !== "StatelessWeb" ? (
                  <p className="text-sm text-muted-foreground py-4 text-center">
                    Routing is only available for StatelessWeb services.
                  </p>
                ) : (
                  <>
                    <FormField
                      control={form.control}
                      name="routingHostname"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Hostname</FormLabel>
                          <FormControl>
                            <Input
                              placeholder="app.example.com"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name="routingPort"
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel>Listening Port</FormLabel>
                          <FormControl>
                            <Input
                              type="number"
                              placeholder="80"
                              {...field}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                  </>
                )}
              </TabsContent>
            </Tabs>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isNew ? "Add Service" : "Save Changes"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add client/src/components/stack-templates/service-edit-dialog.tsx
git commit -m "feat: add ServiceEditDialog with tabbed form for service properties"
```

---

### Task 9: Parameters Section

**Files:**
- Create: `client/src/components/stack-templates/template-parameters-section.tsx`
- Create: `client/src/components/stack-templates/parameter-edit-dialog.tsx`

- [ ] **Step 1: Create the parameter edit dialog**

```typescript
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { StackParameterDefinition, StackParameterValue } from "@mini-infra/types";

const parameterSchema = z.object({
  name: z
    .string()
    .min(1, "Name is required")
    .regex(/^[a-z_][a-z0-9_]*$/, "Lowercase with underscores"),
  type: z.enum(["string", "number", "boolean"]),
  description: z.string().optional(),
  defaultValue: z.string().optional(),
  required: z.boolean(),
});

type ParameterFormValues = z.infer<typeof parameterSchema>;

interface ParameterEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  parameter: StackParameterDefinition | null;
  defaultValue?: StackParameterValue;
  onSave: (param: StackParameterDefinition, defaultValue?: StackParameterValue) => void;
}

export function ParameterEditDialog({
  open,
  onOpenChange,
  parameter,
  defaultValue,
  onSave,
}: ParameterEditDialogProps) {
  const isNew = !parameter;

  const form = useForm<ParameterFormValues>({
    resolver: zodResolver(parameterSchema),
    defaultValues: {
      name: parameter?.name ?? "",
      type: parameter?.type ?? "string",
      description: parameter?.description ?? "",
      defaultValue: defaultValue != null ? String(defaultValue) : "",
      required: parameter ? !parameter.default && parameter.default !== false && parameter.default !== 0 : true,
    },
  });

  useEffect(() => {
    if (open) {
      form.reset({
        name: parameter?.name ?? "",
        type: parameter?.type ?? "string",
        description: parameter?.description ?? "",
        defaultValue: defaultValue != null ? String(defaultValue) : "",
        required: parameter ? !parameter.default && parameter.default !== false && parameter.default !== 0 : true,
      });
    }
  }, [open, parameter, defaultValue, form]);

  const onSubmit = (values: ParameterFormValues) => {
    let parsedDefault: StackParameterValue | undefined;
    if (values.defaultValue) {
      if (values.type === "number") {
        parsedDefault = Number(values.defaultValue);
      } else if (values.type === "boolean") {
        parsedDefault = values.defaultValue === "true";
      } else {
        parsedDefault = values.defaultValue;
      }
    }

    const def: StackParameterDefinition = {
      name: values.name,
      type: values.type,
      description: values.description || undefined,
      default: parsedDefault ?? (values.type === "boolean" ? false : values.type === "number" ? 0 : ""),
    };

    onSave(def, parsedDefault);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[450px]">
        <DialogHeader>
          <DialogTitle>
            {isNew ? "Add Parameter" : `Edit ${parameter.name}`}
          </DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="pg_version"
                      {...field}
                      disabled={!isNew}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="type"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="string">String</SelectItem>
                        <SelectItem value="number">Number</SelectItem>
                        <SelectItem value="boolean">Boolean</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="defaultValue"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Default Value</FormLabel>
                    <FormControl>
                      <Input placeholder="optional" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Description</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="What is this parameter for?"
                      rows={2}
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit">
                {isNew ? "Add Parameter" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Create the parameters section component**

```typescript
import { useState } from "react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { IconPlus, IconEdit, IconTrash } from "@tabler/icons-react";
import type { StackParameterDefinition, StackParameterValue } from "@mini-infra/types";
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
  readOnly,
  onParametersChange,
}: TemplateParametersSectionProps) {
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [isAdding, setIsAdding] = useState(false);

  const handleSave = (
    param: StackParameterDefinition,
    defaultValue: StackParameterValue | undefined,
    index: number | null,
  ) => {
    const newParams = [...parameters];
    const newDefaults = { ...defaultParameterValues };
    if (index !== null) {
      newParams[index] = param;
    } else {
      newParams.push(param);
    }
    if (defaultValue != null) {
      newDefaults[param.name] = defaultValue;
    } else {
      delete newDefaults[param.name];
    }
    onParametersChange(newParams, newDefaults);
    setEditingIndex(null);
    setIsAdding(false);
  };

  const handleDelete = (index: number) => {
    const newParams = [...parameters];
    const removed = newParams.splice(index, 1)[0];
    const newDefaults = { ...defaultParameterValues };
    delete newDefaults[removed.name];
    onParametersChange(newParams, newDefaults);
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
          Parameters ({parameters.length})
        </h3>
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIsAdding(true)}
          >
            <IconPlus className="h-4 w-4 mr-1" />
            Add Parameter
          </Button>
        )}
      </div>

      {parameters.length === 0 ? (
        <div className="text-center py-6 text-muted-foreground text-sm border border-dashed rounded-lg">
          No parameters defined.
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Default</TableHead>
              {!readOnly && <TableHead className="w-[80px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {parameters.map((param, index) => (
              <TableRow key={param.name}>
                <TableCell className="font-mono text-sm">
                  {param.name}
                  {param.description && (
                    <div className="text-xs text-muted-foreground font-sans">
                      {param.description}
                    </div>
                  )}
                </TableCell>
                <TableCell>{param.type}</TableCell>
                <TableCell className="font-mono text-sm text-muted-foreground">
                  {defaultParameterValues[param.name] != null
                    ? String(defaultParameterValues[param.name])
                    : "—"}
                </TableCell>
                {!readOnly && (
                  <TableCell>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={() => setEditingIndex(index)}
                      >
                        <IconEdit className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive"
                        onClick={() => handleDelete(index)}
                      >
                        <IconTrash className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {editingIndex !== null && (
        <ParameterEditDialog
          open
          onOpenChange={(open) => !open && setEditingIndex(null)}
          parameter={parameters[editingIndex]}
          defaultValue={defaultParameterValues[parameters[editingIndex].name]}
          onSave={(p, d) => handleSave(p, d, editingIndex)}
        />
      )}
      {isAdding && (
        <ParameterEditDialog
          open
          onOpenChange={(open) => !open && setIsAdding(false)}
          parameter={null}
          onSave={(p, d) => handleSave(p, d, null)}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add client/src/components/stack-templates/parameter-edit-dialog.tsx client/src/components/stack-templates/template-parameters-section.tsx
git commit -m "feat: add parameter edit dialog and parameters section"
```

---

### Task 10: Networks & Volumes Component

**Files:**
- Create: `client/src/components/stack-templates/template-networks-volumes.tsx`

- [ ] **Step 1: Create the networks and volumes component**

```typescript
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

interface TemplateNetworksVolumesProps {
  networks: StackNetwork[];
  volumes: StackVolume[];
  readOnly?: boolean;
  onNetworksChange: (networks: StackNetwork[]) => void;
  onVolumesChange: (volumes: StackVolume[]) => void;
}

function AddItemDialog({
  open,
  onOpenChange,
  title,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  onAdd: (name: string, driver: string) => void;
}) {
  const [name, setName] = useState("");
  const [driver, setDriver] = useState("");

  const handleAdd = () => {
    if (!name.trim()) return;
    onAdd(name.trim(), driver.trim() || undefined!);
    setName("");
    setDriver("");
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[400px]">
        <DialogHeader>
          <DialogTitle>Add {title}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="text-sm font-medium">Name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={`my-${title.toLowerCase()}`}
            />
          </div>
          <div>
            <label className="text-sm font-medium">Driver</label>
            <Input
              value={driver}
              onChange={(e) => setDriver(e.target.value)}
              placeholder={title === "Network" ? "bridge" : "local"}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
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

export function TemplateNetworksVolumes({
  networks,
  volumes,
  readOnly,
  onNetworksChange,
  onVolumesChange,
}: TemplateNetworksVolumesProps) {
  const [addingNetwork, setAddingNetwork] = useState(false);
  const [addingVolume, setAddingVolume] = useState(false);

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* Networks */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Networks ({networks.length})
          </h3>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={() => setAddingNetwork(true)}
            >
              <IconPlus className="h-3 w-3" />
            </Button>
          )}
        </div>
        {networks.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-xs border border-dashed rounded-lg">
            No networks
          </div>
        ) : (
          <div className="space-y-1">
            {networks.map((net, i) => (
              <div
                key={net.name}
                className="flex items-center justify-between rounded-md border p-2 text-sm"
              >
                <div>
                  <span className="font-medium">{net.name}</span>
                  {net.driver && (
                    <span className="text-muted-foreground ml-2 text-xs">
                      {net.driver}
                    </span>
                  )}
                </div>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => {
                      const updated = networks.filter((_, idx) => idx !== i);
                      onNetworksChange(updated);
                    }}
                  >
                    <IconTrash className="h-3 w-3 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        <AddItemDialog
          open={addingNetwork}
          onOpenChange={setAddingNetwork}
          title="Network"
          onAdd={(name, driver) =>
            onNetworksChange([...networks, { name, driver: driver || undefined }])
          }
        />
      </div>

      {/* Volumes */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Volumes ({volumes.length})
          </h3>
          {!readOnly && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2"
              onClick={() => setAddingVolume(true)}
            >
              <IconPlus className="h-3 w-3" />
            </Button>
          )}
        </div>
        {volumes.length === 0 ? (
          <div className="text-center py-4 text-muted-foreground text-xs border border-dashed rounded-lg">
            No volumes
          </div>
        ) : (
          <div className="space-y-1">
            {volumes.map((vol, i) => (
              <div
                key={vol.name}
                className="flex items-center justify-between rounded-md border p-2 text-sm"
              >
                <div>
                  <span className="font-medium">{vol.name}</span>
                  {vol.driver && (
                    <span className="text-muted-foreground ml-2 text-xs">
                      {vol.driver}
                    </span>
                  )}
                </div>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={() => {
                      const updated = volumes.filter((_, idx) => idx !== i);
                      onVolumesChange(updated);
                    }}
                  >
                    <IconTrash className="h-3 w-3 text-destructive" />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
        <AddItemDialog
          open={addingVolume}
          onOpenChange={setAddingVolume}
          title="Volume"
          onAdd={(name, driver) =>
            onVolumesChange([...volumes, { name, driver: driver || undefined }])
          }
        />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add client/src/components/stack-templates/template-networks-volumes.tsx
git commit -m "feat: add TemplateNetworksVolumes component"
```

---

### Task 11: Detail Page — Assembly

**Files:**
- Modify: `client/src/app/stack-templates/[templateId]/page.tsx`

- [ ] **Step 1: Implement the full detail page**

Replace the placeholder in `client/src/app/stack-templates/[templateId]/page.tsx`:

```typescript
import { useState, useCallback } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  IconArrowLeft,
  IconLoader2,
} from "@tabler/icons-react";
import {
  useStackTemplate,
  useStackTemplateVersions,
  useSaveDraft,
  usePublishDraft,
  useDiscardDraft,
} from "@/hooks/use-stack-templates";
import { TemplateMetadataCard } from "@/components/stack-templates/template-metadata-card";
import { TemplateServicesSection } from "@/components/stack-templates/template-services-section";
import { TemplateParametersSection } from "@/components/stack-templates/template-parameters-section";
import { TemplateNetworksVolumes } from "@/components/stack-templates/template-networks-volumes";
import { VersionSidebar } from "@/components/stack-templates/version-sidebar";
import { toast } from "sonner";
import type {
  StackTemplateVersionInfo,
  StackServiceDefinition,
  StackParameterDefinition,
  StackParameterValue,
  StackNetwork,
  StackVolume,
  DraftVersionInput,
} from "@mini-infra/types";

export default function StackTemplateDetailPage() {
  const navigate = useNavigate();
  const { templateId } = useParams<{ templateId: string }>();
  const { data: template, isLoading, error } = useStackTemplate(templateId ?? "");
  const { data: versions } = useStackTemplateVersions(templateId ?? "");
  const saveDraftMutation = useSaveDraft();
  const publishDraftMutation = usePublishDraft();
  const discardDraftMutation = useDiscardDraft();

  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [publishNotes, setPublishNotes] = useState("");

  // Determine which version to display
  const allVersions = versions ?? [];
  const draftVersion = allVersions.find((v) => v.status === "draft");
  const displayVersion: StackTemplateVersionInfo | undefined = selectedVersionId
    ? allVersions.find((v) => v.id === selectedVersionId)
    : draftVersion ?? (template?.currentVersion as StackTemplateVersionInfo | undefined);

  const isViewingDraft = !selectedVersionId && !!draftVersion;
  const readOnly = !isViewingDraft;

  // Build draft input from current display version
  const buildDraftInput = useCallback(
    (overrides: Partial<DraftVersionInput> = {}): DraftVersionInput => {
      const v = displayVersion;
      return {
        parameters: v?.parameters ?? [],
        defaultParameterValues: v?.defaultParameterValues ?? {},
        networks: v?.networks ?? [],
        volumes: v?.volumes ?? [],
        services:
          v?.services?.map((s) => ({
            serviceName: s.serviceName,
            serviceType: s.serviceType,
            dockerImage: s.dockerImage,
            dockerTag: s.dockerTag,
            containerConfig: s.containerConfig,
            initCommands: s.initCommands ?? undefined,
            dependsOn: s.dependsOn,
            order: s.order,
            routing: s.routing ?? undefined,
          })) ?? [],
        ...overrides,
      };
    },
    [displayVersion],
  );

  const handleSaveDraft = async (input: DraftVersionInput) => {
    if (!templateId) return;
    try {
      await saveDraftMutation.mutateAsync({
        templateId,
        request: input,
      });
      toast.success("Draft saved");
    } catch (error: any) {
      toast.error(`Failed to save draft: ${error.message}`);
    }
  };

  const handleServicesChange = (services: StackServiceDefinition[]) => {
    handleSaveDraft(buildDraftInput({ services }));
  };

  const handleParametersChange = (
    parameters: StackParameterDefinition[],
    defaultParameterValues: Record<string, StackParameterValue>,
  ) => {
    handleSaveDraft(buildDraftInput({ parameters, defaultParameterValues }));
  };

  const handleNetworksChange = (networks: StackNetwork[]) => {
    handleSaveDraft(buildDraftInput({ networks }));
  };

  const handleVolumesChange = (volumes: StackVolume[]) => {
    handleSaveDraft(buildDraftInput({ volumes }));
  };

  const handlePublish = async () => {
    if (!templateId) return;
    try {
      await publishDraftMutation.mutateAsync({
        templateId,
        request: { notes: publishNotes || undefined },
      });
      toast.success("Draft published successfully");
      setConfirmPublish(false);
      setPublishNotes("");
      setSelectedVersionId(null);
    } catch (error: any) {
      toast.error(`Failed to publish: ${error.message}`);
    }
  };

  const handleDiscard = async () => {
    if (!templateId) return;
    try {
      await discardDraftMutation.mutateAsync(templateId);
      toast.success("Draft discarded");
      setConfirmDiscard(false);
      setSelectedVersionId(null);
    } catch (error: any) {
      toast.error(`Failed to discard draft: ${error.message}`);
    }
  };

  const handleCreateDraft = async () => {
    if (!templateId || !displayVersion) return;
    try {
      await saveDraftMutation.mutateAsync({
        templateId,
        request: buildDraftInput(),
      });
      toast.success("Draft created from current version");
      setSelectedVersionId(null);
    } catch (error: any) {
      toast.error(`Failed to create draft: ${error.message}`);
    }
  };

  if (isLoading) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 px-4 lg:px-6">
        <Skeleton className="h-10 w-64" />
        <Skeleton className="h-[400px] w-full" />
      </div>
    );
  }

  if (error || !template) {
    return (
      <div className="flex flex-col gap-4 py-4 md:gap-6 md:py-6 px-4 lg:px-6">
        <Alert variant="destructive">
          <AlertDescription>
            {error ? (error as Error).message : "Template not found"}
          </AlertDescription>
        </Alert>
        <Button variant="outline" asChild>
          <Link to="/stack-templates">
            <IconArrowLeft className="h-4 w-4 mr-2" />
            Back to Templates
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Top Bar */}
      <div className="flex items-center justify-between px-4 lg:px-6 py-3 border-b">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/stack-templates">
              <IconArrowLeft className="h-4 w-4 mr-1" />
              Stack Templates
            </Link>
          </Button>
          <span className="text-muted-foreground">/</span>
          <span className="font-semibold">{template.displayName}</span>
          {template.currentVersion && (
            <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">
              Published v{template.currentVersion.version}
            </Badge>
          )}
          {draftVersion && (
            <Badge className="bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300">
              Draft
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!draftVersion && displayVersion && (
            <Button
              variant="outline"
              size="sm"
              onClick={handleCreateDraft}
              disabled={saveDraftMutation.isPending}
            >
              {saveDraftMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              )}
              Create Draft
            </Button>
          )}
          {draftVersion && (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setConfirmDiscard(true)}
              >
                Discard Draft
              </Button>
              <Button
                size="sm"
                onClick={() => setConfirmPublish(true)}
              >
                Publish Draft
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Main Layout */}
      <div className="flex flex-1 overflow-hidden">
        {/* Editor */}
        <div className="flex-1 overflow-y-auto p-4 lg:p-6 space-y-6">
          <TemplateMetadataCard template={template} readOnly={readOnly} />

          {displayVersion ? (
            <>
              <TemplateServicesSection
                services={displayVersion.services ?? []}
                allServiceNames={
                  displayVersion.services?.map((s) => s.serviceName) ?? []
                }
                readOnly={readOnly}
                onServicesChange={handleServicesChange}
              />

              <TemplateParametersSection
                parameters={displayVersion.parameters}
                defaultParameterValues={displayVersion.defaultParameterValues}
                readOnly={readOnly}
                onParametersChange={handleParametersChange}
              />

              <TemplateNetworksVolumes
                networks={displayVersion.networks}
                volumes={displayVersion.volumes}
                readOnly={readOnly}
                onNetworksChange={handleNetworksChange}
                onVolumesChange={handleVolumesChange}
              />
            </>
          ) : (
            <div className="text-center py-12 text-muted-foreground">
              No version data available. Create a draft to start editing.
            </div>
          )}
        </div>

        {/* Version Sidebar */}
        <div className="w-[280px] border-l bg-muted/30 hidden lg:block">
          <VersionSidebar
            template={template}
            versions={allVersions}
            selectedVersionId={selectedVersionId}
            onSelectVersion={setSelectedVersionId}
          />
        </div>
      </div>

      {/* Publish confirmation */}
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish Draft</AlertDialogTitle>
            <AlertDialogDescription>
              This will publish the current draft as a new version. Add optional
              release notes:
            </AlertDialogDescription>
          </AlertDialogHeader>
          <textarea
            className="w-full rounded-md border bg-background p-2 text-sm"
            rows={3}
            placeholder="What changed in this version?"
            value={publishNotes}
            onChange={(e) => setPublishNotes(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePublish}
              disabled={publishDraftMutation.isPending}
            >
              {publishDraftMutation.isPending && (
                <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
              )}
              Publish
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Discard confirmation */}
      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard Draft</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to discard the current draft? This cannot be
              undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDiscard}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Discard
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `npx -w client tsc --noEmit --pretty 2>&1 | head -20`
Expected: No errors

- [ ] **Step 3: Verify the dev server loads both pages**

Run: `curl -s http://localhost:3005/stack-templates | head -5`
Expected: HTML response (the SPA shell)

- [ ] **Step 4: Commit**

```bash
git add client/src/app/stack-templates/[templateId]/page.tsx
git commit -m "feat: implement stack template detail page with version sidebar and draft editing"
```

---

### Task 12: Final Verification

- [ ] **Step 1: Run full TypeScript check**

Run: `npx -w client tsc --noEmit --pretty`
Expected: No errors

- [ ] **Step 2: Run client tests**

Run: `npm test -w client 2>&1 | tail -20`
Expected: All existing tests pass

- [ ] **Step 3: Run linter**

Run: `npm run lint -w client 2>&1 | tail -20`
Expected: No errors in new files

- [ ] **Step 4: Manual verification checklist**

Open `http://localhost:3005` in a browser and verify:
1. Admin tab in sidebar shows "Stack Templates" entry
2. `/stack-templates` page loads with table (may be empty if no templates exist)
3. "Create Template" dialog opens and submits successfully
4. After creating, redirects to `/stack-templates/:id` detail page
5. Detail page shows metadata card, empty services/parameters/networks/volumes sections
6. Version sidebar shows the draft
7. "Add Service" opens the service edit dialog with all tabs
8. Back link navigates to list page

- [ ] **Step 5: Commit any fixes from verification**

```bash
git add -A
git commit -m "fix: address issues found during stack template UI verification"
```
