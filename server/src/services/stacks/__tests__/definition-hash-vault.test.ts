import { describe, it, expect } from "vitest";
import { computeDefinitionHash } from "../definition-hash";
import type { StackServiceDefinition } from "@mini-infra/types";

/**
 * Phase 3 invariant: dynamic env values must NOT contribute to the service
 * definition hash. Otherwise every re-apply would mint a new wrapped secret_id
 * and trigger a spurious recreate.
 */
describe("definition-hash with dynamicEnv", () => {
  const baseService: StackServiceDefinition = {
    serviceName: "app",
    serviceType: "Stateful",
    dockerImage: "nginx",
    dockerTag: "latest",
    dependsOn: [],
    order: 1,
    containerConfig: {
      env: { FOO: "bar" },
      restartPolicy: "unless-stopped",
    },
  };

  it("same hash whether dynamicEnv is absent or populated", () => {
    const withoutDynamic = computeDefinitionHash(baseService);
    const withDynamic = computeDefinitionHash({
      ...baseService,
      containerConfig: {
        ...baseService.containerConfig,
        dynamicEnv: {
          VAULT_ADDR: { kind: "vault-addr" },
          VAULT_WRAPPED_SECRET_ID: {
            kind: "vault-wrapped-secret-id",
            ttlSeconds: 300,
          },
        },
      },
    });
    expect(withoutDynamic).toBe(withDynamic);
  });

  it("different static env still changes the hash", () => {
    const a = computeDefinitionHash(baseService);
    const b = computeDefinitionHash({
      ...baseService,
      containerConfig: { ...baseService.containerConfig, env: { FOO: "baz" } },
    });
    expect(a).not.toBe(b);
  });

  it("different image tag changes the hash", () => {
    const a = computeDefinitionHash(baseService);
    const b = computeDefinitionHash({ ...baseService, dockerTag: "1.25" });
    expect(a).not.toBe(b);
  });
});
