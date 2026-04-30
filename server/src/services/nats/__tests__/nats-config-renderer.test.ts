import { describe, it, expect } from "vitest";
import { renderNatsConfig } from "../nats-config-renderer";

describe("renderNatsConfig", () => {
  it("emits operator, MEMORY resolver, and the account preload block", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP_JWT_PLACEHOLDER",
      accountPublicKey: "ACCT_PUBLIC",
      accountJwt: "ACCT_JWT_PLACEHOLDER",
      jetStream: false,
    });

    expect(conf).toContain("operator: OP_JWT_PLACEHOLDER");
    expect(conf).toContain("resolver: MEMORY");
    expect(conf).toContain("ACCT_PUBLIC: ACCT_JWT_PLACEHOLDER");
    expect(conf).not.toContain("jetstream");
  });

  it("includes a jetstream block with the default store_dir when enabled", () => {
    const conf = renderNatsConfig({
      operatorJwt: "OP",
      accountPublicKey: "AP",
      accountJwt: "AJ",
      jetStream: true,
    });

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
