import {
  HAProxyFrontend,
  HAProxyRoute,
  PrismaClient,
} from "../../../generated/prisma/client";
import { HAProxyRouteDTO, SharedFrontendDTO } from "./frontend-types";

/**
 * Pure mappers + Prisma wrappers for shared-frontend / route persistence.
 *
 * Keeping these in one place kills the copy-paste of
 * `{ id, frontendName, environmentId, isSharedFrontend, bindPort, bindAddress, useSSL, tlsCertificateId }`
 * that appeared in every `getOrCreate` branch, and centralises the
 * `{ id, hostname, aclName, backendName, sourceType, useSSL }` route projection
 * that was repeated in both `addRoute` branches.
 */

export function toSharedFrontendDTO(record: HAProxyFrontend): SharedFrontendDTO {
  return {
    id: record.id,
    frontendName: record.frontendName,
    environmentId: record.environmentId,
    isSharedFrontend: record.isSharedFrontend,
    bindPort: record.bindPort,
    bindAddress: record.bindAddress,
    useSSL: record.useSSL,
    tlsCertificateId: record.tlsCertificateId,
  };
}

export function toRouteDTO(record: HAProxyRoute): HAProxyRouteDTO {
  return {
    id: record.id,
    hostname: record.hostname,
    aclName: record.aclName,
    backendName: record.backendName,
    sourceType: record.sourceType,
    useSSL: record.useSSL,
  };
}

export async function findSharedFrontend(
  environmentId: string,
  bindPort: number,
  prisma: PrismaClient
): Promise<HAProxyFrontend | null> {
  return prisma.hAProxyFrontend.findFirst({
    where: {
      environmentId,
      isSharedFrontend: true,
      frontendType: "shared",
      bindPort,
    },
  });
}

export async function findSharedFrontendById(
  id: string,
  prisma: PrismaClient
): Promise<HAProxyFrontend | null> {
  return prisma.hAProxyFrontend.findUnique({ where: { id } });
}

export async function createSharedFrontendRecord(
  params: {
    environmentId: string;
    frontendName: string;
    bindPort: number;
    bindAddress: string;
    useSSL: boolean;
    tlsCertificateId: string | null;
  },
  prisma: PrismaClient
): Promise<HAProxyFrontend> {
  return prisma.hAProxyFrontend.create({
    data: {
      frontendType: "shared",
      frontendName: params.frontendName,
      // Shared frontends don't have a single backend or hostname
      backendName: "",
      hostname: "",
      bindPort: params.bindPort,
      bindAddress: params.bindAddress,
      isSharedFrontend: true,
      environmentId: params.environmentId,
      status: "active",
      useSSL: params.useSSL,
      tlsCertificateId: params.tlsCertificateId,
    },
  });
}

export async function findRouteByHostname(
  sharedFrontendId: string,
  hostname: string,
  prisma: PrismaClient
): Promise<HAProxyRoute | null> {
  return prisma.hAProxyRoute.findFirst({
    where: { sharedFrontendId, hostname },
  });
}

export async function createRouteRecord(
  params: {
    sharedFrontendId: string;
    hostname: string;
    aclName: string;
    backendName: string;
    sourceType: "manual" | "stack";
    sourceId: string;
    useSSL: boolean;
    tlsCertificateId: string | null;
  },
  prisma: PrismaClient
): Promise<HAProxyRoute> {
  return prisma.hAProxyRoute.create({
    data: {
      sharedFrontendId: params.sharedFrontendId,
      hostname: params.hostname,
      aclName: params.aclName,
      backendName: params.backendName,
      sourceType: params.sourceType,
      manualFrontendId: params.sourceType === "manual" ? params.sourceId : null,
      useSSL: params.useSSL,
      tlsCertificateId: params.tlsCertificateId,
      status: "active",
    },
  });
}

export async function findSharedFrontendsWithRoutes(
  environmentId: string,
  prisma: PrismaClient
): Promise<Array<HAProxyFrontend & { routes: HAProxyRoute[] }>> {
  return prisma.hAProxyFrontend.findMany({
    where: {
      environmentId,
      isSharedFrontend: true,
    },
    include: { routes: true },
  });
}
