import DockerService from "../docker";
import { loadbalancerLogger } from "../../lib/logger-factory";
import { DockerStreamDemuxer } from "../../lib/docker-stream";

const logger = loadbalancerLogger();

const RESOLVERS_BLOCK = `
resolvers docker
    nameserver dns1 127.0.0.11:53
    resolve_retries 3
    timeout resolve 1s
    timeout retry 1s
    hold other 10s
    hold refused 10s
    hold nx 10s
    hold timeout 10s
    hold valid 10s
    hold obsolete 10s
`.trimStart();

const INIT_ADDR_LINE = "    default-server init-addr last,libc,none resolvers docker";

/**
 * Inject Docker DNS resolvers and init-addr into an HAProxy config string.
 * Returns the fixed config, or null if the config already has both directives.
 */
export function injectResolversIntoConfig(config: string): string | null {
  const hasResolvers = /^resolvers\s+docker/m.test(config);
  const hasInitAddr = /init-addr\s+.*none/m.test(config);

  if (hasResolvers && hasInitAddr) {
    return null; // already fixed
  }

  let result = config;

  // Inject init-addr at end of defaults section (before next section)
  if (!hasInitAddr) {
    // Find the defaults section and its last line before the next top-level section
    result = result.replace(
      /(defaults\b[^\n]*\n(?:[ \t]+[^\n]*\n)*)/,
      `$1${INIT_ADDR_LINE}\n`,
    );
  }

  // Inject resolvers block before first userlist/program/frontend/backend section
  if (!hasResolvers) {
    const sectionMatch = result.match(
      /^(userlist|program|frontend|backend)\s/m,
    );
    if (sectionMatch && sectionMatch.index !== undefined) {
      const insertPos = sectionMatch.index;
      result =
        result.slice(0, insertPos) + RESOLVERS_BLOCK + "\n" + result.slice(insertPos);
    } else {
      // No sections found, append at end
      result = result.trimEnd() + "\n\n" + RESOLVERS_BLOCK;
    }
  }

  return result;
}

/**
 * Read haproxy.cfg from a Docker volume using an ephemeral alpine container,
 * inject DNS resolvers, and write the fixed config back.
 *
 * Returns true if the config was repaired, false if it was already correct.
 */
export async function repairHAProxyConfig(
  volumeName: string,
): Promise<boolean> {
  const docker = await DockerService.getInstance().getDockerInstance();

  // Step 1: Read config from volume
  logger.info({ volumeName }, "Reading HAProxy config from volume");
  const readContainer = await docker.createContainer({
    Image: "alpine:latest",
    name: `mini-infra-haproxy-repair-read-${Date.now()}`,
    Cmd: ["cat", "/vol/haproxy.cfg"],
    HostConfig: { Binds: [`${volumeName}:/vol:ro`] },
  });

  let configContent: string;
  try {
    await readContainer.start();

    // Attach to get stdout
    const logs = await readContainer.logs({
      follow: true,
      stdout: true,
      stderr: true,
    });

    configContent = await new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const demuxer = new DockerStreamDemuxer();
      logs.on("data", (chunk: Buffer) => {
        for (const frame of demuxer.push(chunk)) {
          chunks.push(frame.data);
        }
      });
      logs.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
      logs.on("error", reject);
    });

    await readContainer.wait();
  } finally {
    try {
      await readContainer.remove({ force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  if (!configContent.trim()) {
    logger.warn({ volumeName }, "HAProxy config is empty, skipping repair");
    return false;
  }

  // Step 2: Apply fix
  const fixed = injectResolversIntoConfig(configContent);
  if (fixed === null) {
    logger.info({ volumeName }, "HAProxy config already has resolvers and init-addr, no repair needed");
    return false;
  }

  // Step 3: Write fixed config back
  logger.info({ volumeName }, "Writing repaired HAProxy config to volume");

  // Escape single quotes in config for shell
  const escaped = fixed.replace(/'/g, "'\\''");

  const writeContainer = await docker.createContainer({
    Image: "alpine:latest",
    name: `mini-infra-haproxy-repair-write-${Date.now()}`,
    Cmd: ["sh", "-c", `printf '%s' '${escaped}' > /vol/haproxy.cfg`],
    HostConfig: { Binds: [`${volumeName}:/vol`] },
  });

  try {
    await writeContainer.start();
    const writeResult = await writeContainer.wait();
    if (writeResult.StatusCode !== 0) {
      throw new Error(`Config write failed with exit code ${writeResult.StatusCode}`);
    }
  } finally {
    try {
      await writeContainer.remove({ force: true });
    } catch {
      // ignore cleanup errors
    }
  }

  logger.info({ volumeName }, "HAProxy config repaired successfully");
  return true;
}
