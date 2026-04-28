import { describe, it, expect } from "vitest";
import express from "express";
import type { Application } from "express";
import { createAdminApp } from "../admin";

// ---------------------------------------------------------------------------
// In-process HTTP test helper using Node's http.request
// ---------------------------------------------------------------------------

async function startTestServer(app: Application): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Unexpected server address"));
        return;
      }
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        baseUrl,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
    server.on("error", reject);
  });
}

async function req(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
  contentType = "application/json",
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, baseUrl);
  const headers: Record<string, string> = {};
  let bodyStr: string | undefined;

  if (body !== undefined) {
    bodyStr = JSON.stringify(body);
    headers["Content-Type"] = contentType;
    headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
  }

  const http = await import("http");
  return new Promise((resolve, reject) => {
    const reqObj = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method,
        headers,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: data });
          }
        });
      },
    );
    reqObj.on("error", reject);
    if (bodyStr) reqObj.write(bodyStr);
    reqObj.end();
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /admin/rules", () => {
  it("returns 200 with valid payload", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "POST", "/admin/rules", {
        version: 1,
        stackPolicies: {
          "stack-a": {
            mode: "enforce",
            defaultAction: "block",
            rules: [
              {
                id: "rule-1",
                pattern: "api.openai.com",
                action: "allow",
                targets: [],
              },
            ],
          },
        },
      });

      expect(status).toBe(200);
      const b = body as Record<string, unknown>;
      expect(b.accepted).toBe(true);
      expect(b.version).toBe(1);
      expect(b.stackCount).toBe(1);
      expect(b.ruleCount).toBe(1);
    } finally {
      await close();
    }
  });

  it("accepts payload with defaultUpstream override", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "POST", "/admin/rules", {
        version: 2,
        defaultUpstream: ["9.9.9.9"],
        stackPolicies: {},
      });

      expect(status).toBe(200);
      expect((body as Record<string, unknown>).accepted).toBe(true);
    } finally {
      await close();
    }
  });

  it("returns 400 when version is missing", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "POST", "/admin/rules", {
        stackPolicies: {},
      });

      expect(status).toBe(400);
      expect((body as Record<string, unknown>).error).toMatch(/version/i);
    } finally {
      await close();
    }
  });

  it("returns 400 when stackPolicies is missing", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "POST", "/admin/rules", {
        version: 1,
      });

      expect(status).toBe(400);
      expect((body as Record<string, unknown>).error).toMatch(/stackPolicies/i);
    } finally {
      await close();
    }
  });

  it("returns 400 when a rule has an extra field", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "POST", "/admin/rules", {
        version: 1,
        stackPolicies: {
          "stack-a": {
            mode: "enforce",
            defaultAction: "block",
            rules: [
              {
                id: "r1",
                pattern: "foo.com",
                action: "allow",
                targets: [],
                extraField: "not allowed",
              },
            ],
          },
        },
      });

      expect(status).toBe(400);
      expect((body as Record<string, unknown>).error).toMatch(/extraField/);
    } finally {
      await close();
    }
  });

  it("returns 400 when policy mode is invalid", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status } = await req(baseUrl, "POST", "/admin/rules", {
        version: 1,
        stackPolicies: {
          "stack-a": {
            mode: "invalid-mode",
            defaultAction: "block",
            rules: [],
          },
        },
      });

      expect(status).toBe(400);
    } finally {
      await close();
    }
  });

  it("returns 415 when Content-Type is not application/json", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status } = await req(
        baseUrl,
        "POST",
        "/admin/rules",
        { version: 1, stackPolicies: {} },
        "text/plain",
      );

      expect(status).toBe(415);
    } finally {
      await close();
    }
  });

  it("returns 400 when top-level has unexpected fields", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "POST", "/admin/rules", {
        version: 1,
        stackPolicies: {},
        unexpectedTopLevel: true,
      });

      expect(status).toBe(400);
      expect((body as Record<string, unknown>).error).toMatch(
        /unexpectedTopLevel/,
      );
    } finally {
      await close();
    }
  });
});

describe("POST /admin/container-map", () => {
  it("returns 200 with valid payload", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(
        baseUrl,
        "POST",
        "/admin/container-map",
        {
          version: 1,
          entries: [
            { ip: "172.30.0.10", stackId: "stack-a", serviceName: "web" },
            {
              ip: "172.30.0.11",
              stackId: "stack-a",
              serviceName: "worker",
              containerId: "abc123",
            },
          ],
        },
      );

      expect(status).toBe(200);
      const b = body as Record<string, unknown>;
      expect(b.accepted).toBe(true);
      expect(b.version).toBe(1);
      expect(b.entryCount).toBe(2);
    } finally {
      await close();
    }
  });

  it("accepts empty entries array", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(
        baseUrl,
        "POST",
        "/admin/container-map",
        { version: 5, entries: [] },
      );

      expect(status).toBe(200);
      expect((body as Record<string, unknown>).entryCount).toBe(0);
    } finally {
      await close();
    }
  });

  it("returns 400 when version is missing", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status } = await req(
        baseUrl,
        "POST",
        "/admin/container-map",
        { entries: [] },
      );
      expect(status).toBe(400);
    } finally {
      await close();
    }
  });

  it("returns 400 when entries is missing", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status } = await req(
        baseUrl,
        "POST",
        "/admin/container-map",
        { version: 1 },
      );
      expect(status).toBe(400);
    } finally {
      await close();
    }
  });

  it("returns 400 when entry has extra field", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status } = await req(
        baseUrl,
        "POST",
        "/admin/container-map",
        {
          version: 1,
          entries: [
            {
              ip: "10.0.0.1",
              stackId: "s1",
              serviceName: "web",
              extraField: "nope",
            },
          ],
        },
      );
      expect(status).toBe(400);
    } finally {
      await close();
    }
  });

  it("returns 415 when Content-Type is not application/json", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status } = await req(
        baseUrl,
        "POST",
        "/admin/container-map",
        { version: 1, entries: [] },
        "text/xml",
      );
      expect(status).toBe(415);
    } finally {
      await close();
    }
  });

  it("filters out non-IPv4 entries but still returns 200", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(
        baseUrl,
        "POST",
        "/admin/container-map",
        {
          version: 1,
          entries: [
            { ip: "172.30.0.10", stackId: "s1", serviceName: "web" },
            {
              ip: "::1",
              stackId: "s1",
              serviceName: "ipv6-svc",
            },
          ],
        },
      );
      expect(status).toBe(200);
      // Only the IPv4 entry was stored.
      expect((body as Record<string, unknown>).entryCount).toBe(1);
    } finally {
      await close();
    }
  });
});

describe("GET /admin/health", () => {
  it("returns 200 with expected shape", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "GET", "/admin/health");

      expect(status).toBe(200);
      const b = body as Record<string, unknown>;
      expect(b.ok).toBe(true);
      expect(typeof b.rulesVersion).toBe("number");
      expect(typeof b.containerMapVersion).toBe("number");
      expect(typeof b.uptimeSeconds).toBe("number");

      const upstream = b.upstream as Record<string, unknown>;
      expect(Array.isArray(upstream.servers)).toBe(true);
      // lastSuccessAt and lastFailureAt may be null
      expect(
        upstream.lastSuccessAt === null ||
          typeof upstream.lastSuccessAt === "string",
      ).toBe(true);
      expect(
        upstream.lastFailureAt === null ||
          typeof upstream.lastFailureAt === "string",
      ).toBe(true);
    } finally {
      await close();
    }
  });
});

describe("GET /admin/stats", () => {
  it("returns 200 with expected shape", async () => {
    const app = createAdminApp();
    const { baseUrl, close } = await startTestServer(app);
    try {
      const { status, body } = await req(baseUrl, "GET", "/admin/stats");

      expect(status).toBe(200);
      const b = body as Record<string, unknown>;
      expect(typeof b.queriesTotal).toBe("number");
      const byAction = b.queriesByAction as Record<string, unknown>;
      expect(typeof byAction.allowed).toBe("number");
      expect(typeof byAction.blocked).toBe("number");
      expect(typeof byAction.observed).toBe("number");
      expect(typeof b.queriesByQType).toBe("object");
      expect(typeof b.uniqueSourcesSeen).toBe("number");
      expect(typeof b.upstreamErrors).toBe("number");
      expect(typeof b.startedAt).toBe("string");
    } finally {
      await close();
    }
  });
});
