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

export interface NatsConfigInputs {
  operatorJwt: string;
  accountPublicKey?: string;
  accountJwt?: string;
  accounts?: RenderedNatsAccount[];
  systemAccountPublicKey?: string;
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

  const lines: string[] = [];
  lines.push("# Managed by mini-infra — regenerated on every NATS bootstrap.");
  lines.push(`operator: ${inputs.operatorJwt}`);
  if (inputs.jetStream && systemAccountPublicKey) {
    lines.push(`system_account: ${systemAccountPublicKey}`);
  }
  lines.push("");
  lines.push("resolver: MEMORY");
  lines.push("");
  lines.push("resolver_preload: {");
  for (const account of accounts) {
    lines.push(`  ${account.publicKey}: ${account.jwt}`);
  }
  lines.push("}");
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
