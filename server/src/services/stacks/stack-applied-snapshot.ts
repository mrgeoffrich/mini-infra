import { Prisma } from "../../generated/prisma/client";
import {
  serializeStack,
  type StackConfigFile,
  type StackContainerConfig,
  type StackNetwork,
  type StackServiceDefinition,
  type StackVolume,
} from '@mini-infra/types';

/**
 * Build the lastAppliedSnapshot value from a Prisma stack record.
 * Handles the JSON field casting that Prisma requires — Prisma types JSON
 * columns as `Prisma.JsonValue` but serializeStack expects the lib types.
 */
export function buildAppliedSnapshot(
  stack: {
    name: string;
    description: string | null;
    networks: unknown;
    volumes: unknown;
    parameters: unknown;
    resourceOutputs: unknown;
    resourceInputs: unknown;
    tlsCertificates: unknown;
    dnsRecords: unknown;
    tunnelIngress: unknown;
    services: Array<{
      serviceName: string;
      serviceType: string;
      dockerImage: string;
      dockerTag: string;
      order: number;
      containerConfig: unknown;
      configFiles: unknown;
      initCommands: unknown;
      dependsOn: unknown;
      routing: unknown;
      adoptedContainer: unknown;
    }>;
  }
): Prisma.InputJsonValue {
  return serializeStack({
    ...stack,
    networks: stack.networks as unknown as StackNetwork[],
    volumes: stack.volumes as unknown as StackVolume[],
    services: stack.services.map((s) => ({
      ...s,
      serviceType: s.serviceType as StackServiceDefinition['serviceType'],
      containerConfig: s.containerConfig as unknown as StackContainerConfig,
      configFiles: (s.configFiles as unknown as StackConfigFile[]) ?? null,
      initCommands: (s.initCommands as unknown as StackServiceDefinition['initCommands']) ?? null,
      dependsOn: s.dependsOn as unknown as string[],
      routing: (s.routing as unknown as StackServiceDefinition['routing']) ?? null,
      adoptedContainer: (s.adoptedContainer as unknown as StackServiceDefinition['adoptedContainer']) ?? null,
    })),
  } as unknown as Parameters<typeof serializeStack>[0]) as unknown as Prisma.InputJsonValue;
}
