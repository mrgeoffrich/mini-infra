/**
 * Typed shapes for HAProxy DataPlane API responses and DTOs returned by
 * HAProxyFrontendManager. Centralising these kills the inline-cast noise
 * (`(r: { cond_test?: string }) => ...`) scattered across the manager.
 */

/**
 * Shape of a single ACL entry returned by DataPlane `getACLs`. The index
 * signature matches the underlying `Record<string, unknown>` returned by the
 * client — we only care about `acl_name` here.
 */
export interface DataPlaneACL {
  acl_name: string;
  [key: string]: unknown;
}

/** Shape of a backend switching rule returned by DataPlane `getBackendSwitchingRules`. */
export interface DataPlaneBackendSwitchingRule {
  cond_test: string;
  [key: string]: unknown;
}

/** DTO returned from `getOrCreateSharedFrontend`. */
export interface SharedFrontendDTO {
  id: string;
  frontendName: string;
  environmentId: string | null;
  isSharedFrontend: boolean;
  bindPort: number;
  bindAddress: string;
  useSSL: boolean;
  tlsCertificateId: string | null;
}

/** DTO returned from `addRouteToSharedFrontend`. */
export interface HAProxyRouteDTO {
  id: string;
  hostname: string;
  aclName: string;
  backendName: string;
  sourceType: string;
  useSSL: boolean;
}

/** DTO returned from `updateRoute`. */
export interface UpdatedHAProxyRouteDTO {
  id: string;
  hostname: string;
  aclName: string;
  backendName: string;
  useSSL: boolean;
  priority: number;
  status: string;
}
