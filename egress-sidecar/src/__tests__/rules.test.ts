import { describe, it, expect } from "vitest";
import { RuleTrie, buildTrie, matchPolicy } from "../rules";
import type { EgressRule, StackPolicy } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRule(
  pattern: string,
  action: "allow" | "block",
  targets: string[] = [],
): EgressRule {
  return { id: `rule-${pattern}`, pattern, action, targets };
}

function makePolicy(
  rules: EgressRule[],
  defaultAction: "allow" | "block" = "block",
  mode: "detect" | "enforce" = "enforce",
): StackPolicy {
  return { mode, defaultAction, rules };
}

// ---------------------------------------------------------------------------
// RuleTrie.match — basic matching
// ---------------------------------------------------------------------------

describe("RuleTrie", () => {
  it("exact match returns matching rule", () => {
    const trie = new RuleTrie();
    const rule = makeRule("api.openai.com", "allow");
    trie.insert(rule);

    const result = trie.match("api.openai.com", null);
    expect(result).toBe(rule);
  });

  it("exact match is case-insensitive", () => {
    const trie = new RuleTrie();
    const rule = makeRule("API.OpenAI.com", "allow");
    trie.insert(rule);

    expect(trie.match("api.openai.com", null)).toBe(rule);
    expect(trie.match("API.OPENAI.COM", null)).toBe(rule);
  });

  it("wildcard *.foo.com matches bar.foo.com", () => {
    const trie = new RuleTrie();
    const rule = makeRule("*.foo.com", "block");
    trie.insert(rule);

    expect(trie.match("bar.foo.com", null)).toBe(rule);
  });

  it("wildcard *.foo.com matches multi-label subdomains (foo.bar.foo.com)", () => {
    const trie = new RuleTrie();
    const rule = makeRule("*.foo.com", "block");
    trie.insert(rule);

    // The wildcard matches ANY child beyond .foo.com
    expect(trie.match("foo.bar.foo.com", null)).toBe(rule);
  });

  it("wildcard *.foo.com does NOT match foo.com (base domain itself)", () => {
    const trie = new RuleTrie();
    const rule = makeRule("*.foo.com", "block");
    trie.insert(rule);

    // foo.com has no child label consumed by the wildcard
    expect(trie.match("foo.com", null)).toBeNull();
  });

  it("exact match wins over wildcard at the same depth", () => {
    const trie = new RuleTrie();
    const wildcardRule = makeRule("*.openai.com", "block");
    const exactRule = makeRule("api.openai.com", "allow");
    trie.insert(wildcardRule);
    trie.insert(exactRule);

    // api.openai.com is exactly 3 labels; exact match at depth 3 wins over wildcard at depth 3
    const result = trie.match("api.openai.com", null);
    expect(result).toBe(exactRule);
  });

  it("longer match wins — *.foo.com beats *.com", () => {
    const trie = new RuleTrie();
    const comRule = makeRule("*.com", "allow");
    const fooRule = makeRule("*.foo.com", "block");
    trie.insert(comRule);
    trie.insert(fooRule);

    const result = trie.match("bar.foo.com", null);
    expect(result).toBe(fooRule);
  });

  it("falls back to shorter match when no longer match exists", () => {
    const trie = new RuleTrie();
    const comRule = makeRule("*.com", "allow");
    trie.insert(comRule);

    const result = trie.match("something.example.com", null);
    expect(result).toBe(comRule);
  });

  it("returns null when no rule matches", () => {
    const trie = new RuleTrie();
    trie.insert(makeRule("api.openai.com", "allow"));

    expect(trie.match("api.google.com", null)).toBeNull();
  });

  it("returns null for empty trie", () => {
    const trie = new RuleTrie();
    expect(trie.match("anything.example.com", null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// targets filtering
// ---------------------------------------------------------------------------

describe("RuleTrie — targets filtering", () => {
  it("rule with empty targets applies to all services", () => {
    const trie = new RuleTrie();
    const rule = makeRule("api.openai.com", "allow", []);
    trie.insert(rule);

    expect(trie.match("api.openai.com", "web")).toBe(rule);
    expect(trie.match("api.openai.com", "worker")).toBe(rule);
    expect(trie.match("api.openai.com", null)).toBe(rule);
  });

  it("rule with specific targets only matches listed services", () => {
    const trie = new RuleTrie();
    const rule = makeRule("api.openai.com", "allow", ["web"]);
    trie.insert(rule);

    expect(trie.match("api.openai.com", "web")).toBe(rule);
    expect(trie.match("api.openai.com", "worker")).toBeNull();
    expect(trie.match("api.openai.com", null)).toBeNull();
  });

  it("skips non-matching target rule and falls back to next applicable", () => {
    const trie = new RuleTrie();
    // Rule 1: only for "web" — should be skipped for "worker"
    const rule1 = makeRule("api.openai.com", "block", ["web"]);
    // Rule 2: all services — should be used for "worker"
    const rule2 = makeRule("api.openai.com", "allow", []);
    trie.insert(rule1);
    trie.insert(rule2);

    expect(trie.match("api.openai.com", "web")).toBe(rule1);
    expect(trie.match("api.openai.com", "worker")).toBe(rule2);
  });

  it("wildcard respects targets filtering", () => {
    const trie = new RuleTrie();
    const rule = makeRule("*.googleapis.com", "allow", ["web"]);
    trie.insert(rule);

    expect(trie.match("oauth2.googleapis.com", "web")).toBe(rule);
    expect(trie.match("oauth2.googleapis.com", "worker")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// matchPolicy — defaultAction
// ---------------------------------------------------------------------------

describe("matchPolicy", () => {
  it("returns defaultAction when no rule matches", () => {
    const policy = makePolicy([], "block");
    const trie = buildTrie(policy);

    const result = matchPolicy(trie, policy, "example.com", null);
    expect(result.action).toBe("block");
    expect(result.matchedPattern).toBeNull();
  });

  it("returns allow defaultAction when policy is permissive and no rules match", () => {
    const policy = makePolicy([], "allow");
    const trie = buildTrie(policy);

    const result = matchPolicy(trie, policy, "anything.example.com", null);
    expect(result.action).toBe("allow");
    expect(result.matchedPattern).toBeNull();
  });

  it("returns matched rule action and pattern", () => {
    const rule = makeRule("api.openai.com", "allow");
    const policy = makePolicy([rule], "block");
    const trie = buildTrie(policy);

    const result = matchPolicy(trie, policy, "api.openai.com", null);
    expect(result.action).toBe("allow");
    expect(result.matchedPattern).toBe("api.openai.com");
  });

  it("empty policy always returns defaultAction", () => {
    const policy = makePolicy([], "allow");
    const trie = buildTrie(policy);

    for (const domain of [
      "google.com",
      "api.stripe.com",
      "foo.bar.baz.example.org",
    ]) {
      const result = matchPolicy(trie, policy, domain, null);
      expect(result.action).toBe("allow");
      expect(result.matchedPattern).toBeNull();
    }
  });

  it("wildcard pattern captured in matchedPattern", () => {
    const rule = makeRule("*.googleapis.com", "allow");
    const policy = makePolicy([rule], "block");
    const trie = buildTrie(policy);

    const result = matchPolicy(trie, policy, "oauth2.googleapis.com", null);
    expect(result.action).toBe("allow");
    expect(result.matchedPattern).toBe("*.googleapis.com");
  });
});
