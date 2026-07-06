import { getLogger } from "../lib/logger-factory";

const logger = getLogger("docker", "registry-auth");

/**
 * Resolve an Authorization header for a container registry's v2 API.
 *
 * Probes the registry for a Bearer-token challenge (WWW-Authenticate) and
 * exchanges it for a token, falling back to Basic auth if no challenge is
 * present or the exchange fails. Registries like GHCR reject raw Basic auth
 * on manifest/blob endpoints and require this token dance even when the
 * supplied credentials are valid.
 */
export async function getRegistryAuthHeader(
  registry: string,
  repository: string,
  username?: string,
  password?: string,
): Promise<string | null> {
  if (!username || !password) {
    return null;
  }

  const basicAuth = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;

  try {
    const registryBase = registry.startsWith("localhost")
      ? `http://${registry}`
      : `https://${registry}`;
    const testResponse = await fetch(`${registryBase}/v2/`, { method: "GET" });

    const wwwAuthenticate = testResponse.headers.get("www-authenticate");

    if (wwwAuthenticate && wwwAuthenticate.includes("Bearer")) {
      const realmMatch = wwwAuthenticate.match(/realm="([^"]+)"/);
      const serviceMatch = wwwAuthenticate.match(/service="([^"]+)"/);

      if (realmMatch) {
        const realm = realmMatch[1];
        const service = serviceMatch ? serviceMatch[1] : registry;

        const tokenUrl = new URL(realm);
        tokenUrl.searchParams.set("service", service);
        tokenUrl.searchParams.set("scope", `repository:${repository}:pull`);

        const tokenResponse = await fetch(tokenUrl.toString(), {
          headers: { Authorization: basicAuth },
        });

        if (tokenResponse.ok) {
          const tokenData = await tokenResponse.json();
          if (tokenData.token) {
            logger.debug({ registry, repository }, "Obtained OAuth2 token for registry");
            return `Bearer ${tokenData.token}`;
          } else if (tokenData.access_token) {
            return `Bearer ${tokenData.access_token}`;
          }
        }
      }
    }

    logger.debug({ registry }, "Using Basic authentication for registry");
    return basicAuth;
  } catch (error) {
    logger.warn(
      {
        error: error instanceof Error ? error.message : String(error),
        registry,
      },
      "Failed to probe registry auth challenge, falling back to Basic auth",
    );

    return basicAuth;
  }
}
