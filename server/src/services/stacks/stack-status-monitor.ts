/**
 * Background stack-status monitor — makes `synced` stop lying.
 *
 * Two holes this closes:
 *
 *  - **A service that starts and then dies** left the stack `synced` with zero
 *    running containers. The apply path only watches a container for ~5s after
 *    start (`observeStableRunning`), so anything that crashes later is invisible
 *    and the badge cheerfully says everything is fine while the app is down.
 *
 *  - **Drift was on-demand only.** `drifted` was persisted exclusively when a
 *    human opened the plan view, so a stack whose container was replaced or
 *    edited out of band could read `synced` for weeks.
 *
 * Both are the same question — *has reality drifted from what we applied?* — so
 * both are answered by the same cheap check (see stack-runtime-check.ts), driven
 * from two sources:
 *
 *  - **Docker events** give the immediate signal. `die`/`destroy`/`stop`/`start`
 *    on any container carrying `mini-infra.stack-id` schedules a re-check of
 *    that stack, debounced so a burst (e.g. a compose restart) collapses into
 *    one pass.
 *
 *  - **A periodic sweep** is the backstop. The Docker event stream has no
 *    `end`/`close` recovery — `docker.ts` only logs on `error` — so it can go
 *    silently deaf and every subscriber with it. An event-only design would
 *    inherit that failure mode, so the timer re-checks the fleet regardless.
 *    It is also what catches drift that produces no event at all.
 *
 * Status transitions are deliberately narrow, mirroring the rule the plan route
 * already established (stacks-validation-routes.ts): only `synced` → `drifted`
 * and `drifted` → `synced`. It never touches `error`, `pending`, `undeployed` or
 * `removed` — a stack whose last apply failed stays in its recoverable error
 * state, and a stack with unapplied edits stays `pending`. That keeps the
 * monitor from ever clobbering a status that a human action owns.
 */
import type { Logger } from "pino";
import { Prisma, type PrismaClient } from "../../generated/prisma/client";
import type DockerService from "../docker";
import type { DockerContainerEvent } from "../../lib/docker-event-pattern-detector";
import { withOperation } from "../../lib/logging-context";
import { emitStackStatusChanged } from "./stack-socket-emitter";
import { stackOperationLock } from "./operation-lock";
import {
  checkStackRuntime,
  groupContainersByStack,
  describeRuntimeIssues,
  STACK_ID_LABEL,
  type RuntimeIssue,
} from "./stack-runtime-check";

/** Container events worth a re-check. `create`/`health_status` add noise without signal. */
const WATCHED_ACTIONS = new Set(["die", "stop", "destroy", "start", "kill", "oom"]);

/** Collapse a burst of events for one stack into a single check. */
const EVENT_DEBOUNCE_MS = 2_000;

/** How often the backstop sweep runs. Cheap: one listContainers for the fleet. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000;

/** Only these statuses are the monitor's to change. */
const MONITORED_STATUSES = ["synced", "drifted"] as const;

export interface StackStatusMonitorOptions {
  sweepIntervalMs?: number;
}

export class StackStatusMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly pendingChecks = new Map<string, NodeJS.Timeout>();
  private readonly sweepIntervalMs: number;
  private running = false;

  constructor(
    private readonly prisma: PrismaClient,
    private readonly docker: DockerService,
    private readonly log: Logger,
    options: StackStatusMonitorOptions = {},
  ) {
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  }

  start(): void {
    if (this.running) {
      this.log.warn("stack status monitor already running");
      return;
    }
    this.running = true;

    this.docker.onContainerEvent((event: DockerContainerEvent) => this.handleContainerEvent(event));

    // Fire once immediately so a stack that died while we were down is caught at
    // boot rather than up to a sweep-interval later.
    void withOperation("stack-status-sweep", () => this.sweep());
    this.intervalId = setInterval(() => {
      void withOperation("stack-status-sweep", () => this.sweep());
    }, this.sweepIntervalMs);
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    for (const timer of this.pendingChecks.values()) clearTimeout(timer);
    this.pendingChecks.clear();
    this.running = false;
  }

  isRunning(): boolean {
    return this.running;
  }

  /**
   * Docker event → debounced re-check of the owning stack.
   *
   * There is no unsubscribe hook on `onContainerEvent`, so this must stay safe
   * to call after `stop()` — hence the `running` guard.
   */
  private handleContainerEvent(event: DockerContainerEvent): void {
    if (!this.running) return;
    if (!WATCHED_ACTIONS.has(event.action)) return;

    const stackId = event.labels?.[STACK_ID_LABEL];
    if (!stackId) return;

    const existing = this.pendingChecks.get(stackId);
    if (existing) clearTimeout(existing);

    this.pendingChecks.set(
      stackId,
      setTimeout(() => {
        this.pendingChecks.delete(stackId);
        void withOperation("stack-status-event", () =>
          this.checkStack(stackId).catch((err) => {
            this.log.warn({ err, stackId }, "stack status check failed after container event");
          }),
        );
      }, EVENT_DEBOUNCE_MS),
    );
  }

  /**
   * Re-check every monitored stack. Public for tests.
   *
   * One `listContainers()` covers the whole fleet (and is already cached for 3s),
   * so this stays cheap no matter how many stacks there are.
   */
  async sweep(): Promise<void> {
    try {
      if (!this.docker.isConnected()) return;

      const stacks = await this.prisma.stack.findMany({
        where: { status: { in: [...MONITORED_STATUSES] } },
        select: { id: true, name: true, status: true, lastAppliedHashes: true },
      });
      if (stacks.length === 0) return;

      const containers = await this.docker.listContainers(true);
      const byStack = groupContainersByStack(containers);

      for (const stack of stacks) {
        await this.evaluate(
          stack,
          byStack.get(stack.id) ?? [],
        );
      }
    } catch (err) {
      // Never throw out of a timer tick.
      this.log.warn({ err }, "stack status sweep failed");
    }
  }

  /** Re-check a single stack. Public for tests. */
  async checkStack(stackId: string): Promise<void> {
    if (!this.docker.isConnected()) return;

    const stack = await this.prisma.stack.findUnique({
      where: { id: stackId },
      select: { id: true, name: true, status: true, lastAppliedHashes: true },
    });
    if (!stack) return;

    const containers = await this.docker.listContainers(true);
    const byStack = groupContainersByStack(containers);
    await this.evaluate(stack, byStack.get(stackId) ?? []);
  }

  /**
   * Apply the (narrow) status transition for one stack.
   */
  private async evaluate(
    stack: { id: string; name: string; status: string; lastAppliedHashes: unknown },
    containers: Parameters<typeof checkStackRuntime>[1],
  ): Promise<void> {
    if (!(MONITORED_STATUSES as readonly string[]).includes(stack.status)) return;

    // Never write a status underneath a live operation. An apply legitimately
    // stops and recreates containers, which would otherwise look exactly like a
    // service dying. Same pattern as the egress self-heal supervisor.
    if (stackOperationLock.has(stack.id)) return;

    const check = checkStackRuntime(stack, containers);
    // `null` means "no opinion" — the stack has no stored hashes (it was last
    // applied before we recorded them), so we have nothing trustworthy to diff
    // against. Leave the status alone rather than assume health.
    if (!check) return;

    const nextStatus = check.healthy ? "synced" : "drifted";
    if (nextStatus === stack.status) {
      // Status is right, but the issue list may still be stale (e.g. a drifted
      // stack whose failing service changed). Keep the persisted detail honest.
      await this.persistIssuesIfChanged(stack.id, check.issues);
      return;
    }

    // Re-acquire before writing: `has()` above is a TOCTOU check, and an
    // operation could have started in between. If we cannot take the lock, an
    // operation owns this stack and will write its own status.
    if (!stackOperationLock.tryAcquire(stack.id)) return;
    try {
      await this.prisma.stack.update({
        where: { id: stack.id },
        data: {
          status: nextStatus,
          runtimeIssues: check.issues as unknown as Prisma.InputJsonValue,
        },
      });
      emitStackStatusChanged(stack.id, nextStatus);

      if (nextStatus === "drifted") {
        this.log.info(
          { stackId: stack.id, stackName: stack.name, issues: check.issues },
          `stack ${stack.name} drifted: ${describeRuntimeIssues(check.issues)}`,
        );
      } else {
        this.log.info(
          { stackId: stack.id, stackName: stack.name },
          `stack ${stack.name} reconciled back to synced`,
        );
      }
    } finally {
      stackOperationLock.release(stack.id);
    }
  }

  /** Refresh the persisted issue list without touching status. */
  private async persistIssuesIfChanged(stackId: string, issues: RuntimeIssue[]): Promise<void> {
    const current = await this.prisma.stack.findUnique({
      where: { id: stackId },
      select: { runtimeIssues: true },
    });
    const before = JSON.stringify(current?.runtimeIssues ?? []);
    const after = JSON.stringify(issues);
    if (before === after) return;

    await this.prisma.stack.update({
      where: { id: stackId },
      data: { runtimeIssues: issues as unknown as Prisma.InputJsonValue },
    });
  }
}
