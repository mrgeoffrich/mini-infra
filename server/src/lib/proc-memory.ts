import { readFile } from "fs/promises";

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

export async function readSmapsByPathname(
  topN = 25,
): Promise<SmapsRegionGroup[] | null> {
  let content: string;
  try {
    content = await readFile("/proc/self/smaps", "utf8");
  } catch {
    return null;
  }

  const groups = new Map<string, SmapsRegionGroup>();
  let current: { path: string } | null = null;

  const getOrCreate = (path: string): SmapsRegionGroup => {
    let g = groups.get(path);
    if (!g) {
      g = {
        pathname: path,
        regions: 0,
        rss: 0,
        pss: 0,
        size: 0,
        privateDirty: 0,
        sharedClean: 0,
      };
      groups.set(path, g);
    }
    return g;
  };

  for (const line of content.split("\n")) {
    const header = REGION_HEADER.exec(line);
    if (header) {
      const path = (header[4] || "").trim() || "[anon]";
      current = { path };
      getOrCreate(path).regions += 1;
      continue;
    }
    if (!current) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = parseKbValue(line.slice(colonIdx + 1));
    if (value === null) continue;

    const g = getOrCreate(current.path);
    if (key === "Rss") g.rss += value;
    else if (key === "Pss") g.pss += value;
    else if (key === "Size") g.size += value;
    else if (key === "Private_Dirty") g.privateDirty += value;
    else if (key === "Shared_Clean") g.sharedClean += value;
  }

  return Array.from(groups.values())
    .sort((a, b) => b.rss - a.rss)
    .slice(0, topN);
}
