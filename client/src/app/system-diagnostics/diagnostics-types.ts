export interface ProcStatus {
  vmPeak: number | null;
  vmSize: number | null;
  vmHWM: number | null;
  vmRSS: number | null;
  rssAnon: number | null;
  rssFile: number | null;
  rssShmem: number | null;
  vmData: number | null;
  vmStk: number | null;
  vmExe: number | null;
  vmLib: number | null;
  vmPTE: number | null;
  vmSwap: number | null;
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

export interface ResourceUsage {
  userCPUTime: number;
  systemCPUTime: number;
  maxRSS: number;
  sharedMemorySize: number;
  unsharedDataSize: number;
  unsharedStackSize: number;
  minorPageFault: number;
  majorPageFault: number;
  swappedOut: number;
  fsRead: number;
  fsWrite: number;
  ipcSent: number;
  ipcReceived: number;
  signalsCount: number;
  voluntaryContextSwitches: number;
  involuntaryContextSwitches: number;
}

export interface MemoryDiagnostics {
  timestamp: string;
  uptimeSeconds: number;
  pid: number;
  nodeVersion: string;
  platform: string;
  process: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  heap: {
    totalHeapSize: number;
    totalHeapSizeExecutable: number;
    totalPhysicalSize: number;
    totalAvailableSize: number;
    usedHeapSize: number;
    heapSizeLimit: number;
    mallocedMemory: number;
    peakMallocedMemory: number;
    numberOfNativeContexts: number;
    numberOfDetachedContexts: number;
  };
  heapSpaces: Array<{
    name: string;
    size: number;
    used: number;
    available: number;
    physical: number;
  }>;
  resourceUsage: ResourceUsage;
  procStatus: ProcStatus | null;
  smapsRollup: SmapsRollup | null;
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

export interface SmapsTopResponse {
  limit: number;
  groups: SmapsRegionGroup[];
}

export interface SmapsRegion {
  start: string;
  end: string;
  perms: string;
  pathname: string;
  size: number;
  rss: number;
  pss: number;
  privateDirty: number;
  sharedClean: number;
}

export interface SmapsRegionsResponse {
  pathname: string | null;
  limit: number;
  regions: SmapsRegion[];
}

export interface PeekResult {
  address: string;
  bytesRead: number;
  truncated: boolean;
  strings: Array<{ offset: number; text: string }>;
  hexPreview: string;
  error?: string;
}
