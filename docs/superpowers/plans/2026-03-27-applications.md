# Applications Feature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Deployments" UI with an "Applications" feature backed by user stack templates (`StackTemplate` with `source = user`).

**Architecture:** Applications are `StackTemplate` records with `source = "user"`. Creating an application creates a user template. Deploying instantiates a `Stack` from the template and applies it via the stack reconciler + deployment orchestrator. No schema changes needed — we filter stacks by their template's source. One new API endpoint for importing deployment configs.

**Tech Stack:** React, TypeScript, TanStack Query, Express, Prisma, existing stack template/stack services.

---

### Task 1: Add import-deployment endpoint to stack-templates routes

**Files:**
- Modify: `server/src/routes/stack-templates.ts`
- Modify: `server/src/services/stacks/stack-template-service.ts`
- Create: `server/src/__tests__/import-deployment.test.ts`

This task adds `POST /api/stack-templates/import-deployment/:configId` which reads a `DeploymentConfiguration` and creates a user `StackTemplate` with a published version containing one service.

- [ ] **Step 1: Write the failing test for successful import**

```ts
// server/src/__tests__/import-deployment.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import { createTestApp } from './test-helpers';

describe('POST /api/stack-templates/import-deployment/:configId', () => {
  let app: any;

  beforeEach(() => {
    app = createTestApp();
  });

  it('should import a deployment config into a user stack template', async () => {
    // First create a deployment config to import
    const deploymentConfig = await createTestDeploymentConfig({
      applicationName: 'my-web-app',
      dockerImage: 'myapp',
      dockerTag: 'v1.0.0',
      dockerRegistry: 'ghcr.io',
      containerConfig: {
        ports: [{ containerPort: 8080, hostPort: 8080, protocol: 'tcp' }],
        volumes: [{ hostPath: '/data', containerPath: '/app/data', mode: 'rw' }],
        environment: [{ name: 'NODE_ENV', value: 'production' }],
        labels: { app: 'web' },
        networks: ['app-net'],
      },
      healthCheckConfig: {
        endpoint: '/health',
        method: 'GET',
        expectedStatus: [200],
        timeout: 5000,
        retries: 3,
        interval: 10000,
      },
      rollbackConfig: {
        enabled: true,
        maxWaitTime: 60000,
        keepOldContainer: false,
      },
      hostname: 'app.example.com',
      listeningPort: 8080,
      enableSsl: true,
      environmentId: testEnvironmentId,
    });

    const res = await request(app)
      .post(`/api/stack-templates/import-deployment/${deploymentConfig.id}`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(201);

    expect(res.body.success).toBe(true);
    const template = res.body.data;
    expect(template.name).toBe('my-web-app');
    expect(template.source).toBe('user');
    expect(template.scope).toBe('environment');
    expect(template.currentVersion).toBeDefined();
    expect(template.currentVersion.status).toBe('published');

    // Verify the service was mapped correctly
    const version = template.currentVersion;
    expect(version.services).toHaveLength(1);
    const service = version.services[0];
    expect(service.dockerImage).toBe('ghcr.io/myapp');
    expect(service.dockerTag).toBe('v1.0.0');
    expect(service.serviceType).toBe('StatelessWeb');
    expect(service.routing.hostname).toBe('app.example.com');
    expect(service.routing.listeningPort).toBe(8080);
    expect(service.routing.enableSsl).toBe(true);
    expect(service.containerConfig.env).toEqual({ NODE_ENV: 'production' });
    expect(service.containerConfig.ports).toEqual([
      { containerPort: 8080, hostPort: 8080, protocol: 'tcp' },
    ]);
  });

  it('should return 404 for non-existent deployment config', async () => {
    const res = await request(app)
      .post('/api/stack-templates/import-deployment/nonexistent-id')
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(404);

    expect(res.body.success).toBe(false);
  });

  it('should set serviceType to Stateful when no routing is configured', async () => {
    const deploymentConfig = await createTestDeploymentConfig({
      applicationName: 'my-worker',
      dockerImage: 'worker',
      dockerTag: 'latest',
      containerConfig: {
        ports: [],
        volumes: [],
        environment: [],
        labels: {},
        networks: [],
      },
      healthCheckConfig: {
        endpoint: '/health',
        method: 'GET',
        expectedStatus: [200],
        timeout: 5000,
        retries: 3,
        interval: 10000,
      },
      rollbackConfig: { enabled: false, maxWaitTime: 30000, keepOldContainer: false },
      environmentId: testEnvironmentId,
    });

    const res = await request(app)
      .post(`/api/stack-templates/import-deployment/${deploymentConfig.id}`)
      .set('Authorization', `Bearer ${testApiKey}`)
      .expect(201);

    const service = res.body.data.currentVersion.services[0];
    expect(service.serviceType).toBe('Stateful');
    expect(service.routing).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx -w server vitest run src/__tests__/import-deployment.test.ts`
Expected: FAIL — route does not exist yet.

- [ ] **Step 3: Add `importDeploymentConfig` method to StackTemplateService**

In `server/src/services/stacks/stack-template-service.ts`, add this method:

```ts
async importDeploymentConfig(
  configId: string,
  createdById?: string
): Promise<StackTemplateInfo> {
  // 1. Look up the DeploymentConfiguration
  const config = await this.prisma.deploymentConfiguration.findUnique({
    where: { id: configId },
  });
  if (!config) {
    throw new TemplateError('Deployment configuration not found', 404);
  }

  const containerConfig = config.containerConfig as any;
  const healthCheckConfig = config.healthCheckConfig as any;
  const rollbackConfig = config.rollbackConfig as any;

  // 2. Determine service type
  const hasRouting = !!config.hostname && !!config.listeningPort;
  const serviceType = hasRouting ? 'StatelessWeb' : 'Stateful';

  // 3. Build docker image (prepend registry if present)
  const dockerImage = config.dockerRegistry
    ? `${config.dockerRegistry}/${config.dockerImage}`
    : config.dockerImage;

  // 4. Map container config
  const stackContainerConfig: any = {
    env: Object.fromEntries(
      (containerConfig.environment ?? []).map((e: any) => [e.name, e.value])
    ),
    ports: (containerConfig.ports ?? []).map((p: any) => ({
      containerPort: p.containerPort,
      hostPort: p.hostPort,
      protocol: p.protocol ?? 'tcp',
    })),
    mounts: (containerConfig.volumes ?? []).map((v: any) => ({
      source: v.hostPath,
      target: v.containerPath,
      type: 'bind' as const,
      readOnly: v.mode === 'ro',
    })),
    labels: containerConfig.labels ?? {},
    joinNetworks: containerConfig.networks ?? [],
    restartPolicy: 'unless-stopped' as const,
  };

  // 5. Map health check to Docker healthcheck format
  if (healthCheckConfig?.endpoint) {
    stackContainerConfig.healthcheck = {
      test: ['CMD', 'curl', '-f', `http://localhost:${config.listeningPort ?? 80}${healthCheckConfig.endpoint}`],
      interval: healthCheckConfig.interval ?? 10000,
      timeout: healthCheckConfig.timeout ?? 5000,
      retries: healthCheckConfig.retries ?? 3,
      startPeriod: 10000,
    };
  }

  // 6. Build routing config (only for StatelessWeb)
  const routing = hasRouting
    ? {
        hostname: config.hostname!,
        listeningPort: config.listeningPort!,
        enableSsl: config.enableSsl ?? false,
        ...(config.tlsCertificateId ? { tlsCertificateId: config.tlsCertificateId } : {}),
      }
    : undefined;

  // 7. Build volumes for the template version
  const volumes = (containerConfig.volumes ?? [])
    .filter((v: any) => v.hostPath)
    .map((v: any) => ({
      name: v.hostPath.replace(/\//g, '-').replace(/^-/, ''),
      driver: 'local',
    }));

  // 8. Build networks
  const networks = (containerConfig.networks ?? []).map((n: string) => ({
    name: n,
  }));

  // 9. Build default parameter values (rollback config)
  const defaultParameterValues: Record<string, any> = {};
  if (rollbackConfig) {
    defaultParameterValues.rollbackEnabled = rollbackConfig.enabled ?? false;
    defaultParameterValues.rollbackMaxWaitTime = rollbackConfig.maxWaitTime ?? 30000;
    defaultParameterValues.rollbackKeepOldContainer = rollbackConfig.keepOldContainer ?? false;
  }

  // 10. Create the user template with a published version
  const createRequest = {
    name: config.applicationName,
    displayName: config.applicationName,
    scope: 'environment' as const,
    parameters: [],
    networks,
    volumes,
    services: [
      {
        serviceName: config.applicationName,
        serviceType: serviceType,
        dockerImage,
        dockerTag: config.dockerTag ?? 'latest',
        containerConfig: stackContainerConfig,
        dependsOn: [],
        order: 0,
        ...(routing ? { routing } : {}),
      },
    ],
  };

  // Create the template (this creates a draft)
  const template = await this.createUserTemplate(createRequest, createdById);

  // Publish the draft immediately so it's ready to deploy
  await this.publishDraft(template.id, { notes: `Imported from deployment config: ${config.applicationName}` });

  // Return the full template with published version
  return (await this.getTemplate(template.id))!;
}
```

- [ ] **Step 4: Add the route handler to stack-templates.ts**

In `server/src/routes/stack-templates.ts`, add before the `export default router` line:

```ts
// POST /import-deployment/:configId — Import deployment config as user template
router.post('/import-deployment/:configId', requirePermission('stacks:write'), async (req, res) => {
  try {
    const service = getTemplateService();
    const template = await service.importDeploymentConfig(
      String(req.params.configId),
      (req as any).user?.id
    );

    logger.info(
      { configId: req.params.configId, templateId: template.id },
      'Deployment config imported as user template'
    );
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to import deployment config');
  }
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/import-deployment.test.ts`
Expected: PASS

- [ ] **Step 6: Run existing stack template tests to verify no regressions**

Run: `npx -w server vitest run`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/stack-templates.ts server/src/services/stacks/stack-template-service.ts server/src/__tests__/import-deployment.test.ts
git commit -m "feat: add import-deployment endpoint for converting deployment configs to user templates"
```

---

### Task 2: Filter user stacks out of host and environment views

**Files:**
- Modify: `server/src/routes/stacks.ts:34-58`

The `GET /api/stacks` endpoint currently returns all non-removed stacks. We need to filter out stacks whose template has `source = "user"` when listing for host/environment views, so user application stacks don't appear in infrastructure views.

- [ ] **Step 1: Write the failing test**

Add a test that creates a stack from a user template and verifies it doesn't appear in host/environment stack listings. Use existing test patterns in the stacks test file.

```ts
// In the appropriate stacks test file
it('should not return stacks from user templates in host listing', async () => {
  // Create a user template and instantiate a stack from it
  // ...
  const res = await request(app)
    .get('/api/stacks?scope=host')
    .set('Authorization', `Bearer ${testApiKey}`)
    .expect(200);

  const stackNames = res.body.data.map((s: any) => s.name);
  expect(stackNames).not.toContain('user-app-stack');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx -w server vitest run` (the relevant stacks test file)
Expected: FAIL — user stacks currently appear in host listing.

- [ ] **Step 3: Update the GET /api/stacks handler to filter by template source**

In `server/src/routes/stacks.ts`, update the `GET /` handler (around line 34-58):

```ts
router.get('/', requirePermission('stacks:read'), async (req, res) => {
  try {
    const { environmentId, scope, source } = req.query;
    const where: any = { status: { not: 'removed' } };
    if (scope === 'host') {
      where.environmentId = null;
    } else if (environmentId && typeof environmentId === 'string') {
      where.environmentId = environmentId;
    }

    // Filter by template source if specified
    // Default: exclude user stacks from host/environment listings
    if (source === 'user') {
      where.template = { source: 'user' };
    } else if (source === 'system') {
      where.OR = [
        { template: { source: 'system' } },
        { templateId: null },
      ];
    } else if (scope === 'host' || environmentId) {
      // When listing for host/environment, exclude user stacks by default
      where.OR = [
        { template: { source: 'system' } },
        { templateId: null },
      ];
    }

    const stacks = await prisma.stack.findMany({
      where,
      include: {
        services: true,
        template: { select: { source: true, currentVersion: { select: { version: true } } } },
      },
      orderBy: { name: 'asc' },
    });

    res.json({ success: true, data: stacks.map(serializeStack) });
  } catch (error) {
    logger.error({ error }, 'Failed to list stacks');
    res.status(500).json({ success: false, message: 'Failed to list stacks' });
  }
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx -w server vitest run`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/stacks.ts
git commit -m "feat: filter user template stacks out of host/environment listings"
```

---

### Task 3: Add frontend route config and navigation for applications

**Files:**
- Modify: `client/src/lib/route-config.ts:145-172`

Replace the deployments nav entry with applications. The deployments routes stay in the code but are no longer shown in navigation.

- [ ] **Step 1: Update route-config.ts**

Replace the `/deployments` entry (lines 145-172) with:

```ts
"/applications": {
  path: "/applications",
  title: "Applications",
  icon: IconRocket,
  showInNav: true,
  navGroup: "main",
  navSection: "applications",
  description: "User application management",
  children: {
    new: {
      path: "/applications/new",
      title: "New Application",
      breadcrumbLabel: "New",
      parent: "/applications",
      showInNav: false,
    },
    detail: {
      path: "/applications/:id",
      title: "Application Details",
      breadcrumbLabel: "Details",
      parent: "/applications",
      showInNav: false,
    },
  },
},
```

Keep the `/deployments` entry but set `showInNav: false`:

```ts
"/deployments": {
  path: "/deployments",
  title: "Deployments",
  icon: IconRocket,
  showInNav: false,
  navGroup: "main",
  navSection: "applications",
  description: "Zero-downtime deployment management",
  helpDoc: "deployments/deployment-overview",
  children: {
    new: {
      path: "/deployments/new",
      title: "New Deployment Configuration",
      breadcrumbLabel: "New Configuration",
      parent: "/deployments",
      showInNav: false,
      helpDoc: "deployments/creating-deployments",
    },
    detail: {
      path: "/deployments/:id",
      title: "Deployment Details",
      breadcrumbLabel: "Details",
      parent: "/deployments",
      showInNav: false,
      helpDoc: "deployments/deployment-lifecycle",
    },
  },
},
```

- [ ] **Step 2: Register routes in the router**

Find the router file (likely `client/src/app/router.tsx` or similar) and add route entries for `/applications`, `/applications/new`, and `/applications/:id`. Point them to placeholder page components for now.

- [ ] **Step 3: Verify the dev server loads without errors**

Run: `npm run dev` and navigate to `http://localhost:3005`. Confirm:
- "Applications" appears in sidebar where "Deployments" was
- "Deployments" no longer appears in sidebar
- Clicking "Applications" navigates to `/applications`

- [ ] **Step 4: Commit**

```bash
git add client/src/lib/route-config.ts client/src/app/router.tsx
git commit -m "feat: add applications route config and hide deployments from nav"
```

---

### Task 4: Create applications list page

**Files:**
- Create: `client/src/app/applications/page.tsx`
- Create: `client/src/hooks/use-applications.ts`

The applications list page shows all user stack templates with their status, service count, and actions.

- [ ] **Step 1: Create the useApplications hook**

Create `client/src/hooks/use-applications.ts`:

```ts
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { StackTemplate } from "@mini-infra/types";
import { useCorrelationId } from "./use-correlation-id";

interface ApplicationsResponse {
  success: boolean;
  data: StackTemplate[];
}

async function fetchApplications(correlationId: string): Promise<ApplicationsResponse> {
  const url = new URL("/api/stack-templates", window.location.origin);
  url.searchParams.set("source", "user");
  const res = await fetch(url.toString(), {
    credentials: "include",
    headers: { "x-correlation-id": correlationId },
  });
  if (!res.ok) throw new Error("Failed to fetch applications");
  return res.json();
}

export function useApplications() {
  const correlationId = useCorrelationId();
  return useQuery({
    queryKey: ["applications"],
    queryFn: () => fetchApplications(correlationId),
  });
}

async function deleteApplication(templateId: string, correlationId: string): Promise<void> {
  const res = await fetch(`/api/stack-templates/${templateId}`, {
    method: "DELETE",
    credentials: "include",
    headers: { "x-correlation-id": correlationId },
  });
  if (!res.ok) throw new Error("Failed to delete application");
}

export function useDeleteApplication() {
  const queryClient = useQueryClient();
  const correlationId = useCorrelationId();
  return useMutation({
    mutationFn: (templateId: string) => deleteApplication(templateId, correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}

async function importDeploymentConfig(configId: string, correlationId: string): Promise<StackTemplate> {
  const res = await fetch(`/api/stack-templates/import-deployment/${configId}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "x-correlation-id": correlationId,
    },
  });
  if (!res.ok) throw new Error("Failed to import deployment config");
  const json = await res.json();
  return json.data;
}

export function useImportDeploymentConfig() {
  const queryClient = useQueryClient();
  const correlationId = useCorrelationId();
  return useMutation({
    mutationFn: (configId: string) => importDeploymentConfig(configId, correlationId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["applications"] });
    },
  });
}
```

- [ ] **Step 2: Create the applications list page**

Create `client/src/app/applications/page.tsx`:

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApplications, useDeleteApplication } from "@/hooks/use-applications";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  IconPlus,
  IconRocket,
  IconDotsVertical,
  IconEdit,
  IconTrash,
  IconPlayerStop,
  IconDownload,
  IconAlertCircle,
} from "@tabler/icons-react";
import { ImportDeploymentDialog } from "./import-deployment-dialog";
import { toast } from "sonner";

export function ApplicationsPage() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useApplications();
  const deleteApp = useDeleteApplication();
  const [importDialogOpen, setImportDialogOpen] = useState(false);

  const applications = data?.data ?? [];

  if (isError) {
    return (
      <Alert variant="destructive">
        <IconAlertCircle className="h-4 w-4" />
        <AlertDescription>
          Failed to load applications: {error instanceof Error ? error.message : "Unknown error"}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Applications</h1>
          <p className="text-muted-foreground">Manage your application deployments</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
            <IconDownload className="h-4 w-4 mr-2" />
            Import Deployment
          </Button>
          <Button onClick={() => navigate("/applications/new")}>
            <IconPlus className="h-4 w-4 mr-2" />
            Add Application
          </Button>
        </div>
      </div>

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i}>
              <CardContent className="p-6">
                <Skeleton className="h-6 w-3/4 mb-4" />
                <Skeleton className="h-4 w-1/2" />
              </CardContent>
            </Card>
          ))}
        </div>
      ) : applications.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <IconRocket className="h-12 w-12 text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Applications</h3>
            <p className="text-muted-foreground mb-4">
              Create your first application or import from an existing deployment configuration.
            </p>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setImportDialogOpen(true)}>
                <IconDownload className="h-4 w-4 mr-2" />
                Import Deployment
              </Button>
              <Button onClick={() => navigate("/applications/new")}>
                <IconPlus className="h-4 w-4 mr-2" />
                Add Application
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          {applications.map((app) => (
            <Card key={app.id} className="hover:border-primary/50 transition-colors">
              <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                <div>
                  <CardTitle className="text-base">{app.displayName}</CardTitle>
                  {app.description && (
                    <p className="text-sm text-muted-foreground mt-1">{app.description}</p>
                  )}
                </div>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon" className="h-8 w-8">
                      <IconDotsVertical className="h-4 w-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={() => navigate(`/applications/${app.id}`)}>
                      <IconEdit className="h-4 w-4 mr-2" />
                      Edit
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => {
                        deleteApp.mutate(app.id, {
                          onSuccess: () => toast.success(`${app.displayName} deleted`),
                          onError: (err) => toast.error(`Failed to delete: ${err.message}`),
                        });
                      }}
                    >
                      <IconTrash className="h-4 w-4 mr-2" />
                      Delete
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  {app.currentVersion && (
                    <span>
                      {app.currentVersion.services?.length ?? 0} service
                      {(app.currentVersion.services?.length ?? 0) !== 1 ? "s" : ""}
                    </span>
                  )}
                </div>
                <div className="mt-4 flex gap-2">
                  <Button size="sm" className="flex-1">
                    <IconRocket className="h-4 w-4 mr-1" />
                    Deploy
                  </Button>
                  <Button size="sm" variant="outline">
                    <IconPlayerStop className="h-4 w-4 mr-1" />
                    Stop
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <ImportDeploymentDialog
        open={importDialogOpen}
        onOpenChange={setImportDialogOpen}
      />
    </div>
  );
}
```

- [ ] **Step 3: Verify the page loads**

Run: navigate to `http://localhost:3005/applications`
Expected: The empty state appears with "No Applications" message and buttons.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/use-applications.ts client/src/app/applications/page.tsx
git commit -m "feat: add applications list page and useApplications hook"
```

---

### Task 5: Create import deployment dialog

**Files:**
- Create: `client/src/app/applications/import-deployment-dialog.tsx`

A dialog that lists existing DeploymentConfigurations and lets the user pick one to import.

- [ ] **Step 1: Create the import dialog component**

Create `client/src/app/applications/import-deployment-dialog.tsx`:

```tsx
import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useDeploymentConfigs } from "@/hooks/use-deployment-configs";
import { useImportDeploymentConfig } from "@/hooks/use-applications";
import { IconDownload, IconCheck } from "@tabler/icons-react";
import { toast } from "sonner";

interface ImportDeploymentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ImportDeploymentDialog({ open, onOpenChange }: ImportDeploymentDialogProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const { data, isLoading } = useDeploymentConfigs({ enabled: open });
  const importMutation = useImportDeploymentConfig();

  const configs = data?.data ?? [];

  const handleImport = () => {
    if (!selectedId) return;
    importMutation.mutate(selectedId, {
      onSuccess: (template) => {
        toast.success(`Imported "${template.displayName}" as application`);
        onOpenChange(false);
        setSelectedId(null);
      },
      onError: (err) => {
        toast.error(`Import failed: ${err.message}`);
      },
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Import Deployment Configuration</DialogTitle>
          <DialogDescription>
            Select a deployment configuration to import as an application.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2 max-h-80 overflow-y-auto">
          {isLoading ? (
            Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))
          ) : configs.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">
              No deployment configurations found.
            </p>
          ) : (
            configs.map((config) => (
              <button
                key={config.id}
                className={`w-full text-left p-3 rounded-md border transition-colors ${
                  selectedId === config.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-primary/50"
                }`}
                onClick={() => setSelectedId(config.id)}
              >
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-medium">{config.applicationName}</div>
                    <div className="text-sm text-muted-foreground">
                      {config.dockerRegistry ? `${config.dockerRegistry}/` : ""}
                      {config.dockerImage}:{config.dockerTag}
                    </div>
                  </div>
                  {selectedId === config.id && (
                    <IconCheck className="h-5 w-5 text-primary" />
                  )}
                </div>
              </button>
            ))
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleImport}
            disabled={!selectedId || importMutation.isPending}
          >
            <IconDownload className="h-4 w-4 mr-2" />
            {importMutation.isPending ? "Importing..." : "Import"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 2: Verify the dialog works end-to-end**

Run: Navigate to `http://localhost:3005/applications`, click "Import Deployment". Confirm:
- Dialog opens and lists existing deployment configs
- Selecting one and clicking Import creates a new application
- The new application appears in the list

- [ ] **Step 3: Commit**

```bash
git add client/src/app/applications/import-deployment-dialog.tsx
git commit -m "feat: add import deployment dialog for applications page"
```

---

### Task 6: Create application form page (new/edit)

**Files:**
- Create: `client/src/app/applications/new/page.tsx`
- Create: `client/src/app/applications/[id]/page.tsx`

These pages reuse the stack template creation/editing workflow. The "new" page creates a user template. The "edit" page loads an existing template for modification.

- [ ] **Step 1: Explore the existing stack template form components**

Read the existing stack template form/editor components to understand what can be reused. Look at how the environment detail page or host page handles stack template creation. Check for existing form components in `client/src/components/stacks/`.

- [ ] **Step 2: Create the new application page**

Create `client/src/app/applications/new/page.tsx`. This page should:
- Use the stack template creation form/components
- Pre-set `source: "user"` and `scope: "environment"`
- On submit, call `POST /api/stack-templates` with the form data
- On success, navigate to `/applications`

The exact implementation depends on what existing form components exist. Reuse as much as possible from the stack template UI.

- [ ] **Step 3: Create the edit application page**

Create `client/src/app/applications/[id]/page.tsx`. This page should:
- Fetch the template by ID via `GET /api/stack-templates/:id`
- Load the current version's services, networks, volumes into the form
- On submit, create a new draft and publish it
- On success, navigate to `/applications`

- [ ] **Step 4: Wire up Deploy and Stop buttons on the list page**

Update `client/src/app/applications/page.tsx` to make the Deploy and Stop buttons functional:
- **Deploy**: Call `POST /api/stack-templates/:id/instantiate` to create/update a stack, then `POST /api/stacks/:stackId/apply` to apply it
- **Stop**: Find the stack associated with this template, call `POST /api/stacks/:stackId/stop`

This requires looking up the stack for a given template. Add a query to find stacks by templateId.

- [ ] **Step 5: Test the full flow**

Navigate to `http://localhost:3005/applications/new`. Create a new application with:
- A service with a Docker image
- Port mappings
- Environment variables

Verify it appears in the list. Test Deploy and Stop.

- [ ] **Step 6: Commit**

```bash
git add client/src/app/applications/
git commit -m "feat: add application create/edit pages and deploy/stop actions"
```

---

### Task 7: Register application routes in the router

**Files:**
- Modify: The router file (find via `client/src/app/router.tsx` or similar)

- [ ] **Step 1: Find the router configuration**

Search for where routes are registered (likely imports `DeploymentsPage` or similar).

- [ ] **Step 2: Add application route entries**

Add routes:
```tsx
{ path: "/applications", element: <ApplicationsPage /> },
{ path: "/applications/new", element: <ApplicationNewPage /> },
{ path: "/applications/:id", element: <ApplicationDetailPage /> },
```

Import the page components from their respective files.

- [ ] **Step 3: Verify all routes work**

Navigate to each route and confirm pages load:
- `/applications` — list page
- `/applications/new` — create form
- `/applications/:id` — edit form (with a real template ID)

- [ ] **Step 4: Commit**

```bash
git add client/src/app/router.tsx
git commit -m "feat: register application routes in router"
```

---

### Task 8: Final integration testing and cleanup

**Files:**
- Various

- [ ] **Step 1: Run all server tests**

Run: `npx -w server vitest run`
Expected: All PASS

- [ ] **Step 2: Run all client tests**

Run: `npm test -w client`
Expected: All PASS

- [ ] **Step 3: Manual end-to-end test**

Test the full flow:
1. Navigate to `/applications` — empty state shows
2. Click "Add Application" — form loads
3. Create an application with a service — redirects to list, app appears
4. Click Deploy — stack is created and applied
5. Click Stop — stack containers stop
6. Click "Import Deployment" — dialog shows deployment configs
7. Import one — new application appears
8. Navigate to `/environments/:id` — no user stacks visible
9. Navigate to host page — no user stacks visible
10. Sidebar shows "Applications" instead of "Deployments"

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: integration testing fixes for applications feature"
```
