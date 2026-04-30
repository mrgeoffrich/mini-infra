import { OperatorPassphraseService } from "../../lib/operator-passphrase-service";
import { VaultAdminService, UNSEAL_STEP_NAMES } from "./vault-admin-service";
import { VaultStateService } from "./vault-state-service";
import { getNatsBootstrapService } from "../nats/nats-bootstrap-service";
import { emitToChannel } from "../../lib/socket";
import { Channel, ServerEvent } from "@mini-infra/types";
import type { VaultStatus } from "@mini-infra/types";
import { getLogger } from "../../lib/logger-factory";
import crypto from "crypto";

const log = getLogger("platform", "vault-health-watcher");

/**
 * Periodically probes Vault health and auto-unseals when:
 *   - Vault is reachable,
 *   - Vault is sealed,
 *   - the operator passphrase is unlocked (so stored unseal keys can be decrypted).
 *
 * Emits VAULT_STATUS_CHANGED whenever the observed status transitions.
 * Emits a VAULT_UNSEAL operation cycle (started / step / completed) when
 * an auto-unseal fires — same shape as operator-triggered unseals.
 */
export class VaultHealthWatcher {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private unsealInFlight = false;
  private lastStatus: VaultStatus | null = null;

  constructor(
    private readonly passphrase: OperatorPassphraseService,
    private readonly admin: VaultAdminService,
    private readonly stateService: VaultStateService,
    private readonly intervalMs: number = 15_000,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    log.info({ intervalMs: this.intervalMs }, "Vault health watcher started");
    // Kick off an immediate probe, then schedule subsequent ticks.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    log.info("Vault health watcher stopped");
  }

  /** One probe cycle — visible for test drivers. */
  async tick(): Promise<void> {
    try {
      const status = await this.currentStatus();
      if (this.hasChanged(status)) {
        this.lastStatus = status;
        try {
          emitToChannel(Channel.VAULT, ServerEvent.VAULT_STATUS_CHANGED, {
            status,
          });
        } catch (err) {
          log.debug(
            { err: err instanceof Error ? err.message : String(err) },
            "Failed to emit VAULT_STATUS_CHANGED",
          );
        }
      }

      if (
        !this.unsealInFlight &&
        status.reachable &&
        status.sealed === true &&
        status.initialised &&
        status.passphrase.state === "unlocked"
      ) {
        await this.tryAutoUnseal();
      }
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "Vault health tick failed",
      );
    }
  }

  async currentStatus(): Promise<VaultStatus> {
    const meta = await this.stateService.getMeta();
    const passphraseState = this.passphrase.getState();
    const passphrase = {
      state: passphraseState,
      retryDelayMs: this.passphrase.getRetryDelayMs(),
    };

    if (!meta?.address || !this.admin.getClient()) {
      return {
        initialised: meta?.bootstrappedAt != null,
        bootstrappedAt: meta?.bootstrappedAt?.toISOString() ?? null,
        sealed: null,
        sealState: "unknown",
        reachable: false,
        address: meta?.address ?? null,
        stackId: meta?.stackId ?? null,
        passphrase,
      };
    }
    const probe = await this.admin.probe();
    const sealState: VaultStatus["sealState"] = !probe.reachable
      ? "unknown"
      : !probe.initialised
        ? "uninitialised"
        : probe.sealed === true
          ? "sealed"
          : probe.sealed === false
            ? "unsealed"
            : "unknown";

    return {
      initialised: meta.bootstrappedAt != null,
      bootstrappedAt: meta.bootstrappedAt?.toISOString() ?? null,
      sealed: probe.sealed,
      sealState,
      reachable: probe.reachable,
      address: meta.address,
      stackId: meta.stackId,
      passphrase,
    };
  }

  private hasChanged(next: VaultStatus): boolean {
    if (!this.lastStatus) return true;
    return (
      this.lastStatus.sealState !== next.sealState ||
      this.lastStatus.reachable !== next.reachable ||
      this.lastStatus.passphrase.state !== next.passphrase.state ||
      this.lastStatus.initialised !== next.initialised
    );
  }

  private async tryAutoUnseal(): Promise<void> {
    this.unsealInFlight = true;
    const operationId = `vault-auto-unseal-${crypto.randomUUID()}`;
    const total = UNSEAL_STEP_NAMES.length;

    try {
      emitToChannel(Channel.VAULT, ServerEvent.VAULT_UNSEAL_STARTED, {
        operationId,
        totalSteps: total,
        stepNames: [...UNSEAL_STEP_NAMES],
      });
    } catch (err) {
      log.debug({ err }, "Failed to emit VAULT_UNSEAL_STARTED");
    }

    let success = true;
    const steps: { step: string; status: "completed" | "failed"; detail?: string }[] = [];
    const errors: string[] = [];
    try {
      await this.admin.unseal((step, completedCount, totalSteps) => {
        steps.push({
          step: step.step,
          status: step.status === "skipped" ? "completed" : step.status,
          detail: step.detail,
        });
        try {
          emitToChannel(Channel.VAULT, ServerEvent.VAULT_UNSEAL_STEP, {
            operationId,
            step,
            completedCount,
            totalSteps,
          });
        } catch (err) {
          log.debug({ err }, "Failed to emit VAULT_UNSEAL_STEP");
        }
      });
      log.info("Auto-unseal succeeded");
      // Vault is now usable — make sure NATS KV state is current. Requires
      // an authenticated admin token; re-auth first since unseal alone does
      // not refresh it. Non-fatal so a NATS hiccup never blocks Vault.
      try {
        await this.admin.authenticateAsAdmin();
        await getNatsBootstrapService().bootstrap();
      } catch (natsErr) {
        log.warn(
          { err: natsErr instanceof Error ? natsErr.message : String(natsErr) },
          "NATS bootstrap after auto-unseal failed (non-fatal)",
        );
      }
    } catch (err) {
      success = false;
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      log.warn({ err: msg }, "Auto-unseal failed");
    } finally {
      try {
        emitToChannel(Channel.VAULT, ServerEvent.VAULT_UNSEAL_COMPLETED, {
          operationId,
          success,
          steps,
          errors,
        });
      } catch (err) {
        log.debug({ err }, "Failed to emit VAULT_UNSEAL_COMPLETED");
      }
      this.unsealInFlight = false;
    }
  }
}
