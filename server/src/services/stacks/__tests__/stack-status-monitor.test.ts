import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import pino from "pino";
import type { DockerContainerInfo } from "@mini-infra/types";
import { StackStatusMonitor } from "../stack-status-monitor";
import { stackOperationLock } from "../operation-lock";
import { STACK_ID_LABEL, SERVICE_LABEL, DEFINITION_HASH_LABEL } from "../stack-runtime-check";

const emitStackStatusChanged = vi.hoisted(() => vi.fn());
vi.mock("../stack-socket-emitter", () => ({ emitStackStatusChanged }));

const log = pino({ level: "silent" });

function container(service: string, hash: string, status = "running"): DockerContainerInfo {
  return {
    id: `c-${service}`,
    name: `stk-${service}`,
    status: status as DockerContainerInfo["status"],
    image: "nginx",
    imageTag: "latest",
    ports: [],
    volumes: [],
    createdAt: new Date(0),
    labels: {
      [STACK_ID_LABEL]: "s1",
      [SERVICE_LABEL]: service,
      [DEFINITION_HASH_LABEL]: hash,
    },
  };
}

/** A stack row as the monitor selects it. */
function stackRow(status: string) {
  return {
    id: "s1",
    name: "my-app",
    status,
    lastAppliedHashes: { api: "sha256:aaa" },
  };
}

function buildHarness(opts: { stack: ReturnType<typeof stackRow>; containers: DockerContainerInfo[] }) {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    stack: {
      findMany: vi.fn().mockResolvedValue([opts.stack]),
      findUnique: vi.fn().mockResolvedValue({ ...opts.stack, runtimeIssues: null }),
      update,
    },
  };
  const docker = {
    isConnected: () => true,
    listContainers: vi.fn().mockResolvedValue(opts.containers),
    onContainerEvent: vi.fn(),
  };

  const monitor = new StackStatusMonitor(
    prisma as unknown as ConstructorParameters<typeof StackStatusMonitor>[0],
    docker as unknown as ConstructorParameters<typeof StackStatusMonitor>[1],
    log,
  );
  return { monitor, update, prisma, docker };
}

describe("StackStatusMonitor", () => {
  beforeEach(() => {
    emitStackStatusChanged.mockClear();
    stackOperationLock.release("s1");
  });

  afterEach(() => {
    stackOperationLock.release("s1");
  });

  it("flips synced -> drifted when a service has died", async () => {
    const { monitor, update } = buildHarness({
      stack: stackRow("synced"),
      containers: [container("api", "sha256:aaa", "exited")],
    });

    await monitor.sweep();

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "s1" },
        data: expect.objectContaining({ status: "drifted" }),
      }),
    );
    expect(emitStackStatusChanged).toHaveBeenCalledWith("s1", "drifted");
  });

  it("flips drifted -> synced when the service comes back on its own", async () => {
    // Docker restart policies bring crashed containers back. The monitor must be
    // symmetric or a transient crash would pin the stack at `drifted` forever.
    const { monitor, update } = buildHarness({
      stack: stackRow("drifted"),
      containers: [container("api", "sha256:aaa", "running")],
    });

    await monitor.sweep();

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: "synced" }) }),
    );
    expect(emitStackStatusChanged).toHaveBeenCalledWith("s1", "synced");
  });

  it("persists WHY the stack drifted so the API can say so without a Docker call", async () => {
    const { monitor, update } = buildHarness({
      stack: stackRow("synced"),
      containers: [container("api", "sha256:aaa", "exited")],
    });

    await monitor.sweep();

    const data = update.mock.calls[0][0].data;
    expect(data.runtimeIssues).toEqual([
      { kind: "not-running", serviceName: "api", status: "exited" },
    ]);
  });

  it("does not touch a stack whose last apply failed", async () => {
    // `error` is a recoverable state a human action owns. The monitor must never
    // clobber it — nor `pending` (unapplied edits) or `undeployed`.
    for (const status of ["error", "pending", "undeployed"]) {
      const { monitor, update } = buildHarness({
        stack: stackRow(status),
        containers: [container("api", "sha256:aaa", "exited")],
      });

      await monitor.sweep();
      expect(update, `status ${status} must be left alone`).not.toHaveBeenCalled();
    }
  });

  it("does not write a status underneath a live operation", async () => {
    // An apply legitimately stops and recreates containers, which looks exactly
    // like a service dying. Writing `drifted` mid-apply would be a lie that
    // races the apply's own status write.
    const { monitor, update } = buildHarness({
      stack: stackRow("synced"),
      containers: [container("api", "sha256:aaa", "exited")],
    });

    expect(stackOperationLock.tryAcquire("s1")).toBe(true);
    try {
      await monitor.sweep();
      expect(update).not.toHaveBeenCalled();
    } finally {
      stackOperationLock.release("s1");
    }
  });

  it("releases the operation lock after writing", async () => {
    const { monitor } = buildHarness({
      stack: stackRow("synced"),
      containers: [container("api", "sha256:aaa", "exited")],
    });

    await monitor.sweep();

    // If the monitor leaked the lock, every subsequent apply/destroy on this
    // stack would 409 until the 30-minute TTL expired.
    expect(stackOperationLock.has("s1")).toBe(false);
  });

  it("holds no opinion on a stack with no stored hashes", async () => {
    const { monitor, update } = buildHarness({
      stack: { ...stackRow("synced"), lastAppliedHashes: null },
      containers: [],
    });

    await monitor.sweep();

    expect(update).not.toHaveBeenCalled();
  });

  it("leaves a healthy synced stack alone", async () => {
    const { monitor, update } = buildHarness({
      stack: stackRow("synced"),
      containers: [container("api", "sha256:aaa", "running")],
    });

    await monitor.sweep();

    expect(update).not.toHaveBeenCalled();
    expect(emitStackStatusChanged).not.toHaveBeenCalled();
  });

  it("never throws out of a sweep tick", async () => {
    const { monitor, docker } = buildHarness({
      stack: stackRow("synced"),
      containers: [],
    });
    docker.listContainers.mockRejectedValue(new Error("docker is down"));

    // A throwing timer callback would take the process down.
    await expect(monitor.sweep()).resolves.toBeUndefined();
  });

  it("subscribes to Docker container events on start", () => {
    const { monitor, docker } = buildHarness({
      stack: stackRow("synced"),
      containers: [],
    });

    monitor.start();
    try {
      expect(docker.onContainerEvent).toHaveBeenCalledOnce();
      expect(monitor.isRunning()).toBe(true);
    } finally {
      monitor.stop();
    }
    expect(monitor.isRunning()).toBe(false);
  });
});
