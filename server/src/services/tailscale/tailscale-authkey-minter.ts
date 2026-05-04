import {
  TailscaleAuthkeyRequest,
  TailscaleAuthkeyResponse,
  TAILSCALE_ERROR_CODES,
} from "@mini-infra/types";
import { TailscaleService, TailscaleAuthError } from "./tailscale-service";
import { getLogger } from "../../lib/logger-factory";

const TAILSCALE_API_BASE = "https://api.tailscale.com/api/v2";
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

export interface MintAuthkeyOptions {
  /** Override the default + extra-tags set (e.g. for one-off probes). */
  tags?: string[];
  expirySeconds?: number;
  reusable?: boolean;
  /**
   * `true` registers a node that auto-cleans when it disconnects — the right
   * default for Mini Infra's addon sidecars and for the validation probe.
   */
  ephemeral?: boolean;
  preauthorized?: boolean;
}

/**
 * Mints short-lived, ephemeral, pre-authorised Tailscale authkeys against
 * `POST /api/v2/tailnet/-/keys`. The `-` placeholder resolves to "the
 * tailnet that owns this OAuth client", so we never need to know the
 * tailnet name explicitly.
 *
 * The minter composes {@link TailscaleService} for credential storage and
 * access-token retrieval; it owns no settings of its own.
 */
export class TailscaleAuthkeyMinter {
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly service: TailscaleService,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.fetchImpl = fetchImpl;
  }

  async mintAuthkey(
    options: MintAuthkeyOptions = {},
  ): Promise<TailscaleAuthkeyResponse> {
    const accessToken = await this.service.getAccessToken();
    const tags = options.tags ?? (await this.service.getAllManagedTags());
    if (tags.length === 0) {
      throw new TailscaleAuthError(
        "No Tailscale tags configured — at least one tag is required to mint an authkey",
        TAILSCALE_ERROR_CODES.INVALID_TAG,
      );
    }

    const payload: TailscaleAuthkeyRequest = {
      capabilities: {
        devices: {
          create: {
            reusable: options.reusable ?? false,
            ephemeral: options.ephemeral ?? true,
            preauthorized: options.preauthorized ?? true,
            tags,
          },
        },
      },
      expirySeconds: options.expirySeconds ?? 3600,
    };

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      DEFAULT_REQUEST_TIMEOUT_MS,
    );

    let response: Response;
    try {
      response = await this.fetchImpl(`${TAILSCALE_API_BASE}/tailnet/-/keys`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name === "AbortError") {
        throw new TailscaleAuthError(
          "Tailscale authkey mint timed out",
          TAILSCALE_ERROR_CODES.NETWORK_ERROR,
        );
      }
      throw new TailscaleAuthError(
        `Failed to reach Tailscale authkey endpoint: ${
          err instanceof Error ? err.message : "unknown"
        }`,
        TAILSCALE_ERROR_CODES.NETWORK_ERROR,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await safeReadText(response);
      // Tag-ownership errors look like 403 with the message
      // "requested tags [...] are invalid or not permitted" — surface them
      // separately so the form can point the operator at the ACL step.
      if (
        response.status === 403 &&
        /tag/i.test(text) &&
        /invalid|permitted|owner/i.test(text)
      ) {
        throw new TailscaleAuthError(
          `OAuth client doesn't own the requested tag set: ${text}`,
          TAILSCALE_ERROR_CODES.INVALID_TAG,
        );
      }
      throw new TailscaleAuthError(
        `Tailscale authkey mint failed (HTTP ${response.status}): ${text}`,
        TAILSCALE_ERROR_CODES.TAILSCALE_API_ERROR,
      );
    }

    const data = (await response.json()) as TailscaleAuthkeyResponse;
    getLogger("integrations", "tailscale-authkey-minter").info(
      {
        keyId: data.id,
        expires: data.expires,
        ephemeral: payload.capabilities.devices.create.ephemeral,
        tags,
      },
      "Tailscale authkey minted",
    );

    return data;
  }

  /**
   * Probe the OAuth client's tag ownership by minting a 60-second ephemeral
   * authkey and discarding it. Used by the settings form's Validate & Save
   * to surface the `INVALID_TAG` prerequisite-chain error before the
   * operator wires Phase 3 sidecars.
   */
  async probeTagOwnership(): Promise<void> {
    await this.mintAuthkey({ expirySeconds: 60, ephemeral: true });
  }
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return "<unavailable>";
  }
}
