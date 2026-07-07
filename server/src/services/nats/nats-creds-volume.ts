import type { DockerExecutorService } from '../docker-executor';
import { getLogger } from '../../lib/logger-factory';
import { InternalError } from '../../lib/errors';

const log = getLogger('stacks', 'nats-creds-volume');

/**
 * File-based NATS credential delivery (egress NATS cred-resilience plan,
 * Phase 5, §4.3).
 *
 * The old contract baked the minted `.creds` blob into the container env
 * (`NATS_CREDS`) at **create** time; nats.go loaded it once via static
 * `nats.UserJWTAndSeed`, so a rotated credential was never picked up without a
 * full container recreate — the root of the 15-hour production incident.
 *
 * The new contract writes the minted `.creds` into a **named docker volume**
 * that each egress agent mounts read-only. The agent points
 * `nats.UserCredentials(<file>)` at its file; nats.go re-reads the file on
 * every (re)connect, so a later rewrite of the file (Phase 6) refreshes creds
 * with no recreate.
 *
 * Volume topology — **per-stack** (§6 sub-choice): each consuming stack
 * declares its own `nats_creds` volume in its template (materialised as the
 * Docker volume `<projectName>_nats_creds`, exactly like `vault` declares
 * `openbao_data`). This reuses the existing template-driven volume
 * provisioning + read-only mount + stack-teardown machinery and gives
 * per-stack isolation (no agent can read another stack's creds), rather than a
 * single cross-stack shared volume that would need its own external lifecycle.
 *
 * Write path — **one-shot helper container** (§6 sub-choice): the server does
 * not mount the creds volume into its own container (which would change the
 * server's self-update definition / blast radius). Instead it runs a tiny
 * one-shot alpine that mounts the volume writable and writes the file, reusing
 * the existing `ContainerExecutor` (`binds`) plumbing.
 */

/** Unprefixed volume name each consuming stack declares in `template.volumes[]`. */
export const NATS_CREDS_VOLUME_NAME = 'nats_creds';

/** Directory the creds volume is mounted at inside the consuming container. */
export const NATS_CREDS_MOUNT_DIR = '/etc/nats-creds';

/** Alpine image for the one-shot writer. Matches the volume-inspector's choice. */
const WRITER_IMAGE = 'alpine:latest';

/** Per-stack creds file name within the volume (`<stackId>.creds`, §4.3). */
export function natsCredsFileName(stackId: string): string {
  return `${stackId}.creds`;
}

/**
 * Absolute path of the creds file as seen inside the consuming container —
 * the value delivered via the `NATS_CREDS_FILE` env var.
 */
export function natsCredsFilePath(stackId: string): string {
  return `${NATS_CREDS_MOUNT_DIR}/${natsCredsFileName(stackId)}`;
}

/** Docker volume name for a stack's creds volume. */
export function natsCredsVolumeName(projectName: string): string {
  return `${projectName}_${NATS_CREDS_VOLUME_NAME}`;
}

/** A single `.creds` blob to persist into a stack's creds volume. */
export interface NatsCredsFileSpec {
  /** File name within the volume, e.g. `<stackId>.creds`. */
  fileName: string;
  /** The armored `.creds` blob (NATS USER JWT + USER NKEY SEED). */
  contents: string;
}

/**
 * Write minted `.creds` blobs into a stack's `nats_creds` docker volume via a
 * one-shot alpine container, so the mounting egress agent can read them from a
 * file and pick up rewrites on its next reconnect (no container recreate).
 *
 * Ensures the volume exists first (Docker would auto-create it on the agent's
 * container create, but the writer needs it up front to mount + write into).
 * Idempotent per apply — overwrites the file with the freshly-minted blob.
 *
 * Throws on write failure so the caller (apply/spawn) aborts loudly rather
 * than leaving the agent to start against a missing/stale creds file.
 */
export async function writeNatsCredsFiles(
  dockerExecutor: DockerExecutorService,
  opts: { projectName: string; files: NatsCredsFileSpec[] },
): Promise<void> {
  if (opts.files.length === 0) return;
  const volumeName = natsCredsVolumeName(opts.projectName);

  // Ensure the volume exists before mounting it into the writer. createVolume
  // is idempotent (no-op when present).
  if (!(await dockerExecutor.volumeExists(volumeName))) {
    await dockerExecutor.createVolume(volumeName, opts.projectName, {
      labels: { 'mini-infra.nats-creds-volume': 'true' },
    });
  }

  // Deliver the secret via the writer's **stdin**, never its env: a base64
  // blob placed in an env var is visible via `docker inspect` (Config.Env) for
  // the container's brief life, which the plan forbids ("never the secret in
  // env"). We frame the payload as alternating lines — `<fileName>\n<base64>\n`
  // per file — so N ≥ 1 files stream cleanly. The file name is not a secret;
  // only the base64 body is, and it only ever travels over stdin. base64 is
  // encoded without line wrapping (single line per blob) so the in-container
  // `read -r` consumes exactly one line per field.
  const stdin =
    opts.files
      .map((file) => `${file.fileName}\n${Buffer.from(file.contents, 'utf-8').toString('base64')}`)
      .join('\n') + '\n';

  // Read <name>/<base64> pairs from stdin until EOF, decoding each into the
  // mounted volume. `set -e` propagates a base64 failure to the exit code.
  const writerScript = [
    'set -e',
    'while IFS= read -r name; do',
    '  IFS= read -r blob || exit 1',
    '  printf %s "$blob" | base64 -d > "/creds/$name"',
    'done',
  ].join('\n');

  // Ensure the writer image is present (authenticated pull) before running the
  // one-shot — executeContainer only create/start/waits, it does not pull.
  await dockerExecutor.pullImageWithAutoAuth(WRITER_IMAGE);

  const result = await dockerExecutor.executeContainer({
    image: WRITER_IMAGE,
    env: {},
    stdin,
    removeContainer: true,
    binds: [`${volumeName}:/creds`],
    cmd: ['sh', '-c', writerScript],
    labels: { 'mini-infra.nats-creds-writer': 'true' },
  });

  if (result.exitCode !== 0) {
    // A one-shot internal helper container misbehaving — not a condition the
    // caller (apply/spawn) or an end user can act on beyond retrying the apply.
    throw new InternalError(
      `Failed to write NATS creds into volume ${volumeName} (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  log.info(
    { volume: volumeName, files: opts.files.map((f) => f.fileName) },
    'Wrote NATS creds file(s) into volume',
  );
}
