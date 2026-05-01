// Renders the nats.conf body served to the NATS container.
//
// The container fetches this string from Vault KV at apply time (via a
// `vault-kv` dynamicEnv source) and writes it to /etc/nats/nats.conf
// before invoking nats-server. Keeping the renderer in one place lets the
// bootstrap step regenerate the conf any time the operator/account JWTs
// rotate without re-deriving the layout in two places.

export interface RenderedNatsAccount {
  publicKey: string;
  jwt: string;
}

/**
 * `memory`  — original Phase-1 mode. Embeds `resolver_preload { ... }` directly
 *             in nats.conf. Account JWTs do not hot-reload; rotating a scoped
 *             signing key requires a server restart.
 *
 * `full`    — full account resolver (Phase 0). NATS reads JWTs from
 *             `resolverDir/<publicKey>.jwt` files at startup and accepts
 *             `$SYS.REQ.CLAIMS.UPDATE` requests at runtime. Required for
 *             Phase 4 signers — without it scoped signing-key rotation
 *             cannot propagate without bouncing the server.
 */
export type NatsResolverMode = "memory" | "full";

export interface NatsConfigInputs {
  operatorJwt: string;
  accountPublicKey?: string;
  accountJwt?: string;
  accounts?: RenderedNatsAccount[];
  systemAccountPublicKey?: string;
  /** Resolver mode — defaults to "memory" for backwards compatibility with
   *  Phase 1 vault-nats v1. The v2 template renders "full". */
  resolverMode?: NatsResolverMode;
  /** Directory the full resolver loads JWTs from / writes to. Defaults to
   *  /data/accounts (the NATS container's mounted nats_data volume). Only
   *  used in "full" mode. */
  resolverDir?: string;
  /** Enable JetStream persistence. The NATS container mounts /data, so the
   *  store directory points there. */
  jetStream: boolean;
  /** Server-side store directory for JetStream. Defaults to /data/jetstream. */
  jetStreamStoreDir?: string;
  /** Soft cap on JetStream disk usage. Omitted by default — NATS uses 75%
   *  of free disk on the volume. */
  jetStreamMaxStore?: string;
}

export function renderNatsConfig(inputs: NatsConfigInputs): string {
  const accounts = inputs.accounts ?? (
    inputs.accountPublicKey && inputs.accountJwt
      ? [{ publicKey: inputs.accountPublicKey, jwt: inputs.accountJwt }]
      : []
  );
  const systemAccountPublicKey = inputs.systemAccountPublicKey ?? inputs.accountPublicKey ?? accounts[0]?.publicKey;
  const resolverMode: NatsResolverMode = inputs.resolverMode ?? "memory";

  const lines: string[] = [];
  lines.push("# Managed by mini-infra — regenerated on every NATS bootstrap.");
  lines.push(`operator: ${inputs.operatorJwt}`);
  if (inputs.jetStream && systemAccountPublicKey) {
    lines.push(`system_account: ${systemAccountPublicKey}`);
  }
  lines.push("");

  if (resolverMode === "full") {
    const dir = inputs.resolverDir ?? "/data/accounts";
    lines.push("resolver: {");
    lines.push("  type: full");
    lines.push(`  dir: "${dir}"`);
    // Reject runtime delete requests — mini-infra owns the lifecycle and
    // pushes empty/replacement JWTs through `$SYS.REQ.CLAIMS.UPDATE` instead.
    lines.push("  allow_delete: false");
    lines.push("}");
  } else {
    lines.push("resolver: MEMORY");
    lines.push("");
    lines.push("resolver_preload: {");
    for (const account of accounts) {
      lines.push(`  ${account.publicKey}: ${account.jwt}`);
    }
    lines.push("}");
  }

  if (inputs.jetStream) {
    lines.push("");
    lines.push("jetstream {");
    lines.push(`  store_dir: "${inputs.jetStreamStoreDir ?? "/data/jetstream"}"`);
    if (inputs.jetStreamMaxStore) {
      lines.push(`  max_file_store: ${inputs.jetStreamMaxStore}`);
    }
    lines.push("}");
  }
  return lines.join("\n") + "\n";
}
