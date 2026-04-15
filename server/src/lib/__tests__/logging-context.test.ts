import { describe, it, expect } from "vitest";
import {
  runWithContext,
  getContext,
  setUserId,
  setOperationId,
} from "../logging-context";

// Override the setup-file mock for this file, because we are testing the
// real implementation.
vi.unmock("../logging-context");

describe("logging-context", () => {
  it("returns undefined outside any scope", () => {
    expect(getContext()).toBeUndefined();
  });

  it("exposes the context inside runWithContext", () => {
    runWithContext({ requestId: "req-1" }, () => {
      expect(getContext()).toEqual({ requestId: "req-1" });
    });
  });

  it("merges nested scopes over the parent", () => {
    runWithContext({ requestId: "req-1", userId: "u-1" }, () => {
      runWithContext({ operationId: "op-1" }, () => {
        expect(getContext()).toEqual({
          requestId: "req-1",
          userId: "u-1",
          operationId: "op-1",
        });
      });
      // parent scope unchanged after nested scope exits
      expect(getContext()).toEqual({ requestId: "req-1", userId: "u-1" });
    });
  });

  it("lets a child scope override a parent field", () => {
    runWithContext({ requestId: "outer" }, () => {
      runWithContext({ requestId: "inner" }, () => {
        expect(getContext()?.requestId).toBe("inner");
      });
      expect(getContext()?.requestId).toBe("outer");
    });
  });

  it("mutates the current scope via setUserId / setOperationId", () => {
    runWithContext({ requestId: "req-2" }, () => {
      setUserId("u-42");
      setOperationId("op-42");
      expect(getContext()).toEqual({
        requestId: "req-2",
        userId: "u-42",
        operationId: "op-42",
      });
    });
  });

  it("setUserId outside a scope is a no-op", () => {
    setUserId("u-x");
    expect(getContext()).toBeUndefined();
  });
});
