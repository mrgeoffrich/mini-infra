import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const CYAN = '\x1b[0;36m';
const YELLOW = '\x1b[0;33m';
const GRAY = '\x1b[0;90m';
const NC = '\x1b[0m';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const LOG_FILE = path.join(SCRIPT_DIR, '..', 'worktree-env.log');
const MAX_BYTES = 200_000;
const KEEP_BYTES = 100_000;

let trimmed = false;

// Trim once per process: if the file is over MAX_BYTES, keep the last
// KEEP_BYTES (advancing past the next newline so the surviving content
// starts on a clean line). Soft cap — concurrent writers can briefly
// exceed MAX_BYTES; the next process trims it back.
function trimIfNeeded(): void {
  if (trimmed) return;
  trimmed = true;
  try {
    const st = fs.statSync(LOG_FILE);
    if (st.size <= MAX_BYTES) return;
    const fd = fs.openSync(LOG_FILE, 'r');
    try {
      const buf = Buffer.alloc(KEEP_BYTES);
      fs.readSync(fd, buf, 0, KEEP_BYTES, st.size - KEEP_BYTES);
      const nl = buf.indexOf(0x0a);
      const tail = nl >= 0 ? buf.subarray(nl + 1) : buf;
      fs.writeFileSync(LOG_FILE, tail);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // No file yet, or we couldn't read it — appendFileSync below will create one.
  }
}

function isoTs(): string {
  return new Date().toISOString();
}

function appendToFile(level: string, msg: string): void {
  try {
    trimIfNeeded();
    fs.appendFileSync(LOG_FILE, `${isoTs()} ${level} ${msg.replace(ANSI_RE, '')}\n`);
  } catch {
    // Disk full / permission denied — never let logging crash the script.
  }
}

function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function logInfo(msg: string): void {
  console.log(`${CYAN}[${ts()}] ${msg}${NC}`);
  appendToFile('INFO', msg);
}
export function logOk(msg: string): void {
  console.log(`${GREEN}[${ts()}] ${msg}${NC}`);
  appendToFile('OK  ', msg);
}
export function logWarn(msg: string): void {
  console.log(`${YELLOW}[${ts()}] ${msg}${NC}`);
  appendToFile('WARN', msg);
}
export function logError(msg: string): void {
  console.error(`${RED}[${ts()}] ${msg}${NC}`);
  appendToFile('ERR ', msg);
}
export function logSkip(msg: string): void {
  console.log(`${GRAY}[${ts()}] · ${msg}${NC}`);
  appendToFile('SKIP', msg);
}
