import { describe, it, expect, beforeEach } from "vitest";
import type { PrismaClient } from "../../../generated/prisma/client";
import type { DockerExecutorService } from "../../docker-executor";
import {
  jobPoolRuntimeEnvResolvers,
  __clearJobPoolRuntimeEnvResolversForTests,
  type JobPoolRuntimeEnvResolver,
} from "../job-pool-runtime-env-resolver";

describe("JobPoolRuntimeEnvResolverRegistry (Phase 4, MINI-53)", () => {
  beforeEach(() => {
    __clearJobPoolRuntimeEnvResolversForTests();
  });

  const mkResolver = (label: string): JobPoolRuntimeEnvResolver =>
    async () => ({ env: { LABEL: label } });

  it("returns undefined when no resolver is registered", () => {
    expect(jobPoolRuntimeEnvResolvers.getResolver("stack-1", "service-a")).toBeUndefined();
  });

  it("returns the exact-match resolver before the wildcard", () => {
    jobPoolRuntimeEnvResolvers.register("*", "service-a", mkResolver("wildcard"));
    jobPoolRuntimeEnvResolvers.register("stack-1", "service-a", mkResolver("exact"));

    const resolver = jobPoolRuntimeEnvResolvers.getResolver("stack-1", "service-a");
    expect(resolver).toBeDefined();
    return resolver!({} as PrismaClient, {} as DockerExecutorService, {
      stackId: "stack-1",
      serviceName: "service-a",
      trigger: { kind: "manual", name: "test" },
    }).then((result) => {
      expect(result.env).toEqual({ LABEL: "exact" });
    });
  });

  it("falls back to the wildcard resolver when no exact match exists", () => {
    jobPoolRuntimeEnvResolvers.register("*", "service-a", mkResolver("wildcard"));

    const resolver = jobPoolRuntimeEnvResolvers.getResolver("stack-99", "service-a");
    expect(resolver).toBeDefined();
    return resolver!({} as PrismaClient, {} as DockerExecutorService, {
      stackId: "stack-99",
      serviceName: "service-a",
      trigger: { kind: "manual", name: "test" },
    }).then((result) => {
      expect(result.env).toEqual({ LABEL: "wildcard" });
    });
  });

  it("returns undefined when service name doesn't match a wildcard entry", () => {
    jobPoolRuntimeEnvResolvers.register("*", "service-a", mkResolver("wildcard"));
    expect(jobPoolRuntimeEnvResolvers.getResolver("stack-1", "service-b")).toBeUndefined();
  });

  it("unregister removes a specific (stackId, serviceName) entry", () => {
    jobPoolRuntimeEnvResolvers.register("stack-1", "service-a", mkResolver("exact"));
    expect(jobPoolRuntimeEnvResolvers.getResolver("stack-1", "service-a")).toBeDefined();
    jobPoolRuntimeEnvResolvers.unregister("stack-1", "service-a");
    expect(jobPoolRuntimeEnvResolvers.getResolver("stack-1", "service-a")).toBeUndefined();
  });

  it("replacing a resolver for the same slot logs and overwrites", () => {
    jobPoolRuntimeEnvResolvers.register("*", "service-a", mkResolver("first"));
    jobPoolRuntimeEnvResolvers.register("*", "service-a", mkResolver("second"));
    const resolver = jobPoolRuntimeEnvResolvers.getResolver("stack-x", "service-a");
    return resolver!({} as PrismaClient, {} as DockerExecutorService, {
      stackId: "stack-x",
      serviceName: "service-a",
      trigger: { kind: "manual", name: "test" },
    }).then((result) => {
      expect(result.env).toEqual({ LABEL: "second" });
    });
  });
});
