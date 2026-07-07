import type { PrismaClient } from "../../generated/prisma/client";
import type { StackContainerConfig } from "@mini-infra/types";
import { InternalError } from "../../lib/errors";
import { TailscaleService } from "./tailscale-service";
import { TailscaleAuthkeyMinter } from "./tailscale-authkey-minter";

/**
 * Resolves the `tailscale-authkey` dynamicEnv kind at apply time.
 *
 * The `tailscale-ingress` host stack's `tailscaled` sidecar needs a fresh,
 * ephemeral, pre-authorized authkey to register itself on the operator's
 * tailnet. Rather than baking a key into a stack parameter (single-use keys
 * would go stale, and the secret would land in the stack definition), the
 * template declares the key as a dynamicEnv value; this injector mints a new
 * one on every apply via the `tailscale` connected service. `tailscaled`
 * reads the resulting `TS_AUTHKEY` env var natively on first boot.
 *
 * Keys are minted with the minter's defaults — `ephemeral: true`,
 * `preauthorized: true`, `reusable: false` — and tagged with the tailnet's
 * managed-tag set (`tag:mini-infra-managed` + operator extras), so the device
 * shows up in `TailscaleService.listDevices()` and auto-cleans from the
 * tailnet when the stack is destroyed.
 *
 * Fails closed: if the `tailscale` connected service isn't configured, or the
 * mint call fails, resolution throws so the apply aborts before a sidecar is
 * started with an empty authkey.
 */
export class TailscaleAuthkeyInjector {
  private readonly minter: TailscaleAuthkeyMinter;

  constructor(
    private readonly prisma: PrismaClient,
    minter?: TailscaleAuthkeyMinter,
  ) {
    this.minter = minter ?? new TailscaleAuthkeyMinter(new TailscaleService(this.prisma));
  }

  async resolve(
    containerConfig: StackContainerConfig,
  ): Promise<Record<string, string> | null> {
    const dynamicEnv = containerConfig.dynamicEnv;
    if (!dynamicEnv) return null;

    const keys = Object.entries(dynamicEnv)
      .filter(([, src]) => src.kind === "tailscale-authkey")
      .map(([key]) => key);
    if (keys.length === 0) return null;

    // Mint once and reuse for every declared key — a service normally declares
    // exactly one (`TS_AUTHKEY`), but minting per key would waste tailnet keys.
    const authkey = await this.minter.mintAuthkey();
    if (!authkey.key) {
      // The minter is expected to throw on a real failure (missing config,
      // API error) — an empty key on a "successful" mint is an unexpected
      // shape from the minter, not something the apply caller can fix.
      throw new InternalError(
        "Tailscale authkey mint returned an empty key — check the tailscale connected service configuration",
      );
    }

    const values: Record<string, string> = {};
    for (const key of keys) values[key] = authkey.key;
    return values;
  }
}
