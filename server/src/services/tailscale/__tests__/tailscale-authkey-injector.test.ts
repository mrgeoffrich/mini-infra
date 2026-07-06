import { describe, it, expect, vi, beforeEach } from "vitest";
import type { StackContainerConfig } from "@mini-infra/types";
import { TailscaleAuthkeyInjector } from "../tailscale-authkey-injector";
import type { TailscaleAuthkeyMinter } from "../tailscale-authkey-minter";

// The injector composes a TailscaleAuthkeyMinter; inject a fake one so the
// unit test never touches prisma or the tailnet API. Constructor accepts an
// optional minter override for exactly this reason.
const prisma = {} as ConstructorParameters<typeof TailscaleAuthkeyInjector>[0];

const cfg = (dynamicEnv?: Record<string, unknown>): StackContainerConfig =>
  ({ dynamicEnv } as unknown as StackContainerConfig);

const fakeMinter = (mintAuthkey: ReturnType<typeof vi.fn>) =>
  ({ mintAuthkey } as unknown as TailscaleAuthkeyMinter);

describe("TailscaleAuthkeyInjector", () => {
  let mintAuthkey: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mintAuthkey = vi.fn();
  });

  it("returns null when the service declares no dynamicEnv", async () => {
    const injector = new TailscaleAuthkeyInjector(prisma, fakeMinter(mintAuthkey));
    expect(await injector.resolve(cfg(undefined))).toBeNull();
    expect(mintAuthkey).not.toHaveBeenCalled();
  });

  it("returns null when no tailscale-authkey entry is present", async () => {
    const injector = new TailscaleAuthkeyInjector(prisma, fakeMinter(mintAuthkey));
    const res = await injector.resolve(cfg({ OTHER: { kind: "nats-url" } }));
    expect(res).toBeNull();
    expect(mintAuthkey).not.toHaveBeenCalled();
  });

  it("mints once and maps the key onto every declared env key", async () => {
    mintAuthkey.mockResolvedValue({ key: "tskey-auth-abc123" });
    const injector = new TailscaleAuthkeyInjector(prisma, fakeMinter(mintAuthkey));
    const res = await injector.resolve(
      cfg({
        TS_AUTHKEY: { kind: "tailscale-authkey" },
        ALT: { kind: "tailscale-authkey" },
      }),
    );
    expect(res).toEqual({ TS_AUTHKEY: "tskey-auth-abc123", ALT: "tskey-auth-abc123" });
    // Minted exactly once, not per-key — minting per key would waste tailnet keys.
    expect(mintAuthkey).toHaveBeenCalledTimes(1);
  });

  it("throws (fail-closed) when the mint returns an empty key", async () => {
    mintAuthkey.mockResolvedValue({ key: "" });
    const injector = new TailscaleAuthkeyInjector(prisma, fakeMinter(mintAuthkey));
    await expect(
      injector.resolve(cfg({ TS_AUTHKEY: { kind: "tailscale-authkey" } })),
    ).rejects.toThrow(/empty key/);
  });

  it("propagates a mint failure (fail-closed) so apply aborts", async () => {
    mintAuthkey.mockRejectedValue(new Error("tailscale connected service not configured"));
    const injector = new TailscaleAuthkeyInjector(prisma, fakeMinter(mintAuthkey));
    await expect(
      injector.resolve(cfg({ TS_AUTHKEY: { kind: "tailscale-authkey" } })),
    ).rejects.toThrow(/not configured/);
  });
});
