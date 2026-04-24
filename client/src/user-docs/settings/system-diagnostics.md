---
title: System Diagnostics
description: How to read server memory statistics and capture diagnostic artifacts from the System Diagnostics page in Mini Infra.
tags:
  - settings
  - diagnostics
  - memory
  - administration
---

# System Diagnostics

The System Diagnostics page exposes live memory telemetry for the Mini Infra server process. Use it to monitor heap health, understand memory growth over time, and capture snapshots for deeper analysis in external tools.

Data refreshes automatically every 5 seconds. Toggle **Show explanations** to add inline descriptions to each metric.

## Process Memory Overview

The **Process** section shows the top-level Node.js memory figures reported by `process.memoryUsage()`:

| Metric | What it means |
|--------|--------------|
| `RSS` | Total RAM the process holds — heap, code, stacks, and native allocations. |
| `Heap used` | JavaScript objects currently alive in the V8 heap. |
| `Heap total` | Memory V8 has committed for the heap; grows as needed up to the limit. |
| `External` | Memory held by C++ objects (Buffers, native addons) outside the V8 heap. |
| `Array buffers` | Bytes allocated for `ArrayBuffer`/`SharedArrayBuffer` objects. |

## Linux Process Memory

On Linux (the normal container environment), the **Linux Process Memory** section reads `/proc/self/status` to break down where RSS goes beyond the V8 heap:

| Metric | What it means |
|--------|--------------|
| `VmRSS` | Resident set — RAM pages currently held. Should match RSS above. |
| `VmHWM` | High-water mark — peak RSS since process start. |
| `RssAnon` | Anonymous RSS — JS heap, native heap, and thread stacks. |
| `RssFile` | File-backed RSS — shared libraries and mmap'd files currently paged in. |
| `VmData` | Data segment — writable heap and anonymous pages committed to the process. |
| `VmStk` | Total stack space across all threads. |
| `VmLib` | Shared library code mapped in (libssl, libc, Prisma query engine, etc.). |
| `VmSwap` | Pages swapped out to disk. |
| `Threads` | Number of OS threads the process currently has. |

This section is hidden on non-Linux platforms.

## Shared vs Private Memory

The **Shared vs Private Memory** section reads `/proc/self/smaps_rollup` to split RSS into shared and private pages:

| Metric | What it means |
|--------|--------------|
| `RSS` | Total resident pages (same as VmRSS). |
| `PSS` | Proportional Set Size — your "fair share" of RAM. Shared pages are divided by how many processes share them. |
| `Private Dirty` | Pages private to this process and modified. This is your unambiguous memory cost. |
| `Private Clean` | Pages private to this process but unchanged since mapping. |
| `Shared Clean` | Pages shared with other processes and unchanged (e.g. libc code). |
| `Swap` | Pages swapped out to disk. |

## V8 Heap

The **V8 Heap** section shows the V8 garbage collector's view of the JavaScript heap:

| Metric | What it means |
|--------|--------------|
| `Used` | Live JS objects in the heap right now. |
| `Total` | Committed heap size — what V8 has reserved from the OS. |
| `Physical` | Heap pages actually backed by RAM. Can be lower than Total. |
| `Available` | Headroom before hitting the heap size limit. |
| `Limit` | Maximum heap V8 will grow to. Out-of-memory crashes happen past this. |
| `Native contexts` | Top-level JS contexts. Normally 1; growing numbers suggest leaked contexts. |

If `numberOfDetachedContexts` is greater than zero, a warning appears in the card header — this usually indicates a memory leak.

## Heap Spaces

The **Heap Spaces** table breaks the V8 heap into its internal allocation areas:

| Space | Purpose |
|-------|---------|
| `new_space` | Young generation — new allocations land here, collected frequently. |
| `old_space` | Objects promoted from new_space; collected by mark-sweep. |
| `code_space` | JIT-compiled machine code for hot JavaScript functions. |
| `large_object_space` | Allocations too large for new_space or old_space. |
| `read_only_space` | Immutable V8 internals (builtins, snapshots). Never garbage collected. |

## Resource Usage

The **Resource Usage** section shows cumulative process-lifetime statistics from `getrusage()`:

| Metric | What it means |
|--------|--------------|
| `Max RSS` | Peak RSS ever reached by the process. |
| `User CPU` | Total CPU time spent in user-space code. |
| `System CPU` | Total CPU time spent in kernel-space (syscalls, I/O). |
| `Minor page faults` | Page faults resolved without disk I/O. |
| `Major page faults` | Page faults that required reading from disk — high numbers suggest swapping. |
| `Voluntary ctx switches` | Times the process yielded the CPU (waiting on I/O or locks). |
| `Involuntary ctx switches` | Times the kernel preempted the process (CPU contention). |
| `FS reads / writes` | Filesystem I/O operations performed on behalf of this process. |

## Top Contributors to RSS

Click **Load** in the **Top Contributors to RSS** section to aggregate `/proc/self/smaps` by mapped pathname. This identifies which shared libraries and memory-mapped files account for the most resident memory.

The table shows the top 25 pathnames ranked by RSS, with columns for PSS, Private Dirty, and virtual Size. Once loaded, the table refreshes every 10 seconds.

## Inspect Memory Region

The **Inspect Memory Region** section lets you drill into a specific pathname's memory regions and peek at their raw contents via `/proc/self/mem`. This is useful for guessing what is living in anonymous memory — SQL query text, JSON payloads, identifier patterns, and similar data often appear as readable strings.

1. Select a pathname from the dropdown (defaults to `[anon]` — the bulk of anonymous RSS).
2. Click **Find regions** to list the top regions by RSS.
3. Click **Peek** on any region to read up to 2 MB of its content and extract printable strings (minimum length 8).

The peek result shows a hex preview of the first 256 bytes and a table of extracted strings with their byte offsets.

## Downloading Diagnostic Artifacts

Two downloadable artifacts are available from the top toolbar:

| Button | Output |
|--------|--------|
| **Download report** | A JSON file listing shared objects, libuv handles, and native stack info. Useful for attaching to bug reports. |
| **Download heap snapshot** | A `.heapsnapshot` file for analysis in Chrome DevTools → Memory tab. |

## What to watch out for

- **Heap snapshots pause the event loop.** The capture briefly freezes the server while V8 writes the snapshot. Avoid capturing during high-traffic periods. Snapshot files are typically tens to hundreds of MB.
- **Memory region peek reads raw process memory.** Returned strings may include query text, session tokens, or other sensitive data held in caches. Treat the output as sensitive.
- **Linux-only sections are hidden on other platforms.** The Linux Process Memory, Shared vs Private Memory, Top Contributors to RSS, and Inspect Memory Region sections only appear when running in a Linux container. A notice is shown when this is the case.
- **Resource usage is cumulative.** The CPU and I/O counters count from process start, not from the last page load. Use them for trend analysis, not point-in-time snapshots.
