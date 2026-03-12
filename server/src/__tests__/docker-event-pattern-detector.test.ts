import {
  DockerEventPatternDetector,
  type DockerContainerEvent,
} from "../lib/docker-event-pattern-detector";

// Mock logger
vi.mock("../lib/logger-factory", () => ({
  servicesLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function makeEvent(
  overrides: Partial<DockerContainerEvent> = {},
): DockerContainerEvent {
  return {
    action: "die",
    containerId: "abc123",
    containerName: "test-haproxy",
    labels: { "mini-infra.service": "haproxy" },
    time: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

describe("DockerEventPatternDetector", () => {
  it("does not trigger when events are below threshold", () => {
    const onDetected = vi.fn().mockResolvedValue(undefined);
    const detector = new DockerEventPatternDetector({
      name: "test",
      matchEvent: () => true,
      threshold: 3,
      windowMs: 60_000,
      cooldownMs: 300_000,
      onDetected,
    });

    detector.handleEvent(makeEvent());
    detector.handleEvent(makeEvent());

    expect(onDetected).not.toHaveBeenCalled();
  });

  it("triggers exactly once when threshold is reached", () => {
    const onDetected = vi.fn().mockResolvedValue(undefined);
    const detector = new DockerEventPatternDetector({
      name: "test",
      matchEvent: () => true,
      threshold: 3,
      windowMs: 60_000,
      cooldownMs: 300_000,
      onDetected,
    });

    detector.handleEvent(makeEvent());
    detector.handleEvent(makeEvent());
    detector.handleEvent(makeEvent());

    expect(onDetected).toHaveBeenCalledTimes(1);
    expect(onDetected).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ action: "die" }),
      ]),
    );
  });

  it("filters out non-matching events", () => {
    const onDetected = vi.fn().mockResolvedValue(undefined);
    const detector = new DockerEventPatternDetector({
      name: "test",
      matchEvent: (e) => e.action === "die",
      threshold: 2,
      windowMs: 60_000,
      cooldownMs: 300_000,
      onDetected,
    });

    detector.handleEvent(makeEvent({ action: "start" }));
    detector.handleEvent(makeEvent({ action: "start" }));
    detector.handleEvent(makeEvent({ action: "start" }));

    expect(onDetected).not.toHaveBeenCalled();

    // Now send matching events
    detector.handleEvent(makeEvent({ action: "die" }));
    detector.handleEvent(makeEvent({ action: "die" }));

    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it("prunes events outside the time window", () => {
    const onDetected = vi.fn().mockResolvedValue(undefined);
    const detector = new DockerEventPatternDetector({
      name: "test",
      matchEvent: () => true,
      threshold: 3,
      windowMs: 10_000, // 10 seconds
      cooldownMs: 300_000,
      onDetected,
    });

    const now = Math.floor(Date.now() / 1000);
    // Two events from 20 seconds ago (outside window)
    detector.handleEvent(makeEvent({ time: now - 20 }));
    detector.handleEvent(makeEvent({ time: now - 20 }));
    // One recent event
    detector.handleEvent(makeEvent({ time: now }));

    // Old events are pruned, only 1 recent event remains, below threshold
    expect(onDetected).not.toHaveBeenCalled();
  });

  it("respects cooldown period", async () => {
    const onDetected = vi.fn().mockResolvedValue(undefined);
    const detector = new DockerEventPatternDetector({
      name: "test",
      matchEvent: () => true,
      threshold: 2,
      windowMs: 60_000,
      cooldownMs: 300_000, // 5 minutes
      onDetected,
    });

    // First trigger
    detector.handleEvent(makeEvent());
    detector.handleEvent(makeEvent());
    expect(onDetected).toHaveBeenCalledTimes(1);

    // Wait for the handler promise to settle
    await vi.waitFor(() => {
      expect(onDetected).toHaveBeenCalledTimes(1);
    });

    // Second set of events — should be blocked by cooldown
    detector.handleEvent(makeEvent());
    detector.handleEvent(makeEvent());
    expect(onDetected).toHaveBeenCalledTimes(1);
  });

  it("reset() clears all state", async () => {
    const onDetected = vi.fn().mockResolvedValue(undefined);
    const detector = new DockerEventPatternDetector({
      name: "test",
      matchEvent: () => true,
      threshold: 2,
      windowMs: 60_000,
      cooldownMs: 300_000,
      onDetected,
    });

    // Trigger once
    detector.handleEvent(makeEvent());
    detector.handleEvent(makeEvent());
    expect(onDetected).toHaveBeenCalledTimes(1);

    // Wait for handler to settle
    await vi.waitFor(() => {
      expect(onDetected).toHaveBeenCalledTimes(1);
    });

    // Reset clears cooldown and buffer
    detector.reset();

    // Should trigger again after reset
    detector.handleEvent(makeEvent());
    detector.handleEvent(makeEvent());
    expect(onDetected).toHaveBeenCalledTimes(2);
  });
});
