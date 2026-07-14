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
 *
 * Pass `renderedServices` (the post-addon-expansion service map produced by
 * `resolveServiceConfigs`) to capture synthetic sidecars in the snapshot.
 * Without it, only the user-authored services are persisted — meaning every
 * downstream consumer that walks `snapshot.services` looking for synthetic
 * markers (notably `GET /api/stacks/:id/addon-endpoints`, which derives the
 * tailnet URL for the Connect panel) sees an empty list even after a
 * successful apply that created the sidecars.
 *
 * Falls back to `stack.services` (authored only) when `renderedServices` is
 * omitted — used by callers that don't have the rendered map handy and don't
 * care about synthetics (e.g. an early failure path).
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
      addons?: unknown;
    }>;
  },
  renderedServices?: Map<string, StackServiceDefinition>,
): Prisma.InputJsonValue {
  const services: StackServiceDefinition[] = renderedServices
    ? Array.from(renderedServices.values())
    : stack.services.map((s) => ({
        serviceName: s.serviceName,
        serviceType: s.serviceType as StackServiceDefinition['serviceType'],
        dockerImage: s.dockerImage,
        dockerTag: s.dockerTag,
        containerConfig: s.containerConfig as unknown as StackContainerConfig,
        configFiles: (s.configFiles as unknown as StackConfigFile[]) ?? undefined,
        initCommands: (s.initCommands as unknown as StackServiceDefinition['initCommands']) ?? undefined,
        dependsOn: s.dependsOn as unknown as string[],
        order: s.order,
        routing: (s.routing as unknown as StackServiceDefinition['routing']) ?? undefined,
        adoptedContainer: (s.adoptedContainer as unknown as StackServiceDefinition['adoptedContainer']) ?? undefined,
        addons: (s.addons as Record<string, unknown> | null | undefined) ?? undefined,
      }));

  // NOTE: this is the `serializeStack` from @mini-infra/types (a pure
  // definition serializer), NOT the server's API serializer in ./utils. The
  // snapshot is a record of desired state, so it deliberately does not carry
  // the live-health fields (`needsAttention`, `runtimeIssues`) that the API
  // serializer derives.
  return serializeStack({
    ...stack,
    networks: stack.networks as unknown as StackNetwork[],
    volumes: stack.volumes as unknown as StackVolume[],
    services,
  } as unknown as Parameters<typeof serializeStack>[0]) as unknown as Prisma.InputJsonValue;
}
