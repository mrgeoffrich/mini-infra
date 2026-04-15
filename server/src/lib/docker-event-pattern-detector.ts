import { getLogger } from "./logger-factory";

export interface DockerContainerEvent {
  action: string;
  containerId: string;
  containerName: string;
  labels: Record<string, string>;
  time: number;
}

export interface PatternDetectorOptions {
  /** Descriptive name for logging */
  name: string;
  /** Predicate to filter relevant events */
  matchEvent: (event: DockerContainerEvent) => boolean;
  /** Number of matching events required to trigger */
  threshold: number;
  /** Sliding time window in milliseconds */
  windowMs: number;
  /** Cooldown period after triggering, in milliseconds */
  cooldownMs: number;
  /** Async callback fired when pattern is detected */
  onDetected: (events: DockerContainerEvent[]) => Promise<void>;
}

export class DockerEventPatternDetector {
  private buffer: DockerContainerEvent[] = [];
  private lastTriggeredAt = 0;
  private isHandling = false;
  private readonly logger = getLogger("docker", "docker-event-pattern-detector");

  constructor(private readonly options: PatternDetectorOptions) {}

  handleEvent(event: DockerContainerEvent): void {
    if (!this.options.matchEvent(event)) return;

    const now = Date.now();

    // Prune events outside the sliding window
    this.buffer = this.buffer.filter(
      (e) => now - e.time * 1000 < this.options.windowMs,
    );

    this.buffer.push(event);

    if (
      this.buffer.length >= this.options.threshold &&
      !this.isHandling &&
      now - this.lastTriggeredAt > this.options.cooldownMs
    ) {
      this.lastTriggeredAt = now;
      this.isHandling = true;
      const matched = [...this.buffer];
      this.buffer = [];

      this.logger.info(
        { detector: this.options.name, eventCount: matched.length },
        "Pattern detected, firing callback",
      );

      this.options
        .onDetected(matched)
        .catch((err) => {
          this.logger.error(
            { detector: this.options.name, error: err },
            "Pattern detector callback failed",
          );
        })
        .finally(() => {
          this.isHandling = false;
        });
    }
  }

  reset(): void {
    this.buffer = [];
    this.lastTriggeredAt = 0;
    this.isHandling = false;
  }
}
