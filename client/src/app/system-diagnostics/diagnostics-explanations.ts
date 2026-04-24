export const PROCESS_EXPLANATIONS: Record<string, string> = {
  RSS: "Resident Set Size — total RAM the process holds, including heap, code, stacks, and native allocations.",
  "Heap used": "JavaScript objects currently alive in the V8 heap.",
  "Heap total": "Size V8 has committed for the heap; grows as needed up to the limit.",
  External:
    "Memory held by C++ objects bound to JS (Buffers, native addons, etc.) — lives outside the V8 heap.",
  "Array buffers":
    "Bytes allocated for ArrayBuffers / SharedArrayBuffers. Counted within External.",
};

export const HEAP_EXPLANATIONS: Record<string, string> = {
  Used: "Live JS objects in the heap right now.",
  Total: "Committed heap size — what V8 has reserved from the OS.",
  Physical:
    "Heap pages actually backed by RAM. Can be lower than Total if pages were released.",
  Available: "Headroom before hitting the heap size limit.",
  Limit:
    "Maximum heap V8 will grow to (controlled by --max-old-space-size). OOM crashes happen past this.",
  Malloced: "V8's current internal C++ allocations (metadata, parser state, etc.).",
  "Peak malloced": "Highest malloced value since process start — useful for spotting transient spikes.",
  "Native contexts":
    "Top-level JS contexts. Normally 1. Growing numbers usually indicate leaked vm/iframe contexts.",
};

export const HEAP_SPACE_EXPLANATIONS: Record<string, string> = {
  read_only_space: "Immutable V8 internals (builtins, snapshots). Shared, never GC'd.",
  new_space:
    "Young generation — where new allocations land. Collected frequently (scavenge GC).",
  old_space: "Objects that survived enough young GCs to be promoted. Collected by mark-sweep.",
  code_space: "JIT-compiled machine code for hot JS functions.",
  shared_space: "Objects shared across isolates (worker threads).",
  trusted_space: "V8 internal objects treated as trusted (sandbox-related).",
  shared_trusted_space: "Trusted objects shared across isolates.",
  new_large_object_space:
    "Large allocations (≥~500 KB) made in the young generation — too big for new_space.",
  large_object_space: "Large allocations in the old generation.",
  code_large_object_space: "Oversized compiled code objects.",
  shared_large_object_space: "Large shared objects across isolates.",
  shared_trusted_large_object_space: "Large trusted shared objects.",
  trusted_large_object_space: "Large trusted objects.",
};

export const PROC_STATUS_EXPLANATIONS: Record<string, string> = {
  VmRSS: "Resident set — RAM pages currently held by the process. Should match RSS above.",
  VmHWM: "High-water mark — peak RSS since the process started.",
  RssAnon: "Anonymous RSS — JS heap, native heap (Prisma, etc.), and thread stacks.",
  RssFile: "File-backed RSS — shared libraries and mmap'd files currently paged in.",
  RssShmem: "Shared-memory RSS (tmpfs / /dev/shm mappings).",
  VmData: "Data segment — writable heap + anonymous pages committed to the process.",
  VmStk: "Total stack space across all threads.",
  VmExe: "Text segment — the node executable's code mapped into memory.",
  VmLib: "Shared library code mapped in (libssl, libc, Prisma query engine, etc.).",
  VmSize: "Total virtual address space reserved (much larger than RSS; most is unresident).",
  VmPeak: "Largest VmSize ever reached by the process.",
  VmSwap: "Pages swapped out to disk.",
  VmPTE: "Kernel memory used to track this process's page tables.",
  Threads: "Number of OS threads the process currently has.",
};

export const SMAPS_ROLLUP_EXPLANATIONS: Record<string, string> = {
  RSS: "Same as VmRSS — total resident pages.",
  PSS: "Proportional Set Size — your 'fair share' of RAM. Shared pages are divided by the number of processes sharing them.",
  "PSS Anon": "PSS attributable to anonymous pages (heaps + stacks).",
  "PSS File": "PSS attributable to file-backed pages (shared libraries, mmap'd files).",
  "PSS Shmem": "PSS attributable to shared-memory pages.",
  "Shared Clean":
    "Pages shared with other processes and unchanged since mapped (e.g. libc code). Cheap — cost is shared.",
  "Shared Dirty": "Shared writable pages that have been modified (rare outside shmem).",
  "Private Clean":
    "Pages private to this process and unchanged since mapped (e.g. your copy of a read-only lib).",
  "Private Dirty":
    "Pages private to this process and modified. This is unambiguously your own memory cost.",
  Anonymous: "Anonymous pages (not backed by any file) currently in RAM.",
  Referenced: "Pages marked as recently accessed by the kernel's page-replacement algorithm.",
  Swap: "Pages swapped out to disk.",
};

export const RESOURCE_USAGE_EXPLANATIONS: Record<string, string> = {
  "Max RSS": "Peak RSS ever reached by the process (from getrusage).",
  "User CPU": "Total CPU time spent in user-space code.",
  "System CPU": "Total CPU time spent in kernel-space (syscalls, I/O).",
  "Minor page faults":
    "Page faults resolved without disk I/O (page was already in memory or freshly allocated).",
  "Major page faults":
    "Page faults that required reading from disk — slow. High numbers suggest swapping or cold mmap'd files.",
  "Voluntary ctx switches":
    "Times the process yielded the CPU (waiting on I/O, locks, etc.).",
  "Involuntary ctx switches":
    "Times the kernel preempted the process (CPU contention, time slice expired).",
  "FS reads": "Number of reads from the filesystem performed on behalf of this process.",
  "FS writes": "Number of writes to the filesystem performed on behalf of this process.",
  "IPC sent": "Messages sent over IPC channels (Unix signals, pipes).",
  "IPC received": "Messages received over IPC channels.",
  Signals: "Signals received (SIGTERM, SIGUSR1, etc.).",
  "Swapped out": "Times the process (or pages) were swapped to disk.",
};
