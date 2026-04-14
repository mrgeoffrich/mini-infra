# Memory Analysis — 2026-04-14

A point-in-time analysis of the Mini Infra server process, using the data exposed by the System Diagnostics page and the `/api/diagnostics/region-peek` endpoint. Intended as a worked example of how to read the page, and as a baseline snapshot to compare future measurements against.

## Sample conditions

- Environment: local Docker dev deployment (Alpine/musl, ARM64)
- Uptime at sample: 159 s (just past cold-start)
- Node: v24.13.1
- Prisma: 7.7.0 with `@prisma/adapter-better-sqlite3` (no Rust query engine — WASM + JS)

## Top-line numbers

| Metric | Value |
|---|---|
| RSS | 485 MB |
| Peak RSS (VmHWM) | 581 MB |
| VmSize (virtual) | 30.4 GB |
| RssAnon / RssFile | 417 MB / 69 MB |
| PSS / RSS | 94% |
| V8 heap used / total / limit | 126 MB / 204 MB / 2.24 GB |
| External + ArrayBuffers | 25 MB + 52 MB |
| Threads | 23 |
| Detached contexts / Native contexts | 0 / 1 |
| Major page faults / Swap | 0 / 0 |

## Where every byte is

| Bucket | RSS | % of RSS | Source |
|---|---:|---:|---|
| **V8 JS heap** (committed) | 204 MB | 42% | `totalPhysicalSize` — actual heap pages across new/old/large/code/trusted spaces |
| **V8 JIT code pages** (`rwxp` anon) | ~14 MB | 3% | 3 regions of ARM64 machine code, confirmed via peek |
| **External + ArrayBuffers** | ~52 MB | 11% | Node Buffers + Prisma WASM linear memory |
| **node binary mapped** (`/usr/local/bin/node`) | 65 MB | 13% | Text + read-only data |
| **Shared libraries** (libstdc++, libc, libgcc) | 3 MB | 0.5% | musl + C++ runtime |
| **Native addons** (better-sqlite3, argon2) | 2 MB | 0.4% | `.node` files mapped |
| **Remaining `[anon]`** | ~145 MB | 30% | musl allocator retention, native-addon heaps, thread arenas, V8 metadata |
| **Misc** (`[heap]`, `[stack]`, `[vdso]`, db-shm) | 0.4 MB | — | |
| **Total** | **485 MB** | | |

### V8's share is bigger than it looks

Once you combine the direct heap with JIT code and the ArrayBuffers V8 owns the backing store for, V8 accounts for **~270 MB (56% of RSS)**:

- 204 MB committed heap (126 MB used + 78 MB reserved headroom)
- ~14 MB JIT code pages
- Most of the 52 MB ArrayBuffers (WASM linear memory + Node Buffer pool)
- Peak `malloced_memory` hit 78 MB during startup (parser/compiler scratch); current is 1.1 MB, but the allocator retains freed pages — those pages show up as anon RSS with no live owner.

## Concrete findings from peeking top `[anon]` regions

Top 15 anonymous regions by RSS account for only ~45 MB of the 415 MB total — the distribution has a long tail of 1574 small-to-medium regions (mostly V8 heap pages at ~512 KB granularity). The largest regions, with a clue from each peek:

| RSS | Perms | Hex preview | First string | What it is |
|---:|---|---|---|---|
| 5.2 MB | `rwxp` | `8401600000000000` | (none) | V8 JIT code cache |
| 5.0 MB | `rwxp` | `0000000000000000` | (none) | V8 JIT code cache (partially zeroed) |
| 4.7 MB | `rw-p` | — | `AGFzbQEAAAAB…` | **Prisma WASM query engine as base64 JS string** (`\0asm\1\0\0\0` in base64) |
| 3.9 MB | `rw-p` | `00…00` | (none) | V8 old_space page |
| 3.7 MB | `rw-p` | `28894cf7aaaa0000` | `H,H(H(H(H(@` | V8 string/handle table internals |
| 3.5 MB | `rwxp` | `c40004cb5f0004eb` | (none) | V8 JIT code cache |
| 2–3 MB × many | `rw-p` | `00…00` | (none) | V8 new/old/large-object space pages |

The Prisma WASM source finding is especially illustrative: the WASM binary is ~1.6 MB, but Prisma currently loads it as a base64 string (inflates to ~2.1 MB) and V8 stores JS strings as UTF-16 internally (~4.3 MB), plus allocation overhead — lands at 4.7 MB in a single region. It's held twice in memory: once as this JS string (for the loader), and once as the live `WebAssembly.Memory` linear buffer (counted under ArrayBuffers).

## Health indicators — no leak

| Signal | Value | Verdict |
|---|---|---|
| Detached contexts | 0 | Clean |
| Native contexts | 1 | Clean (multiple = iframe/vm leak) |
| Major page faults | 0 | No swap pressure |
| Swap used | 0 B | None |
| Peak RSS (VmHWM) vs current | 581 → 485 MB | **Went down** 96 MB from peak — healthy post-warmup shrinkage |
| Peak malloced vs current | 78 MB → 1.1 MB | V8 released internal scratch |
| PSS / RSS | 94% | Very little is shared (expected for single-process app) |
| Involuntary ctx switches / total | 218 / 62k | Almost entirely voluntary I/O waits — no CPU contention |

The process grew to 581 MB during startup (JS parsing, compilation, WASM instantiation, Prisma client init) and has since shrunk to 485 MB. That's the exact profile of a healthy warming-up Node app.

## Levers for meaningful RSS reduction (if ever needed)

Ranked by plausibility:

1. **Tune V8 heap** with `--max-semi-space-size=32` and/or `--max-old-space-size=<lower>`. `new_space` is currently 101 MB committed; capping semi-space could save ~30–40 MB steady-state. Low risk, easy to revert.
2. **Load Prisma WASM as bytes, not base64**. If the `prisma-client` generator exposes an option to embed the module as a `Uint8Array` instead of a base64 string, we save ~5 MB of JS heap. Cosmetic but clean.
3. **Reduce libuv worker pool** via `UV_THREADPOOL_SIZE` if 4 workers is more than we need. Saves ~5–10 MB of anon pages. Usually not worth the complexity unless profiling shows they sit idle.
4. **musl allocator tuning** (`mallopt`) is rarely worth the effort; the returns are small and behaviour is fragile.

## Bottom line

The server runs at ~485 MB with no leak signals. V8 owns about 56% of that (heap + JIT + WASM backing store) — matches intuition for a moderately-sized Node.js app with a WASM query engine. The remaining 30% of `[anon]` is the normal long tail: musl allocator pages retained after startup bursts, native-addon heaps (better-sqlite3 page cache, etc.), and thread arenas.

Nothing here is actionable unless we deliberately want to squeeze memory — in which case the V8 heap knobs in §levers are where to start.
