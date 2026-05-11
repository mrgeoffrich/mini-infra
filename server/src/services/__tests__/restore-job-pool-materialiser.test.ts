import { describe, it, expect } from "vitest";
import {
  RESTORE_EXECUTOR_SERVICE_NAME,
  RESTORE_EXECUTOR_TEMPLATE_NAME,
  installRestoreRuntimeEnvResolver,
  __resetInstalledForTests,
} from "../restore-executor/restore-job-pool-materialiser";
import {
  jobPoolRuntimeEnvResolvers,
  __clearJobPoolRuntimeEnvResolversForTests,
} from "../stacks/job-pool-runtime-env-resolver";

describe("restore-job-pool-materialiser (Phase 5, MINI-54)", () => {
  it("exports the canonical template/service name constants", () => {
    expect(RESTORE_EXECUTOR_SERVICE_NAME).toBe("restore-executor");
    expect(RESTORE_EXECUTOR_TEMPLATE_NAME).toBe("restore-executor");
  });

  it("installRestoreRuntimeEnvResolver registers a wildcard resolver", () => {
    __clearJobPoolRuntimeEnvResolversForTests();
    __resetInstalledForTests();

    expect(
      jobPoolRuntimeEnvResolvers.getResolver("any-stack-id", RESTORE_EXECUTOR_SERVICE_NAME),
    ).toBeUndefined();

    installRestoreRuntimeEnvResolver();

    // Wildcard hit — any stackId resolves to the same registered resolver.
    expect(
      jobPoolRuntimeEnvResolvers.getResolver("stack-a", RESTORE_EXECUTOR_SERVICE_NAME),
    ).toBeDefined();
    expect(
      jobPoolRuntimeEnvResolvers.getResolver("stack-b", RESTORE_EXECUTOR_SERVICE_NAME),
    ).toBeDefined();

    // Different service name doesn't hit the restore resolver.
    expect(
      jobPoolRuntimeEnvResolvers.getResolver("stack-a", "pg-az-backup"),
    ).toBeUndefined();
  });

  it("install is idempotent — second call doesn't re-register", () => {
    __clearJobPoolRuntimeEnvResolversForTests();
    __resetInstalledForTests();

    installRestoreRuntimeEnvResolver();
    const sizeAfterFirst = jobPoolRuntimeEnvResolvers.size();
    installRestoreRuntimeEnvResolver();
    const sizeAfterSecond = jobPoolRuntimeEnvResolvers.size();

    expect(sizeAfterSecond).toBe(sizeAfterFirst);
  });
});
