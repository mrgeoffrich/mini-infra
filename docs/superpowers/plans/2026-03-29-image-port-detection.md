# Image Port Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect Docker image EXPOSE ports from the registry V2 API and use them to populate the routing listening port on the new application form.

**Architecture:** A new `ImageInspectService` queries Docker registry V2 APIs (Docker Hub, GHCR, generic OCI) to fetch image config blobs without pulling the image. A new route exposes this as `GET /api/images/inspect-ports`. The frontend adds a "Detect Ports" button that triggers the lookup and auto-fills or shows a dropdown for the routing listening port.

**Tech Stack:** Express route, Docker Registry V2 HTTP API, TanStack Query `useMutation`, React Hook Form, Zod validation

---

### File Structure

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `server/src/services/image-inspect.ts` | Registry V2 API client — fetches manifests and config blobs to extract exposed ports |
| Create | `server/src/__tests__/image-inspect.test.ts` | Unit tests for `ImageInspectService` |
| Create | `server/src/routes/images.ts` | API endpoint `GET /api/images/inspect-ports` |
| Create | `server/src/__tests__/images-api.test.ts` | Integration tests for the images route |
| Modify | `server/src/app.ts` | Register the new images route |
| Create | `client/src/hooks/use-detect-image-ports.ts` | `useMutation` hook for the detect-ports API |
| Modify | `client/src/app/applications/new/page.tsx` | Add Detect Ports button, dropdown logic for listening port |

---

### Task 1: ImageInspectService — Unit Tests and Implementation

**Files:**
- Create: `server/src/services/image-inspect.ts`
- Create: `server/src/__tests__/image-inspect.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `server/src/__tests__/image-inspect.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ImageInspectService } from "../services/image-inspect";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("ImageInspectService", () => {
  let service: ImageInspectService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ImageInspectService();
  });

  describe("getExposedPorts", () => {
    it("returns exposed ports from a Docker Hub official image", async () => {
      // Token exchange response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      // Manifest response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:abc123" },
        }),
      });
      // Config blob response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            ExposedPorts: { "80/tcp": {}, "443/tcp": {} },
          },
        }),
      });

      const ports = await service.getExposedPorts("nginx", "latest");

      expect(ports).toEqual([80, 443]);
      // Verify token request went to Docker Hub auth
      expect(mockFetch.mock.calls[0][0]).toContain("auth.docker.io/token");
      expect(mockFetch.mock.calls[0][0]).toContain("repository:library/nginx");
    });

    it("returns exposed ports from a Docker Hub user image", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:abc123" },
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            ExposedPorts: { "3000/tcp": {} },
          },
        }),
      });

      const ports = await service.getExposedPorts("myuser/myapp", "v1");

      expect(ports).toEqual([3000]);
      expect(mockFetch.mock.calls[0][0]).toContain("repository:myuser/myapp");
    });

    it("returns exposed ports from GHCR with credentials", async () => {
      const creds = { username: "user", password: "pat-token" };
      service = new ImageInspectService(creds);

      // GHCR manifest (no separate token exchange needed with Basic auth)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:def456" },
        }),
      });
      // Config blob
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {
            ExposedPorts: { "8080/tcp": {} },
          },
        }),
      });

      const ports = await service.getExposedPorts("ghcr.io/owner/repo", "latest");

      expect(ports).toEqual([8080]);
      // Verify Basic auth header was sent
      const manifestCall = mockFetch.mock.calls[0];
      expect(manifestCall[1].headers.Authorization).toMatch(/^Basic /);
    });

    it("returns empty array when image has no exposed ports", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: { digest: "sha256:abc123" },
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          config: {},
        }),
      });

      const ports = await service.getExposedPorts("alpine", "latest");

      expect(ports).toEqual([]);
    });

    it("throws on image not found (404)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 404,
      });

      await expect(
        service.getExposedPorts("nonexistent/image", "latest"),
      ).rejects.toThrow("Image not found");
    });

    it("throws on auth failure (401)", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ token: "test-token" }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
      });

      await expect(
        service.getExposedPorts("private/image", "latest"),
      ).rejects.toThrow("Authentication failed");
    });

    it("throws on timeout", async () => {
      mockFetch.mockImplementationOnce(
        () => new Promise((_, reject) => setTimeout(() => reject(new Error("AbortError")), 100)),
      );

      await expect(
        service.getExposedPorts("slow/image", "latest"),
      ).rejects.toThrow();
    });
  });

  describe("parseImageReference", () => {
    it("parses official Docker Hub images", () => {
      const result = service.parseImageReference("nginx");
      expect(result).toEqual({
        registry: "registry-1.docker.io",
        repository: "library/nginx",
        isDockerHub: true,
      });
    });

    it("parses Docker Hub user images", () => {
      const result = service.parseImageReference("myuser/myapp");
      expect(result).toEqual({
        registry: "registry-1.docker.io",
        repository: "myuser/myapp",
        isDockerHub: true,
      });
    });

    it("parses GHCR images", () => {
      const result = service.parseImageReference("ghcr.io/owner/repo");
      expect(result).toEqual({
        registry: "ghcr.io",
        repository: "owner/repo",
        isDockerHub: false,
      });
    });

    it("parses images with custom registry and port", () => {
      const result = service.parseImageReference("localhost:5000/myimage");
      expect(result).toEqual({
        registry: "localhost:5000",
        repository: "myimage",
        isDockerHub: false,
      });
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx -w server vitest run src/__tests__/image-inspect.test.ts`
Expected: FAIL — `Cannot find module '../services/image-inspect'`

- [ ] **Step 3: Implement ImageInspectService**

Create `server/src/services/image-inspect.ts`:

```typescript
import { servicesLogger } from "../lib/logger-factory";

const logger = servicesLogger();

const DOCKER_HUB_AUTH = "https://auth.docker.io/token";
const DOCKER_HUB_REGISTRY = "https://registry-1.docker.io";
const TIMEOUT_MS = 10000;

interface ImageReference {
  registry: string;
  repository: string;
  isDockerHub: boolean;
}

interface Credentials {
  username: string;
  password: string;
}

export class ImageInspectService {
  private credentials: Credentials | null;

  constructor(credentials?: Credentials | null) {
    this.credentials = credentials ?? null;
  }

  /**
   * Parse an image name into registry, repository, and whether it's Docker Hub.
   */
  parseImageReference(image: string): ImageReference {
    const parts = image.split("/");

    if (parts.length === 1) {
      return {
        registry: "registry-1.docker.io",
        repository: `library/${parts[0]}`,
        isDockerHub: true,
      };
    }

    const firstPart = parts[0];
    if (firstPart.includes(".") || firstPart.includes(":")) {
      return {
        registry: firstPart,
        repository: parts.slice(1).join("/"),
        isDockerHub: false,
      };
    }

    return {
      registry: "registry-1.docker.io",
      repository: image,
      isDockerHub: true,
    };
  }

  /**
   * Fetch exposed ports from a Docker image without pulling it.
   * Queries the registry V2 API for the manifest and config blob.
   */
  async getExposedPorts(image: string, tag: string): Promise<number[]> {
    const ref = this.parseImageReference(image);
    const authHeader = await this.getAuthHeader(ref);

    const registryBase = ref.registry.startsWith("localhost")
      ? `http://${ref.registry}`
      : `https://${ref.registry}`;

    // 1. Fetch manifest
    const manifestUrl = `${registryBase}/v2/${ref.repository}/manifests/${tag}`;
    const manifestRes = await this.fetchWithTimeout(manifestUrl, {
      headers: {
        Accept: "application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json",
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });

    if (!manifestRes.ok) {
      if (manifestRes.status === 404) throw new Error("Image not found");
      if (manifestRes.status === 401) throw new Error("Authentication failed");
      throw new Error(`Registry returned ${manifestRes.status}`);
    }

    const manifest = await manifestRes.json();
    const configDigest = manifest.config?.digest;
    if (!configDigest) {
      logger.warn({ image, tag }, "Manifest has no config digest");
      return [];
    }

    // 2. Fetch config blob
    const blobUrl = `${registryBase}/v2/${ref.repository}/blobs/${configDigest}`;
    const blobRes = await this.fetchWithTimeout(blobUrl, {
      headers: {
        ...(authHeader ? { Authorization: authHeader } : {}),
      },
    });

    if (!blobRes.ok) {
      throw new Error(`Failed to fetch config blob: ${blobRes.status}`);
    }

    const config = await blobRes.json();
    const exposedPorts = config.config?.ExposedPorts ?? {};

    // Parse "80/tcp" -> 80, sort numerically
    const ports = Object.keys(exposedPorts)
      .map((key) => parseInt(key.split("/")[0], 10))
      .filter((p) => !isNaN(p))
      .sort((a, b) => a - b);

    logger.info({ image, tag, ports }, "Detected exposed ports from registry");
    return ports;
  }

  private async getAuthHeader(ref: ImageReference): Promise<string | null> {
    if (ref.isDockerHub) {
      return this.getDockerHubToken(ref.repository);
    }

    if (this.credentials) {
      const encoded = Buffer.from(
        `${this.credentials.username}:${this.credentials.password}`,
      ).toString("base64");
      return `Basic ${encoded}`;
    }

    return null;
  }

  private async getDockerHubToken(repository: string): Promise<string> {
    const params = new URLSearchParams({
      service: "registry.docker.io",
      scope: `repository:${repository}:pull`,
    });

    const url = `${DOCKER_HUB_AUTH}?${params}`;
    const headers: Record<string, string> = {};

    if (this.credentials) {
      const encoded = Buffer.from(
        `${this.credentials.username}:${this.credentials.password}`,
      ).toString("base64");
      headers.Authorization = `Basic ${encoded}`;
    }

    const res = await this.fetchWithTimeout(url, { headers });
    if (!res.ok) {
      throw new Error("Failed to obtain Docker Hub token");
    }

    const data = await res.json();
    return `Bearer ${data.token}`;
  }

  private async fetchWithTimeout(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/image-inspect.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/services/image-inspect.ts server/src/__tests__/image-inspect.test.ts
git commit -m "feat: add ImageInspectService for registry-based port detection"
```

---

### Task 2: Images API Route

**Files:**
- Create: `server/src/routes/images.ts`
- Modify: `server/src/app.ts:149-208`
- Create: `server/src/__tests__/images-api.test.ts`

- [ ] **Step 1: Write the failing test**

Create `server/src/__tests__/images-api.test.ts`:

```typescript
import request from "supertest";

// Mock logger factory first
vi.mock("../lib/logger-factory", () => {
  const mockLoggerInstance = {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(function () { return mockLoggerInstance; }),
    level: "info",
    levels: { values: { fatal: 60, error: 50, warn: 40, info: 30, debug: 20, trace: 10 } },
    silent: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  };
  return {
    createLogger: vi.fn(() => mockLoggerInstance),
    appLogger: vi.fn(() => mockLoggerInstance),
    servicesLogger: vi.fn(() => mockLoggerInstance),
    httpLogger: vi.fn(() => mockLoggerInstance),
    prismaLogger: vi.fn(() => mockLoggerInstance),
    loadbalancerLogger: vi.fn(() => mockLoggerInstance),
    deploymentLogger: vi.fn(() => mockLoggerInstance),
    dockerExecutorLogger: vi.fn(() => mockLoggerInstance),
    tlsLogger: vi.fn(() => mockLoggerInstance),
    agentLogger: vi.fn(() => mockLoggerInstance),
    default: vi.fn(() => mockLoggerInstance),
  };
});

vi.mock("../middleware/auth", () => ({
  requireSessionOrApiKey: (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  requirePermission: () => (req: any, res: any, next: any) => {
    req.user = { id: "test-user-id" };
    next();
  },
  getCurrentUserId: (req: any) => "test-user-id",
  requireAuth: (req: any, res: any, next: any) => next(),
  getAuthenticatedUser: (req: any) => ({ id: "test-user-id" }),
}));

// Mock ImageInspectService
const mockGetExposedPorts = vi.fn();
vi.mock("../services/image-inspect", () => ({
  ImageInspectService: vi.fn().mockImplementation(() => ({
    getExposedPorts: mockGetExposedPorts,
  })),
}));

// Mock RegistryCredentialService
vi.mock("../services/registry-credential", () => ({
  RegistryCredentialService: vi.fn().mockImplementation(() => ({
    getCredentialsForImage: vi.fn().mockResolvedValue(null),
  })),
}));

// Mock prisma
vi.mock("../lib/prisma", () => ({
  default: {},
  PrismaClient: vi.fn(),
}));

// Mock self-backup services
vi.mock("../services/backup/self-backup-executor", () => ({
  SelfBackupExecutor: vi.fn(),
}));
vi.mock("../services/backup/self-backup-scheduler", () => ({
  SelfBackupScheduler: vi.fn(),
}));

import app from "../app";

describe("GET /api/images/inspect-ports", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns ports for a valid image", async () => {
    mockGetExposedPorts.mockResolvedValue([80, 443]);

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "nginx", tag: "latest" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ports: [80, 443] });
  });

  it("returns 400 when image is missing", async () => {
    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ tag: "latest" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 400 when tag is missing", async () => {
    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "nginx" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it("returns 404 when image not found", async () => {
    mockGetExposedPorts.mockRejectedValue(new Error("Image not found"));

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "nonexistent/image", tag: "latest" });

    expect(res.status).toBe(404);
  });

  it("returns 502 when auth fails", async () => {
    mockGetExposedPorts.mockRejectedValue(new Error("Authentication failed"));

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "private/image", tag: "latest" });

    expect(res.status).toBe(502);
  });

  it("returns empty ports array when image has no EXPOSE", async () => {
    mockGetExposedPorts.mockResolvedValue([]);

    const res = await request(app)
      .get("/api/images/inspect-ports")
      .query({ image: "alpine", tag: "latest" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, ports: [] });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx -w server vitest run src/__tests__/images-api.test.ts`
Expected: FAIL — route not registered, 404 responses

- [ ] **Step 3: Create the route**

Create `server/src/routes/images.ts`:

```typescript
import express from "express";
import type { RequestHandler } from "express";
import { requirePermission } from "../middleware/auth";
import { ImageInspectService } from "../services/image-inspect";
import { RegistryCredentialService } from "../services/registry-credential";
import { appLogger } from "../lib/logger-factory";
import prisma from "../lib/prisma";

const logger = appLogger();
const router = express.Router();
const registryCredentialService = new RegistryCredentialService(prisma);

// GET /api/images/inspect-ports?image=nginx&tag=latest
router.get(
  "/inspect-ports",
  requirePermission("containers:read") as RequestHandler,
  async (req, res) => {
    const image = req.query.image as string | undefined;
    const tag = req.query.tag as string | undefined;

    if (!image || !tag) {
      return res.status(400).json({
        success: false,
        error: "Both 'image' and 'tag' query parameters are required",
      });
    }

    try {
      const credentials =
        await registryCredentialService.getCredentialsForImage(image);
      const inspectService = new ImageInspectService(credentials);
      const ports = await inspectService.getExposedPorts(image, tag);

      res.json({ success: true, ports });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unknown error";

      logger.error({ error: message, image, tag }, "Failed to inspect image ports");

      if (message.includes("not found")) {
        return res.status(404).json({ success: false, error: message });
      }
      if (message.includes("Authentication")) {
        return res.status(502).json({ success: false, error: message });
      }
      res.status(502).json({ success: false, error: "Failed to inspect image" });
    }
  },
);

export default router;
```

- [ ] **Step 4: Register the route in app.ts**

In `server/src/app.ts`, add the import after line 153 (after the `dnsRoutes` import):

```typescript
import imagesRoutes from "./routes/images";
```

Add the route entry in the `routes` array, before the closing `]` at line 209:

```typescript
  { path: "/api/images", router: imagesRoutes, name: "imagesRoutes" },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx -w server vitest run src/__tests__/images-api.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/images.ts server/src/__tests__/images-api.test.ts server/src/app.ts
git commit -m "feat: add GET /api/images/inspect-ports endpoint"
```

---

### Task 3: Frontend Hook

**Files:**
- Create: `client/src/hooks/use-detect-image-ports.ts`

- [ ] **Step 1: Create the hook**

Create `client/src/hooks/use-detect-image-ports.ts`:

```typescript
import { useMutation } from "@tanstack/react-query";

interface DetectPortsParams {
  image: string;
  tag: string;
}

interface DetectPortsResponse {
  success: boolean;
  ports: number[];
  error?: string;
}

async function detectImagePorts({ image, tag }: DetectPortsParams): Promise<number[]> {
  const url = new URL("/api/images/inspect-ports", window.location.origin);
  url.searchParams.set("image", image);
  url.searchParams.set("tag", tag);

  const res = await fetch(url.toString(), {
    credentials: "include",
  });

  const data: DetectPortsResponse = await res.json();

  if (!res.ok || !data.success) {
    throw new Error(data.error ?? "Failed to detect ports");
  }

  return data.ports;
}

export function useDetectImagePorts() {
  return useMutation({
    mutationFn: detectImagePorts,
  });
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Build succeeds (hook is created but not yet imported anywhere)

- [ ] **Step 3: Commit**

```bash
git add client/src/hooks/use-detect-image-ports.ts
git commit -m "feat: add useDetectImagePorts hook"
```

---

### Task 4: Wire Up the Form — Detect Button and Listening Port Dropdown

**Files:**
- Modify: `client/src/app/applications/new/page.tsx`

- [ ] **Step 1: Add imports and state**

At the top of `page.tsx`, add to the existing imports:

```typescript
import { useState } from "react";
```

Update the `react` import line to include `useState` alongside `useEffect`.

Add the hook import:

```typescript
import { useDetectImagePorts } from "@/hooks/use-detect-image-ports";
```

Add the `toast` import:

```typescript
import { toast } from "sonner";
```

- [ ] **Step 2: Add state and mutation inside the component**

Inside `NewApplicationPage()`, after the `useEnvironments()` call, add:

```typescript
const detectPorts = useDetectImagePorts();
const [detectedPorts, setDetectedPorts] = useState<number[]>([]);
const [useCustomPort, setUseCustomPort] = useState(false);
```

- [ ] **Step 3: Add the detect handler**

After the `useEffect` block (around line 165), add:

```typescript
const handleDetectPorts = async () => {
  const image = form.getValues("dockerImage");
  const tag = form.getValues("dockerTag");
  if (!image || !tag) return;

  try {
    const ports = await detectPorts.mutateAsync({ image, tag });
    setDetectedPorts(ports);
    setUseCustomPort(false);
    if (ports.length === 1) {
      form.setValue("routing.listeningPort", ports[0]);
    } else if (ports.length > 1) {
      form.setValue("routing.listeningPort", ports[0]);
    } else {
      toast.info("No exposed ports found in this image");
    }
  } catch {
    toast.error("Couldn't detect ports — you can set the port manually");
  }
};
```

- [ ] **Step 4: Add reset effect for detected ports**

After the detect handler, add:

```typescript
const dockerImage = form.watch("dockerImage");
const dockerTag = form.watch("dockerTag");

useEffect(() => {
  setDetectedPorts([]);
  setUseCustomPort(false);
}, [dockerImage, dockerTag]);
```

- [ ] **Step 5: Add the Detect Ports button**

In the Container Configuration card, after the closing `</div>` of the image/tag grid (after the two `FormField` components for `dockerImage` and `dockerTag`), add:

```tsx
<Button
  type="button"
  variant="outline"
  size="sm"
  disabled={!form.watch("dockerImage") || !form.watch("dockerTag") || detectPorts.isPending}
  onClick={handleDetectPorts}
>
  {detectPorts.isPending ? (
    <IconLoader2 className="h-4 w-4 mr-1 animate-spin" />
  ) : null}
  Detect Ports
</Button>
```

- [ ] **Step 6: Replace the listening port field with conditional Input/Select**

In the Routing card, replace the existing `routing.listeningPort` FormField with:

```tsx
<FormField
  control={form.control}
  name="routing.listeningPort"
  render={({ field }) => (
    <FormItem>
      <FormLabel>Listening Port</FormLabel>
      <FormControl>
        {detectedPorts.length >= 2 && !useCustomPort ? (
          <Select
            value={String(field.value)}
            onValueChange={(val) => {
              if (val === "custom") {
                setUseCustomPort(true);
              } else {
                field.onChange(Number(val));
              }
            }}
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {detectedPorts.map((port) => (
                <SelectItem key={port} value={String(port)}>
                  {port}
                </SelectItem>
              ))}
              <SelectItem value="custom">Custom...</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input
            type="number"
            placeholder="80"
            value={field.value || ""}
            onChange={(e) =>
              field.onChange(
                e.target.value ? Number(e.target.value) : 0,
              )
            }
          />
        )}
      </FormControl>
      <FormDescription>
        The port your application listens on inside the
        container.
      </FormDescription>
      <FormMessage />
    </FormItem>
  )}
/>
```

- [ ] **Step 7: Build and verify**

Run: `npm run build -w client 2>&1 | tail -5`
Expected: Build succeeds with no type errors

- [ ] **Step 8: Commit**

```bash
git add client/src/app/applications/new/page.tsx
git commit -m "feat: add Detect Ports button and dropdown to application form"
```

---

### Task 5: Build Verification and Push

**Files:** None (verification only)

- [ ] **Step 1: Run server tests**

Run: `npx -w server vitest run src/__tests__/image-inspect.test.ts src/__tests__/images-api.test.ts`
Expected: All tests PASS

- [ ] **Step 2: Run full client build**

Run: `npm run build -w client 2>&1 | tail -10`
Expected: Build succeeds

- [ ] **Step 3: Push to remote**

```bash
git push
```
