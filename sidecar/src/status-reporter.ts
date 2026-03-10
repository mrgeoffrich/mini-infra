import fs from "fs";
import path from "path";
import { logger } from "./logger";

export type UpdateState =
  | "pulling"
  | "inspecting"
  | "stopping"
  | "creating"
  | "health-checking"
  | "complete"
  | "rolling-back"
  | "rollback-complete"
  | "failed";

export interface UpdateStatus {
  state: UpdateState;
  targetTag?: string;
  progress?: number;
  error?: string;
  startedAt: string;
  updatedAt: string;
}

export class StatusReporter {
  private readonly statusFilePath: string;
  private readonly startedAt: string;

  constructor(statusFilePath: string) {
    this.statusFilePath = statusFilePath;
    this.startedAt = new Date().toISOString();

    // Ensure the directory exists
    const dir = path.dirname(this.statusFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  report(
    state: UpdateState,
    extra?: { targetTag?: string; progress?: number; error?: string },
  ): void {
    const status: UpdateStatus = {
      state,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      ...extra,
    };

    logger.info({ state, ...extra }, `Update status: ${state}`);

    try {
      fs.writeFileSync(this.statusFilePath, JSON.stringify(status, null, 2));
    } catch (err) {
      logger.error({ err }, "Failed to write status file");
    }
  }
}
