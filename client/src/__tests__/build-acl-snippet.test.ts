/**
 * Pins the canonical Tailscale ACL bootstrap snippet shape so the form
 * preview, the docs page, and the server-side helper can't drift apart.
 */

import { describe, it, expect } from "vitest";
import { buildAclSnippet } from "@/lib/tailscale/build-acl-snippet";
import { TAILSCALE_DEFAULT_TAG } from "@mini-infra/types";

describe("buildAclSnippet", () => {
  it("includes the default managed tag in tagOwners / grants / ssh", () => {
    const snippet = JSON.parse(buildAclSnippet());
    expect(snippet.tagOwners[TAILSCALE_DEFAULT_TAG]).toEqual([
      "autogroup:admin",
    ]);
    expect(snippet.grants[0].dst).toContain(TAILSCALE_DEFAULT_TAG);
    expect(snippet.ssh[0].dst).toContain(TAILSCALE_DEFAULT_TAG);
  });

  it("places the default tag first when extras are supplied", () => {
    const snippet = JSON.parse(
      buildAclSnippet(["tag:internal-tools", "tag:lab"]),
    );
    expect(Object.keys(snippet.tagOwners)).toEqual([
      TAILSCALE_DEFAULT_TAG,
      "tag:internal-tools",
      "tag:lab",
    ]);
    expect(snippet.grants[0].dst).toEqual([
      TAILSCALE_DEFAULT_TAG,
      "tag:internal-tools",
      "tag:lab",
    ]);
  });

  it("emits an ssh stanza with action:check and a 12h re-check window", () => {
    const snippet = JSON.parse(buildAclSnippet());
    expect(snippet.ssh[0].action).toBe("check");
    expect(snippet.ssh[0].checkPeriod).toBe("12h");
    expect(snippet.ssh[0].src).toEqual(["autogroup:member"]);
  });

  it("returns indented JSON suitable for click-to-copy", () => {
    const snippet = buildAclSnippet();
    expect(snippet).toContain("\n  ");
    expect(() => JSON.parse(snippet)).not.toThrow();
  });
});
