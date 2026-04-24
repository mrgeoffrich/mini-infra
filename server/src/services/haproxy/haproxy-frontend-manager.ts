import { PrismaClient } from "../../generated/prisma/client";
import { HAProxyDataPlaneClient } from "./haproxy-dataplane-client";
import {
  addHostnameRouting as addHostnameRoutingOp,
} from "./frontend-manager/acl-rule-operations";
import {
  createFrontendForDeployment as createFrontendForDeploymentOp,
  CreateFrontendForDeploymentOptions,
  getFrontendStatus as getFrontendStatusOp,
  removeFrontend as removeFrontendOp,
} from "./frontend-manager/deployment-frontend-operations";
import { syncEnvironmentRoutes as syncEnvironmentRoutesOp } from "./frontend-manager/environment-route-synchronizer";
import {
  HAProxyRouteDTO,
  SharedFrontendDTO,
  UpdatedHAProxyRouteDTO,
} from "./frontend-manager/frontend-types";
import {
  addRouteToSharedFrontend as addRouteToSharedFrontendOp,
  removeRouteFromSharedFrontend as removeRouteFromSharedFrontendOp,
  updateFrontendBackend as updateFrontendBackendOp,
  updateRoute as updateRouteOp,
} from "./frontend-manager/route-operations";
import {
  getOrCreateSharedFrontend as getOrCreateSharedFrontendOp,
  GetOrCreateSharedFrontendOptions,
} from "./frontend-manager/shared-frontend-creator";
import {
  removeCertificateFromHAProxy as removeCertificateFromHAProxyOp,
  uploadCertificateForSNI as uploadCertificateForSNIOp,
} from "./frontend-manager/ssl-binding-deployer";

/**
 * HAProxyFrontendManager handles frontend creation and management for deployments
 * and shared frontends with hostname-based routing.
 *
 * The behaviour lives in focused modules under `./frontend-manager/`. This class
 * is the delegation shell that preserves the public API for downstream callers
 * (`actions/*`, `routes/haproxy-frontends.ts`, `manual-frontend-manager.ts`,
 * `stack-routing-manager.ts`, `haproxy-post-apply.ts`, `index.ts`).
 */
export class HAProxyFrontendManager {
  async createFrontendForDeployment(
    hostname: string,
    backendName: string,
    applicationName: string,
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    options?: CreateFrontendForDeploymentOptions
  ): Promise<string> {
    return createFrontendForDeploymentOp(
      hostname,
      backendName,
      applicationName,
      environmentId,
      haproxyClient,
      options
    );
  }

  async addHostnameRouting(
    frontendName: string,
    hostname: string,
    backendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    return addHostnameRoutingOp(frontendName, hostname, backendName, haproxyClient);
  }

  async removeFrontend(
    frontendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    return removeFrontendOp(frontendName, haproxyClient);
  }

  async updateFrontendBackend(
    frontendName: string,
    hostname: string,
    newBackendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    return updateFrontendBackendOp(
      frontendName,
      hostname,
      newBackendName,
      haproxyClient
    );
  }

  async getFrontendStatus(
    frontendName: string,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<Record<string, unknown> | null> {
    return getFrontendStatusOp(frontendName, haproxyClient);
  }

  async getOrCreateSharedFrontend(
    environmentId: string,
    type: "http" | "https",
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient,
    options?: GetOrCreateSharedFrontendOptions
  ): Promise<SharedFrontendDTO> {
    return getOrCreateSharedFrontendOp(
      environmentId,
      type,
      haproxyClient,
      prisma,
      options
    );
  }

  async uploadCertificateForSNI(
    tlsCertificateId: string,
    prisma: PrismaClient,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    return uploadCertificateForSNIOp(tlsCertificateId, prisma, haproxyClient);
  }

  async removeCertificateFromHAProxy(
    tlsCertificateId: string,
    prisma: PrismaClient,
    haproxyClient: HAProxyDataPlaneClient
  ): Promise<void> {
    return removeCertificateFromHAProxyOp(
      tlsCertificateId,
      prisma,
      haproxyClient
    );
  }

  async addRouteToSharedFrontend(
    sharedFrontendId: string,
    hostname: string,
    backendName: string,
    sourceType: "manual" | "stack",
    sourceId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient,
    sslOptions?: { useSSL: boolean; tlsCertificateId?: string }
  ): Promise<HAProxyRouteDTO> {
    return addRouteToSharedFrontendOp(
      sharedFrontendId,
      hostname,
      backendName,
      sourceType,
      sourceId,
      haproxyClient,
      prisma,
      sslOptions
    );
  }

  async removeRouteFromSharedFrontend(
    sharedFrontendId: string,
    hostname: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<void> {
    return removeRouteFromSharedFrontendOp(
      sharedFrontendId,
      hostname,
      haproxyClient,
      prisma
    );
  }

  async updateRoute(
    routeId: string,
    updates: {
      hostname?: string;
      backendName?: string;
      useSSL?: boolean;
      tlsCertificateId?: string | null;
      priority?: number;
      status?: string;
    },
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<UpdatedHAProxyRouteDTO> {
    return updateRouteOp(routeId, updates, haproxyClient, prisma);
  }

  async syncEnvironmentRoutes(
    environmentId: string,
    haproxyClient: HAProxyDataPlaneClient,
    prisma: PrismaClient
  ): Promise<{ synced: number; errors: string[] }> {
    return syncEnvironmentRoutesOp(environmentId, haproxyClient, prisma);
  }
}

export const haproxyFrontendManager = new HAProxyFrontendManager();
