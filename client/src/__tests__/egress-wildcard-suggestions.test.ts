/**
 * Unit tests for the wildcard collapse suggestion algorithm.
 */

import { describe, it, expect } from "vitest";
import { computeWildcardSuggestions } from "@/lib/egress-wildcard-suggestions";

describe("computeWildcardSuggestions", () => {
  it("suggests a wildcard when ≥3 distinct children share a parent suffix", () => {
    const destinations = [
      "auth.googleapis.com",
      "oauth2.googleapis.com",
      "storage.googleapis.com",
    ];
    const { suggestions } = computeWildcardSuggestions(destinations);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].pattern).toBe("*.googleapis.com");
    expect(suggestions[0].covers).toEqual([
      "auth.googleapis.com",
      "oauth2.googleapis.com",
      "storage.googleapis.com",
    ]);
  });

  it("does NOT suggest a wildcard for fewer than 3 children", () => {
    const destinations = [
      "auth.googleapis.com",
      "oauth2.googleapis.com",
    ];
    const { suggestions, uncovered } = computeWildcardSuggestions(destinations);
    expect(suggestions).toHaveLength(0);
    expect(uncovered).toHaveLength(2);
  });

  it("does NOT suggest a wildcard for a single-label parent (TLD floor)", () => {
    // parent of "foo.com" is "com" — one label, should not be proposed
    const destinations = [
      "foo.com",
      "bar.com",
      "baz.com",
    ];
    const { suggestions } = computeWildcardSuggestions(destinations);
    expect(suggestions).toHaveLength(0);
  });

  it("requires the parent to have ≥2 labels (eTLD+1 floor)", () => {
    // "co.uk" has two labels but is an eTLD+1 — the 2-label minimum still
    // allows it since we do a simple count check, not a PSL lookup.
    // This test verifies the label count logic itself.
    const destinations = [
      "a.example.co.uk",
      "b.example.co.uk",
      "c.example.co.uk",
    ];
    // parent of each is "example.co.uk" which has 3 labels → should suggest
    const { suggestions } = computeWildcardSuggestions(destinations);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].pattern).toBe("*.example.co.uk");
  });

  it("excludes already-covered destinations from the uncovered list", () => {
    const destinations = [
      "api.stripe.com",
      "checkout.stripe.com",   // these two alone won't trigger a wildcard
    ];
    const existingRules = ["*.stripe.com"];
    const { uncovered } = computeWildcardSuggestions(destinations, existingRules);
    // Both are covered by the existing wildcard rule
    expect(uncovered).toHaveLength(0);
  });

  it("excludes exact-match existing rules from uncovered", () => {
    const destinations = ["api.stripe.com"];
    const existingRules = ["api.stripe.com"];
    const { uncovered } = computeWildcardSuggestions(destinations, existingRules);
    expect(uncovered).toHaveLength(0);
  });

  it("places destinations not collapsed and not covered in uncovered list", () => {
    const destinations = [
      "auth.googleapis.com",
      "oauth2.googleapis.com",
      "storage.googleapis.com",
      "api.stripe.com",        // only one stripe dest — not collapsed
    ];
    const { suggestions, uncovered } = computeWildcardSuggestions(destinations);
    expect(suggestions[0].pattern).toBe("*.googleapis.com");
    expect(uncovered).toContain("api.stripe.com");
    expect(uncovered).not.toContain("auth.googleapis.com");
  });

  it("deduplicates destinations before processing", () => {
    const destinations = [
      "auth.googleapis.com",
      "auth.googleapis.com",  // duplicate
      "oauth2.googleapis.com",
      "storage.googleapis.com",
    ];
    const { suggestions } = computeWildcardSuggestions(destinations);
    // Should still produce exactly one suggestion for googleapis.com
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].covers).toHaveLength(3);
  });

  it("handles empty destinations gracefully", () => {
    const { suggestions, uncovered } = computeWildcardSuggestions([]);
    expect(suggestions).toHaveLength(0);
    expect(uncovered).toHaveLength(0);
  });

  it("allows a custom threshold", () => {
    const destinations = ["a.example.com", "b.example.com"];
    // With threshold=2 this should suggest a wildcard
    const { suggestions } = computeWildcardSuggestions(destinations, [], 2);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].pattern).toBe("*.example.com");
  });

  it("does not suggest wildcard for single-label hostnames (no parent)", () => {
    const destinations = ["localhost", "gateway", "myhost"];
    const { suggestions, uncovered } = computeWildcardSuggestions(destinations);
    expect(suggestions).toHaveLength(0);
    expect(uncovered).toHaveLength(3);
  });

  it("returns suggestions sorted by covers (covers is alphabetically sorted)", () => {
    const destinations = [
      "z.example.com",
      "a.example.com",
      "m.example.com",
    ];
    const { suggestions } = computeWildcardSuggestions(destinations);
    expect(suggestions[0].covers).toEqual([
      "a.example.com",
      "m.example.com",
      "z.example.com",
    ]);
  });
});
