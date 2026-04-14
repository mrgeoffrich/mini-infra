import { open, readFile } from "fs/promises";

// All sizes returned are in bytes. /proc exposes kB by default; we convert.

export interface ProcStatus {
  vmPeak: number | null; // peak virtual memory
  vmSize: number | null; // current virtual memory
  vmHWM: number | null; // peak resident set size
  vmRSS: number | null; // current resident set size
  rssAnon: number | null; // anonymous RSS (heap, stacks)
  rssFile: number | null; // file-backed RSS (shared libs, mmap'd files)
  rssShmem: number | null; // shared memory RSS
  vmData: number | null; // data segment (heap + bss + anon)
  vmStk: number | null; // stack
  vmExe: number | null; // text segment (executable code)
  vmLib: number | null; // shared library code
  vmPTE: number | null; // page table entries
  vmSwap: number | null; // swapped-out pages
  threads: number | null;
}

export interface SmapsRollup {
  rss: number | null;
  pss: number | null;
  pssAnon: number | null;
  pssFile: number | null;
  pssShmem: number | null;
  sharedClean: number | null;
  sharedDirty: number | null;
  privateClean: number | null;
  privateDirty: number | null;
  referenced: number | null;
  anonymous: number | null;
  swap: number | null;
  swapPss: number | null;
  locked: number | null;
}

export interface SmapsRegionGroup {
  pathname: string;
  regions: number;
  rss: number;
  pss: number;
  size: number;
  privateDirty: number;
  sharedClean: number;
}

export interface SmapsRegion {
  start: string; // hex address, no "0x" prefix
  end: string;
  perms: string;
  pathname: string;
  size: number;
  rss: number;
  pss: number;
  privateDirty: number;
  sharedClean: number;
}

const kBRegex = /^(\d+)\s*kB$/i;

function parseKbValue(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = kBRegex.exec(raw.trim());
  if (!m) return null;
  return Number(m[1]) * 1024;
}

function parseColonKv(content: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of content.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    map.set(line.slice(0, idx).trim(), line.slice(idx + 1).trim());
  }
  return map;
}

export async function readProcStatus(): Promise<ProcStatus | null> {
  let content: string;
  try {
    content = await readFile("/proc/self/status", "utf8");
  } catch {
    return null;
  }
  const kv = parseColonKv(content);
  const threadsRaw = kv.get("Threads");
  return {
    vmPeak: parseKbValue(kv.get("VmPeak")),
    vmSize: parseKbValue(kv.get("VmSize")),
    vmHWM: parseKbValue(kv.get("VmHWM")),
    vmRSS: parseKbValue(kv.get("VmRSS")),
    rssAnon: parseKbValue(kv.get("RssAnon")),
    rssFile: parseKbValue(kv.get("RssFile")),
    rssShmem: parseKbValue(kv.get("RssShmem")),
    vmData: parseKbValue(kv.get("VmData")),
    vmStk: parseKbValue(kv.get("VmStk")),
    vmExe: parseKbValue(kv.get("VmExe")),
    vmLib: parseKbValue(kv.get("VmLib")),
    vmPTE: parseKbValue(kv.get("VmPTE")),
    vmSwap: parseKbValue(kv.get("VmSwap")),
    threads: threadsRaw ? Number(threadsRaw) : null,
  };
}

export async function readSmapsRollup(): Promise<SmapsRollup | null> {
  let content: string;
  try {
    content = await readFile("/proc/self/smaps_rollup", "utf8");
  } catch {
    return null;
  }
  const kv = parseColonKv(content);
  return {
    rss: parseKbValue(kv.get("Rss")),
    pss: parseKbValue(kv.get("Pss")),
    pssAnon: parseKbValue(kv.get("Pss_Anon")),
    pssFile: parseKbValue(kv.get("Pss_File")),
    pssShmem: parseKbValue(kv.get("Pss_Shmem")),
    sharedClean: parseKbValue(kv.get("Shared_Clean")),
    sharedDirty: parseKbValue(kv.get("Shared_Dirty")),
    privateClean: parseKbValue(kv.get("Private_Clean")),
    privateDirty: parseKbValue(kv.get("Private_Dirty")),
    referenced: parseKbValue(kv.get("Referenced")),
    anonymous: parseKbValue(kv.get("Anonymous")),
    swap: parseKbValue(kv.get("Swap")),
    swapPss: parseKbValue(kv.get("SwapPss")),
    locked: parseKbValue(kv.get("Locked")),
  };
}

// Each region in /proc/self/smaps starts with a header like:
//   7f0c1234-7f0c5678 r-xp 00000000 08:01 12345  /usr/lib/libssl.so.3
// ...followed by Size/Rss/Pss/...: N kB lines.
// Empty pathname = anonymous region. Pseudo-paths like [heap] and [stack] are preserved.
const REGION_HEADER = /^([0-9a-f]+)-([0-9a-f]+)\s+([rwxsp-]+)\s+\S+\s+\S+\s+\S+(?:\s+(.*))?$/;

export async function readSmapsRegions(): Promise<SmapsRegion[] | null> {
  let content: string;
  try {
    content = await readFile("/proc/self/smaps", "utf8");
  } catch {
    return null;
  }

  const regions: SmapsRegion[] = [];
  let current: SmapsRegion | null = null;

  for (const line of content.split("\n")) {
    const header = REGION_HEADER.exec(line);
    if (header) {
      current = {
        start: header[1],
        end: header[2],
        perms: header[3],
        pathname: (header[4] || "").trim() || "[anon]",
        size: 0,
        rss: 0,
        pss: 0,
        privateDirty: 0,
        sharedClean: 0,
      };
      regions.push(current);
      continue;
    }
    if (!current) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = parseKbValue(line.slice(colonIdx + 1));
    if (value === null) continue;

    if (key === "Rss") current.rss = value;
    else if (key === "Pss") current.pss = value;
    else if (key === "Size") current.size = value;
    else if (key === "Private_Dirty") current.privateDirty = value;
    else if (key === "Shared_Clean") current.sharedClean = value;
  }

  return regions;
}

export async function readSmapsByPathname(
  topN = 25,
): Promise<SmapsRegionGroup[] | null> {
  const regions = await readSmapsRegions();
  if (!regions) return null;

  const groups = new Map<string, SmapsRegionGroup>();
  for (const r of regions) {
    let g = groups.get(r.pathname);
    if (!g) {
      g = {
        pathname: r.pathname,
        regions: 0,
        rss: 0,
        pss: 0,
        size: 0,
        privateDirty: 0,
        sharedClean: 0,
      };
      groups.set(r.pathname, g);
    }
    g.regions += 1;
    g.rss += r.rss;
    g.pss += r.pss;
    g.size += r.size;
    g.privateDirty += r.privateDirty;
    g.sharedClean += r.sharedClean;
  }

  return Array.from(groups.values())
    .sort((a, b) => b.rss - a.rss)
    .slice(0, topN);
}

export interface PeekResult {
  address: string;
  bytesRead: number;
  truncated: boolean;
  strings: Array<{ offset: number; text: string }>;
  hexPreview: string;
  error?: string;
}

const MAX_PEEK_BYTES = 4 * 1024 * 1024; // 4 MiB cap per request
const MAX_STRINGS = 500;
const MAX_STRING_LEN = 256;

// Read a chunk of /proc/self/mem and extract printable ASCII strings, similar to strings(1).
// Requires a Linux host; returns null on non-Linux systems.
export async function peekMemoryRegion(
  startHex: string,
  length: number,
  options: { minLen?: number; maxStrings?: number } = {},
): Promise<PeekResult | null> {
  const minLen = Math.max(1, Math.min(64, options.minLen ?? 8));
  const maxStrings = Math.max(1, Math.min(MAX_STRINGS, options.maxStrings ?? 200));
  const readLen = Math.max(1, Math.min(MAX_PEEK_BYTES, length));
  const start = BigInt("0x" + startHex);

  let fd;
  try {
    fd = await open("/proc/self/mem", "r");
  } catch {
    return null;
  }

  const buffer = Buffer.alloc(readLen);
  let bytesRead = 0;
  let readError: string | undefined;
  try {
    const result = await fd.read(buffer, 0, readLen, start);
    bytesRead = result.bytesRead;
  } catch (err) {
    readError = err instanceof Error ? err.message : String(err);
  } finally {
    await fd.close().catch(() => {});
  }

  const strings: Array<{ offset: number; text: string }> = [];
  let current = "";
  let currentStart = -1;
  for (let i = 0; i < bytesRead; i++) {
    const b = buffer[i];
    const printable = (b >= 0x20 && b <= 0x7e) || b === 0x09;
    if (printable) {
      if (current.length === 0) currentStart = i;
      current += String.fromCharCode(b);
      if (current.length >= MAX_STRING_LEN) {
        strings.push({ offset: currentStart, text: current });
        current = "";
        if (strings.length >= maxStrings) break;
      }
    } else {
      if (current.length >= minLen) {
        strings.push({ offset: currentStart, text: current });
        if (strings.length >= maxStrings) break;
      }
      current = "";
    }
  }
  if (current.length >= minLen && strings.length < maxStrings) {
    strings.push({ offset: currentStart, text: current });
  }

  // First 256 bytes as hex preview, for a glanceable fingerprint of the region.
  const hexBytes = Math.min(bytesRead, 256);
  const hexPreview = buffer.subarray(0, hexBytes).toString("hex");

  return {
    address: "0x" + startHex,
    bytesRead,
    truncated: strings.length >= maxStrings,
    strings,
    hexPreview,
    error: readError,
  };
}
