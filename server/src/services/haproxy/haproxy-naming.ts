/**
 * Pure naming utility functions for HAProxy resource naming.
 *
 * These functions generate deterministic, HAProxy-safe names for frontends,
 * ACLs, and certificate files. They have no side effects and no dependencies
 * on class instances, making them easy to test and reuse across modules.
 */

/**
 * Sanitize a string to be HAProxy-friendly (alphanumeric and underscores only)
 *
 * @param name The name to sanitize
 * @returns The sanitized name
 */
export function sanitizeForHAProxy(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_");
}

/**
 * Generate a frontend name from application name and environment ID
 *
 * @param applicationName The application name
 * @param environmentId The environment ID
 * @returns The generated frontend name (e.g., "fe_myapp_env123")
 */
export function generateFrontendName(
  applicationName: string,
  environmentId: string
): string {
  const sanitizedApp = sanitizeForHAProxy(applicationName);
  const sanitizedEnv = sanitizeForHAProxy(environmentId);
  return `fe_${sanitizedApp}_${sanitizedEnv}`;
}

/**
 * Generate an ACL name from a hostname
 *
 * @param hostname The hostname
 * @returns The generated ACL name (e.g., "acl_api_example_com")
 */
export function generateACLName(hostname: string): string {
  return `acl_${sanitizeForHAProxy(hostname)}`;
}

/**
 * Generate a shared frontend name for an environment
 *
 * @param environmentId The environment ID
 * @param type The frontend type ('http' or 'https')
 * @returns The generated shared frontend name (e.g., "http_frontend_env123")
 */
export function generateSharedFrontendName(
  environmentId: string,
  type: "http" | "https"
): string {
  const sanitizedEnv = sanitizeForHAProxy(environmentId);
  return `${type}_frontend_${sanitizedEnv}`;
}

/**
 * Generate a certificate filename for HAProxy from a domain or blob name.
 *
 * When source is a domain name (e.g., "api.example.com"), the dots and
 * special characters are replaced with underscores: "api_example_com.pem".
 *
 * When source is a blob name (e.g., "some-cert.pem"), the .pem extension
 * is stripped and re-appended to ensure a clean filename.
 *
 * @param source The primary domain or blob name to derive the filename from
 * @param sourceType Whether the source is a "primaryDomain" or "blobName" (default: "primaryDomain")
 * @returns The certificate filename (e.g., "api_example_com.pem")
 */
export function generateCertFileName(
  source: string,
  sourceType: "primaryDomain" | "blobName" = "primaryDomain"
): string {
  if (sourceType === "blobName") {
    return `${source.replace(/\.pem$/, "")}.pem`;
  }
  return `${sanitizeForHAProxy(source)}.pem`;
}
