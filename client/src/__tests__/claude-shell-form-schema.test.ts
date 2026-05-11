/**
 * Unit tests for the Claude Shell preset form schema + helpers.
 *
 * The form gates user-supplied input client-side before it ever hits the
 * server-side `claudeShellConfigSchema` or `stacks-git-deploy-key-route`'s
 * PEM regex. These tests pin the validation cases enumerated in §5 of
 * docs/planning/not-shipped/claude-shell-plan.md Phase 6:
 *
 *   - name required
 *   - environment required
 *   - extra tags must match `tag:[a-z0-9-]+`
 *   - SSH key (when supplied) must look PEM-shaped
 *   - git repo URL accepts HTTPS or `git@host:path`
 *   - slugify produces a stack-name-safe value
 */

import { describe, it, expect } from "vitest";
import {
  claudeShellFormSchema,
  parseExtraTags,
  slugifyClaudeShellName,
  CLAUDE_SHELL_IMAGE,
  CLAUDE_SHELL_DEFAULT_TAG,
  CLAUDE_SHELL_SERVICE_NAME,
} from "@/lib/claude-shell-form";

describe("claudeShellFormSchema", () => {
  const valid = {
    name: "My Shell",
    environmentId: "env-1",
    gitRepo: "",
    gitDeployKey: "",
    extraTagsRaw: "",
  };

  it("accepts the minimum-viable form (name + env only)", () => {
    const result = claudeShellFormSchema.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("rejects empty name", () => {
    const result = claudeShellFormSchema.safeParse({ ...valid, name: "" });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "name")).toBe(true);
    }
  });

  it("rejects empty environmentId", () => {
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      environmentId: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "environmentId"),
      ).toBe(true);
    }
  });

  it("accepts a valid HTTPS git repo URL", () => {
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      gitRepo: "https://github.com/owner/repo.git",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid SSH-form git repo URL", () => {
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      gitRepo: "git@github.com:owner/repo.git",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed git repo URL", () => {
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      gitRepo: "not-a-url",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.path[0] === "gitRepo")).toBe(
        true,
      );
    }
  });

  it("accepts a PEM-shaped SSH deploy key", () => {
    const pem = [
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      "ZmFrZS1zaG93LXdoYXQtcGVtLWxvb2tzLWxpa2U=",
      "-----END OPENSSH PRIVATE KEY-----",
    ].join("\n");
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      gitRepo: "git@github.com:owner/repo.git",
      gitDeployKey: pem,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-PEM SSH deploy key", () => {
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      gitRepo: "git@github.com:owner/repo.git",
      gitDeployKey: "not-a-pem-key",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "gitDeployKey"),
      ).toBe(true);
    }
  });

  it("accepts well-formed tailnet tags", () => {
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      extraTagsRaw: "tag:dev-team, tag:claude-shell",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed tailnet tag", () => {
    const result = claudeShellFormSchema.safeParse({
      ...valid,
      extraTagsRaw: "dev-team",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => i.path[0] === "extraTagsRaw"),
      ).toBe(true);
    }
  });
});

describe("slugifyClaudeShellName", () => {
  it("lowercases and collapses non-alnum to hyphens", () => {
    expect(slugifyClaudeShellName("My Shell")).toBe("my-shell");
    expect(slugifyClaudeShellName("Hello   World")).toBe("hello-world");
    expect(slugifyClaudeShellName("UPPER.case_v1")).toBe("upper-case-v1");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugifyClaudeShellName("---hello---")).toBe("hello");
  });

  it("truncates at 63 chars", () => {
    const long = "a".repeat(100);
    expect(slugifyClaudeShellName(long).length).toBe(63);
  });

  it("returns an empty string for all-non-alnum input", () => {
    expect(slugifyClaudeShellName("!!!")).toBe("");
  });
});

describe("parseExtraTags", () => {
  it("returns undefined for empty input", () => {
    expect(parseExtraTags("")).toBeUndefined();
    expect(parseExtraTags(undefined)).toBeUndefined();
  });

  it("splits and trims comma-separated tags", () => {
    expect(parseExtraTags("tag:a, tag:b ,tag:c")).toEqual([
      "tag:a",
      "tag:b",
      "tag:c",
    ]);
  });

  it("returns undefined when all entries are blank", () => {
    expect(parseExtraTags(",, ,")).toBeUndefined();
  });
});

describe("preset constants", () => {
  it("uses the published image from the plan §4.4", () => {
    expect(CLAUDE_SHELL_IMAGE).toBe(
      "ghcr.io/mrgeoffrich/mini-infra-claude-shell",
    );
    expect(CLAUDE_SHELL_DEFAULT_TAG).toBe("latest");
  });

  it("pins the service name to `shell` so the addon-endpoints route finds it", () => {
    // The Phase 4 Connect-panel hostname rule (sanitizeTailscaleHostname) and
    // the Phase 5 git-deploy-key route both key off `(stackId, serviceName)`.
    // Renaming this constant is a breaking change across phases.
    expect(CLAUDE_SHELL_SERVICE_NAME).toBe("shell");
  });
});
