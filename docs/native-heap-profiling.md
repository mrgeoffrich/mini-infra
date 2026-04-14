# Native Heap Profiling with heaptrack

Status: **proposal, not implemented**. Captures the plan so we can pick it up if/when we suspect a native memory leak.

## Context

The System Diagnostics page already exposes:

- V8 JS heap (used / total / limit / per-space) — covers JavaScript allocations.
- `process.memoryUsage()` — including External and ArrayBuffers (WASM linear memory, Node buffers).
- `/proc/self/status` and `/proc/self/smaps_rollup` — total RSS, PSS, private vs shared.
- Top smaps regions by pathname — attributes shared libraries and the node executable.
- On-demand strings peek into anonymous regions — peeks bytes to hint at content.

What's still opaque is **where native allocations come from** inside the big `[anon]` bucket. When every allocation is an `mmap(MAP_ANONYMOUS)` or a malloc arena page, the kernel and the JS heap snapshot are both blind to origin. If we ever hit suspicious RSS growth that isn't visible in the JS heap, we need call-site attribution.

## What heaptrack does

[heaptrack](https://github.com/KDE/heaptrack) is a sampling-free tracer that intercepts every `malloc` / `free` / `mmap` / `munmap` (plus new/delete) via `LD_PRELOAD`, records the C++ call stack, and writes a compressed trace. The GUI (`heaptrack_gui`) and CLI (`heaptrack_print`) give you:

- **Peak memory consumption** by call stack (flamegraph)
- **Memory leaked** (allocations never freed) by call stack
- **Allocation count hot spots** (often useful for GC pressure)
- **Temporary allocation** tracking
- A timeline slider so you can see how the heap grew

Overhead is typically 10–20% CPU and 1–2× memory during recording. Not something you leave on in production — it's a diagnostic mode.

## Running heaptrack in our container

### Installing in the image

The production image is Alpine-based (musl). heaptrack is available:

```dockerfile
# Dockerfile (opt-in heaptrack stage — do not ship in prod by default)
RUN apk add --no-cache heaptrack
```

Keep this behind a build arg (e.g. `ENABLE_HEAPTRACK=1`) so normal builds don't carry the tracer.

### Launching the server under heaptrack

Heaptrack works best when it wraps the process from the start (it hooks allocators via `LD_PRELOAD` before the program loads). Attach-to-running is possible but flaky, so prefer relaunching:

```sh
# Inside the container:
heaptrack --output /tmp/heaptrack.node node dist/server.js
```

This produces `/tmp/heaptrack.node.<pid>.gz`. When the process exits (or you send SIGINT), the trace is finalized and can be downloaded and analysed.

### Analysing the trace

- **GUI:** install `heaptrack` on your dev machine (`brew install kde-mac/kde/kf5-heaptrack` or the Linux package), then `heaptrack_gui heaptrack.node.<pid>.gz`. Best overview — flamegraphs, leak graph, timeline slider.
- **CLI:** `heaptrack_print heaptrack.node.<pid>.gz | less` for a text summary. Good for CI or quick peeks.

## Integration sketch

If we want to make this a one-click operation from the diagnostics page:

1. **Build**: a separate `Dockerfile.heaptrack` (or an `ENABLE_HEAPTRACK` build arg) that installs heaptrack in the image.
2. **Env flag**: `MINI_INFRA_HEAPTRACK=1` makes the entrypoint launch the server under `heaptrack` automatically and writes traces to a mounted volume.
3. **New endpoints**:
   - `POST /api/diagnostics/heaptrack/start` — starts a new recording (stops any prior one).
   - `POST /api/diagnostics/heaptrack/stop` — finalises the trace file.
   - `GET /api/diagnostics/heaptrack/download?id=...` — streams the `.gz`.
   - All three guarded by `settings:write`.
4. **UI**: two buttons on the diagnostics page: "Start heap recording" / "Stop & download". A banner at the top of the page notes when recording is active (perf cost reminder).

### Simpler alternative

If wiring start/stop end-to-end is too much, we can just document the manual flow:

```sh
# 1. rebuild the image with heaptrack baked in (or shell into the running container if it's already there)
docker exec -it mini-infra-dev sh

# 2. kill the existing server and relaunch under heaptrack
heaptrack --output /tmp/ht node /app/server/dist/server.js

# 3. hit the affected endpoints for a few minutes
# 4. SIGINT heaptrack to finalise the trace
# 5. docker cp the .gz out of the container
docker cp mini-infra-dev:/tmp/ht.node.<pid>.gz ./
# 6. open locally in heaptrack_gui
```

## Tradeoffs

- **Overhead.** 10–20% CPU, 1–2× RSS while recording. Fine for investigation, not for always-on.
- **Restart requirement.** Heaptrack needs `LD_PRELOAD` at process start; we have to relaunch the server to begin a trace.
- **Trace size.** A minute of recording against a busy process can produce 50–500 MB of compressed trace. Mount a volume; don't store in-image.
- **Symbol resolution.** Stacks resolve against the system's shared libraries at analysis time. Keep `-g` / debug symbols in the heaptrack image if you want readable C++ stacks (e.g. for V8 internals).
- **Alternatives.** If start/stop friction is too high for routine use, `bpftrace` can attach to `mmap`/`munmap` USDTs live without a restart, at the cost of less rich attribution. Good for catching sporadic growth.

## When to reach for this

- `[anon]` RSS is climbing over days and the V8 heap isn't (suggests a native leak — Node buffer pool, addon, or V8 C++ state).
- `malloced_memory` / `peak_malloced_memory` on the diagnostics page diverge over time.
- `heaptrack_print` is a 10-minute win vs. spending a day with gdb and a core dump.
