import { describe, it, expect } from "vitest";
import { renderNatsConfig } from "../nats-config-renderer";

describe("renderNatsConfig", () => {
  it("emits operator + the full resolver block", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP_JWT_PLACEHOLDER",
      accountPublicKey: "ACCT_PUBLIC",
      accountJwt: "ACCT_JWT_PLACEHOLDER",
      jetStream: false,
    });

    expect(conf).toContain("operator: OP_JWT_PLACEHOLDER");
    expect(conf).toContain("resolver: {");
    expect(conf).toContain("type: full");
    expect(conf).toContain('dir: "/data/accounts"');
    expect(conf).toContain("allow_delete: false");
    // Account JWTs are not embedded — they live on disk under /data/accounts.
    expect(conf).not.toContain("ACCT_JWT_PLACEHOLDER");
    expect(conf).not.toContain("resolver_preload");
    expect(conf).not.toContain("system_account:");
    expect(conf).not.toContain("jetstream");
  });

  it("includes system_account and a jetstream block with the default store_dir when enabled", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP",
      accountPublicKey: "AP",
      accountJwt: "AJ",
      jetStream: true,
    });

    expect(conf).toContain("system_account: AP");
    expect(conf).toContain("jetstream {");
    expect(conf).toContain('store_dir: "/data/jetstream"');
  });

  it("respects custom store_dir and max_file_store", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP",
      accountPublicKey: "AP",
      accountJwt: "AJ",
      jetStream: true,
      jetStreamStoreDir: "/var/jetstream",
      jetStreamMaxStore: "10G",
    });

    expect(conf).toContain('store_dir: "/var/jetstream"');
    expect(conf).toContain("max_file_store: 10G");
  });

  it("uses the explicit systemAccountPublicKey when supplied", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP",
      accounts: [
        { publicKey: "A_SYS", jwt: "SYS_JWT" },
        { publicKey: "A_APP", jwt: "APP_JWT" },
      ],
      systemAccountPublicKey: "A_SYS",
      jetStream: true,
    });

    expect(conf).toContain("system_account: A_SYS");
    // Full resolver does not preload — JWTs live in /data/accounts.
    expect(conf).not.toContain("SYS_JWT");
    expect(conf).not.toContain("APP_JWT");
  });

  it("respects a custom resolverDir", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP",
      accountPublicKey: "AP",
      accountJwt: "AJ",
      jetStream: true,
      resolverDir: "/var/nats/accounts",
    });

    expect(conf).toContain('dir: "/var/nats/accounts"');
  });

  it("ends with a trailing newline", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP",
      accountPublicKey: "AP",
      accountJwt: "AJ",
      jetStream: false,
    });
    expect(conf.endsWith("\n")).toBe(true);
  });
});
