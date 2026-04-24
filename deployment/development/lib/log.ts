const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const CYAN = '\x1b[0;36m';
const YELLOW = '\x1b[0;33m';
const GRAY = '\x1b[0;90m';
const NC = '\x1b[0m';

function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function logInfo(msg: string): void {
  console.log(`${CYAN}[${ts()}] ${msg}${NC}`);
}
export function logOk(msg: string): void {
  console.log(`${GREEN}[${ts()}] ${msg}${NC}`);
}
export function logWarn(msg: string): void {
  console.log(`${YELLOW}[${ts()}] ${msg}${NC}`);
}
export function logError(msg: string): void {
  console.error(`${RED}[${ts()}] ${msg}${NC}`);
}
export function logSkip(msg: string): void {
  console.log(`${GRAY}[${ts()}] · ${msg}${NC}`);
}
