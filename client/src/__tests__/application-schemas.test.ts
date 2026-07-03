import { describe, it, expect } from "vitest";
import {
  createApplicationFormSchema,
  createApplicationDefaults,
  type CreateApplicationFormData,
} from "@/lib/application-schemas";

function baseStateful(
  overrides: Partial<CreateApplicationFormData> = {},
): CreateApplicationFormData {
  return {
    ...createApplicationDefaults,
    displayName: "My App",
    environmentId: "env-1",
    serviceType: "Stateful",
    serviceName: "stateful",
    dockerImage: "redis",
    dockerTag: "alpine",
    // A Stateful service isn't routed, but the form keeps the default routing
    // object around with an empty hostname — this must NOT block validation.
    enableRouting: false,
    routing: { hostname: "", listeningPort: 6379 },
    ...overrides,
  };
}

describe("createApplicationFormSchema — routing gating", () => {
  it("accepts a Stateful app with routing disabled and an empty leftover hostname (regression: was a silent submit block)", () => {
    const result = createApplicationFormSchema.safeParse(baseStateful());
    expect(result.success).toBe(true);
  });

  it("rejects a routed app with an empty hostname, on routing.hostname", () => {
    const result = createApplicationFormSchema.safeParse(
      baseStateful({
        serviceType: "StatelessWeb",
        serviceName: "web",
        enableRouting: true,
        routing: { hostname: "", listeningPort: 8080 },
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      const paths = result.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("routing.hostname");
    }
  });

  it("accepts a routed app once a hostname is provided", () => {
    const result = createApplicationFormSchema.safeParse(
      baseStateful({
        serviceType: "StatelessWeb",
        serviceName: "web",
        enableRouting: true,
        routing: { hostname: "app.example.com", listeningPort: 8080 },
      }),
    );
    expect(result.success).toBe(true);
  });
});

describe("createApplicationFormSchema — linkedContainers", () => {
  it("accepts a link with a network name (containerName optional)", () => {
    const result = createApplicationFormSchema.safeParse(
      baseStateful({
        linkedContainers: [
          { containerName: "some-postgres", networkName: "local-database" },
          { networkName: "local-database-2" },
        ],
      }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects a link with an empty network name", () => {
    const result = createApplicationFormSchema.safeParse(
      baseStateful({
        linkedContainers: [{ containerName: "some-postgres", networkName: "" }],
      }),
    );
    expect(result.success).toBe(false);
  });
});
