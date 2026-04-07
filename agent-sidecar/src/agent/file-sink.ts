import { appendFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { TapMessage } from "@mrgeoffrich/claude-agent-sdk-tap";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// NDJSON file sink — writes every SDK message to a per-turn log file
// ---------------------------------------------------------------------------

const LOG_DIR = process.env.AGENT_LOG_DIR ?? "/tmp/agent-logs";

export interface FileSink {
  /** Pass to the tap's `onMessage` callback. */
  send: (message: TapMessage) => void;
  /** Flush buffered writes. Call in `finally` to avoid data loss. */
  flush: () => Promise<void>;
}

interface Envelope {
  seq: number;
  ts: string;
  type: string;
  message: TapMessage;
}

export function createFileSink(turnId: string): FileSink {
  const filePath = path.join(LOG_DIR, `${turnId}.ndjson`);
  let seq = 0;
  let pending: Promise<void> = Promise.resolve();
  let dirReady = false;

  async function ensureDir(): Promise<void> {
    if (dirReady) return;
    if (!existsSync(LOG_DIR)) {
      await mkdir(LOG_DIR, { recursive: true });
    }
    dirReady = true;
  }

  function send(message: TapMessage): void {
    const envelope: Envelope = {
      seq: seq++,
      ts: new Date().toISOString(),
      type: (message as Record<string, unknown>).type as string,
      message,
    };

    const line = JSON.stringify(envelope) + "\n";

    // Chain writes so they stay ordered and non-blocking
    pending = pending
      .then(() => ensureDir())
      .then(() => appendFile(filePath, line, "utf-8"))
      .catch((err) => {
        logger.warn({ err, turnId }, "Failed to write agent message log");
      });
  }

  async function flush(): Promise<void> {
    await pending;
  }

  return { send, flush };
}
