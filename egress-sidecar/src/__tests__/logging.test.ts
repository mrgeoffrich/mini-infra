import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DedupLogger, buildQueryLogEntry } from "../logging";

// ---------------------------------------------------------------------------
// Controlled clock
// ---------------------------------------------------------------------------

function makeClock(initial = 0): { now: () => number; advance: (ms: number) => void } {
  let t = initial;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

// ---------------------------------------------------------------------------
// Capture stdout lines
// ---------------------------------------------------------------------------

function captureStdout(): {
  lines: () => string[];
  restore: () => void;
} {
  const collected: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  const spy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation((chunk: unknown) => {
      if (typeof chunk === "string") {
        // Each write call is one JSON line (possibly with trailing \n).
        chunk
          .split("\n")
          .filter((l) => l.trim().length > 0)
          .forEach((l) => collected.push(l));
      }
      return true;
    });

  return {
    lines: () => [...collected],
    restore: () => {
      spy.mockRestore();
      // Suppress unused variable warning
      void original;
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueryEntry(overrides: Partial<ReturnType<typeof buildQueryLogEntry>> = {}) {
  return buildQueryLogEntry({
    srcIp: "172.30.0.10",
    qname: "api.openai.com",
    qtype: "A",
    action: "allowed",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DedupLogger — dedup windowing", () => {
  it("emits the first occurrence immediately", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry());
      const lines = capture.lines();
      expect(lines.length).toBe(1);
      const parsed = JSON.parse(lines[0]);
      expect(parsed.evt).toBe("dns.query");
      expect(parsed.mergedHits).toBe(1);
    } finally {
      dl.flush();
      capture.restore();
    }
  });

  it("suppresses a duplicate within the window — no new line emitted", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry()); // emitted immediately
      // Still within window (time hasn't advanced).
      dl.logQuery(makeQueryEntry()); // suppressed
      dl.logQuery(makeQueryEntry()); // suppressed

      expect(capture.lines().length).toBe(1);
      expect(dl.activeBuckets).toBe(1);
    } finally {
      dl.flush();
      capture.restore();
    }
  });

  it("different keys are not collapsed", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry({ srcIp: "10.0.0.1" }));
      dl.logQuery(makeQueryEntry({ srcIp: "10.0.0.2" }));

      expect(capture.lines().length).toBe(2);
    } finally {
      dl.flush();
      capture.restore();
    }
  });

  it("different qname makes different key — not collapsed", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry({ qname: "foo.com" }));
      dl.logQuery(makeQueryEntry({ qname: "bar.com" }));

      expect(capture.lines().length).toBe(2);
    } finally {
      dl.flush();
      capture.restore();
    }
  });

  it("different action makes different key — not collapsed", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry({ action: "allowed" }));
      dl.logQuery(makeQueryEntry({ action: "blocked" }));

      expect(capture.lines().length).toBe(2);
    } finally {
      dl.flush();
      capture.restore();
    }
  });

  it("flush on shutdown emits pending buckets with mergedHits", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry()); // emitted immediately (mergedHits=1)
      dl.logQuery(makeQueryEntry()); // hit 2 — suppressed
      dl.logQuery(makeQueryEntry()); // hit 3 — suppressed

      const beforeFlush = capture.lines().length;
      expect(beforeFlush).toBe(1);

      dl.flush(); // should emit summary with mergedHits=3

      const afterFlush = capture.lines();
      expect(afterFlush.length).toBe(2);
      const summary = JSON.parse(afterFlush[1]);
      expect(summary.mergedHits).toBe(3);
    } finally {
      capture.restore();
    }
  });

  it("after window expires, next identical query starts a new window", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry()); // emitted at t=0

      // Advance past the window.
      clock.advance(1001);

      dl.logQuery(makeQueryEntry()); // new window — should flush old and start new

      const lines = capture.lines();
      // First log + old window flush (hits=1, no extra summary since hits==1) + new log
      // When hits==1 in the expired bucket, no extra summary is emitted (nothing extra to report).
      // So we get 2 lines: first emit at t=0, second at t=1001.
      expect(lines.length).toBe(2);
      expect(JSON.parse(lines[1]).mergedHits).toBe(1);
    } finally {
      dl.flush();
      capture.restore();
    }
  });

  it("after window expires with multiple hits, emits summary then starts new window", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry()); // emitted at t=0, bucket starts (hits=1)
      dl.logQuery(makeQueryEntry()); // suppressed, hits=2
      dl.logQuery(makeQueryEntry()); // suppressed, hits=3

      clock.advance(1001); // window expired

      dl.logQuery(makeQueryEntry()); // new occurrence: flush old bucket (mergedHits=3 summary), start new

      const lines = capture.lines();
      // Line 0: first emit (mergedHits=1)
      // Line 1: expired bucket summary (mergedHits=3)
      // Line 2: new window first emit (mergedHits=1)
      expect(lines.length).toBe(3);
      expect(JSON.parse(lines[1]).mergedHits).toBe(3);
      expect(JSON.parse(lines[2]).mergedHits).toBe(1);
    } finally {
      dl.flush();
      capture.restore();
    }
  });
});

describe("DedupLogger — operational events", () => {
  it("operational events are never deduped", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      const opEntry = { ts: new Date().toISOString(), level: "info" as const, evt: "startup" };
      dl.logOperational(opEntry);
      dl.logOperational(opEntry);
      dl.logOperational(opEntry);

      expect(capture.lines().length).toBe(3);
      // activeBuckets should still be 0 — operational events don't go into buckets.
      expect(dl.activeBuckets).toBe(0);
    } finally {
      dl.flush();
      capture.restore();
    }
  });
});

describe("DedupLogger — flush clears buckets", () => {
  it("activeBuckets is 0 after flush", () => {
    const clock = makeClock(0);
    const capture = captureStdout();
    const dl = new DedupLogger(1000, clock);

    try {
      dl.logQuery(makeQueryEntry());
      expect(dl.activeBuckets).toBe(1);

      dl.flush();
      expect(dl.activeBuckets).toBe(0);
    } finally {
      capture.restore();
    }
  });
});
