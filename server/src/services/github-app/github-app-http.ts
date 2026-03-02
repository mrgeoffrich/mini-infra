import { TIMEOUT_MS } from "./github-app-constants";

/**
 * Fetch wrapper with timeout for GitHub API calls.
 * Uses Node.js native fetch with an AbortController timeout.
 *
 * @param url - The URL to fetch
 * @param options - Standard fetch RequestInit options
 * @returns The fetch Response
 */
export async function fetchGitHub(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        "User-Agent": "mini-infra",
        ...options.headers,
      },
    });

    return response;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`GitHub API request timeout after ${TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
