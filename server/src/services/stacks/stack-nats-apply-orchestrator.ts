import type { PrismaClient } from "../../lib/prisma";
import { Prisma } from "../../generated/prisma/client";
import {
  buildTemplateContext,
  resolveTemplate,
  type TemplateContextEnvironment,
} from "./template-engine";
import { mergeParameterValues } from "./utils";
import { getNatsControlPlaneService } from "../nats/nats-control-plane-service";
import type {
  EnvironmentNetworkType,
  EnvironmentType,
  StackParameterDefinition,
  StackParameterValue,
  TemplateNatsAccount,
  TemplateNatsConsumer,
  TemplateNatsCredential,
  TemplateNatsStream,
} from "@mini-infra/types";

export type NatsApplyPhaseStatus = "applied" | "noop" | "skipped" | "error";

export interface NatsApplyPhaseResult {
  status: NatsApplyPhaseStatus;
  servicesBound?: number;
  credentialsMapped?: number;
  error?: string;
}

export interface NatsApplyPhaseOptions {
  triggeredBy: string | undefined;
  requireNatsReady?: boolean;
}

export async function runStackNatsApplyPhase(
  prisma: PrismaClient,
  stackId: string,
  opts: NatsApplyPhaseOptions,
): Promise<NatsApplyPhaseResult> {
  const stack = await prisma.stack.findUnique({
    where: { id: stackId },
    include: {
      environment: true,
      services: { orderBy: { order: "asc" } },
    },
  });
  if (!stack?.templateId || stack.templateVersion == null) return { status: "skipped" };

  const templateVersion = await prisma.stackTemplateVersion.findFirst({
    where: { templateId: stack.templateId, version: stack.templateVersion },
    select: {
      natsAccounts: true,
      natsCredentials: true,
      natsStreams: true,
      natsConsumers: true,
      services: { select: { serviceName: true, natsCredentialRef: true } },
    },
  });
  if (!templateVersion) return { status: "skipped" };

  const accounts = (templateVersion.natsAccounts as TemplateNatsAccount[] | null) ?? [];
  const credentials = (templateVersion.natsCredentials as TemplateNatsCredential[] | null) ?? [];
  const streams = (templateVersion.natsStreams as TemplateNatsStream[] | null) ?? [];
  const consumers = (templateVersion.natsConsumers as TemplateNatsConsumer[] | null) ?? [];
  const hasNats = accounts.length > 0 || credentials.length > 0 || streams.length > 0 || consumers.length > 0;
  if (!hasNats) return { status: "skipped" };

  const status = await getNatsControlPlaneService(prisma).getStatus();
  if (!status.configured && opts.requireNatsReady) {
    throw new Error("NATS is not configured; deploy the vault-nats stack before applying a NATS-bearing template");
  }

  try {
    const params = mergeParameterValues(
      (stack.parameters as unknown as StackParameterDefinition[]) ?? [],
      (stack.parameterValues as unknown as Record<string, StackParameterValue>) ?? {},
    );
    const environment: TemplateContextEnvironment | undefined = stack.environment
      ? {
          id: stack.environment.id,
          name: stack.environment.name,
          type: stack.environment.type as EnvironmentType,
          networkType: stack.environment.networkType as EnvironmentNetworkType,
        }
      : undefined;
    const ctx = buildTemplateContext(
      {
        name: stack.name,
        networks: (stack.networks as unknown as Parameters<typeof buildTemplateContext>[0]["networks"]) ?? [],
        volumes: (stack.volumes as unknown as Parameters<typeof buildTemplateContext>[0]["volumes"]) ?? [],
      },
      stack.services.map((s) => ({
        serviceName: s.serviceName,
        dockerImage: s.dockerImage,
        dockerTag: s.dockerTag,
        containerConfig: s.containerConfig as Parameters<typeof buildTemplateContext>[1][number]["containerConfig"],
      })),
      { stackId, environment, params },
    );

    const service = getNatsControlPlaneService(prisma);
    const accountIdByName = new Map<string, string>();
    const credentialIdByName = new Map<string, string>();
    const streamIdByName = new Map<string, string>();
    const resources: Array<{ type: string; concreteName: string; scope?: string }> = [];

    await service.ensureDefaultAccount();

    for (const account of accounts) {
      const name = concreteName(render(account.name, ctx), account.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsAccount.findUnique({ where: { name } });
      const row = existing
        ? await prisma.natsAccount.update({
            where: { id: existing.id },
            data: {
              displayName: account.displayName ?? name,
              description: account.description ?? null,
              updatedById: opts.triggeredBy ?? null,
            },
          })
        : await prisma.natsAccount.create({
            data: {
              name,
              displayName: account.displayName ?? name,
              description: account.description ?? null,
              seedKvPath: `shared/nats-accounts/${name}`,
              createdById: opts.triggeredBy ?? null,
              updatedById: opts.triggeredBy ?? null,
            },
          });
      accountIdByName.set(account.name, row.id);
      resources.push({ type: "account", concreteName: name, scope: account.scope });
    }

    for (const credential of credentials) {
      const accountId = accountIdByName.get(credential.account)
        ?? (await prisma.natsAccount.findUnique({ where: { name: credential.account } }))?.id;
      if (!accountId) throw new Error(`NATS credential '${credential.name}' references unknown account '${credential.account}'`);
      const name = concreteName(render(credential.name, ctx), credential.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsCredentialProfile.findUnique({ where: { name } });
      const data = {
        displayName: credential.displayName ?? name,
        description: credential.description ?? null,
        accountId,
        publishAllow: credential.publishAllow.map((s) => render(s, ctx)) as unknown as Prisma.InputJsonValue,
        subscribeAllow: credential.subscribeAllow.map((s) => render(s, ctx)) as unknown as Prisma.InputJsonValue,
        ttlSeconds: credential.ttlSeconds ?? 3600,
        updatedById: opts.triggeredBy ?? null,
      };
      const row = existing
        ? await prisma.natsCredentialProfile.update({ where: { id: existing.id }, data })
        : await prisma.natsCredentialProfile.create({
            data: {
              name,
              ...data,
              createdById: opts.triggeredBy ?? null,
            },
          });
      credentialIdByName.set(credential.name, row.id);
      resources.push({ type: "credential", concreteName: name, scope: credential.scope });
    }

    for (const stream of streams) {
      const accountId = accountIdByName.get(stream.account)
        ?? (await prisma.natsAccount.findUnique({ where: { name: stream.account } }))?.id;
      if (!accountId) throw new Error(`NATS stream '${stream.name}' references unknown account '${stream.account}'`);
      const name = concreteName(render(stream.name, ctx), stream.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsStream.findUnique({ where: { name } });
      const data = {
        accountId,
        description: stream.description ?? null,
        subjects: stream.subjects.map((s) => render(s, ctx)) as unknown as Prisma.InputJsonValue,
        retention: stream.retention ?? "limits",
        storage: stream.storage ?? "file",
        maxMsgs: stream.maxMsgs ?? null,
        maxBytes: stream.maxBytes ?? null,
        maxAgeSeconds: stream.maxAgeSeconds ?? null,
        updatedById: opts.triggeredBy ?? null,
      };
      const row = existing
        ? await prisma.natsStream.update({ where: { id: existing.id }, data })
        : await prisma.natsStream.create({
            data: {
              name,
              ...data,
              createdById: opts.triggeredBy ?? null,
            },
          });
      streamIdByName.set(stream.name, row.id);
      resources.push({ type: "stream", concreteName: name, scope: stream.scope });
    }

    for (const consumer of consumers) {
      const streamId = streamIdByName.get(consumer.stream)
        ?? (await prisma.natsStream.findUnique({ where: { name: consumer.stream } }))?.id;
      if (!streamId) throw new Error(`NATS consumer '${consumer.name}' references unknown stream '${consumer.stream}'`);
      const name = concreteName(render(consumer.name, ctx), consumer.scope, stack.name, stack.environment?.name ?? null);
      const existing = await prisma.natsConsumer.findFirst({ where: { streamId, name } });
      const data = {
        durableName: consumer.durableName ? render(consumer.durableName, ctx) : name,
        description: consumer.description ?? null,
        filterSubject: consumer.filterSubject ? render(consumer.filterSubject, ctx) : null,
        deliverPolicy: consumer.deliverPolicy ?? "all",
        ackPolicy: consumer.ackPolicy ?? "explicit",
        maxDeliver: consumer.maxDeliver ?? null,
        ackWaitSeconds: consumer.ackWaitSeconds ?? null,
        updatedById: opts.triggeredBy ?? null,
      };
      if (existing) {
        await prisma.natsConsumer.update({ where: { id: existing.id }, data });
      } else {
        await prisma.natsConsumer.create({
          data: {
            streamId,
            name,
            ...data,
            createdById: opts.triggeredBy ?? null,
          },
        });
      }
      resources.push({ type: "consumer", concreteName: name, scope: consumer.scope });
    }

    await service.applyConfig();
    await service.applyJetStreamResources();

    const refByService = new Map(
      templateVersion.services
        .filter((s) => s.natsCredentialRef != null)
        .map((s) => [s.serviceName, s.natsCredentialRef as string]),
    );
    const serviceUpdates = stack.services
      .map((svc) => {
        const ref = refByService.get(svc.serviceName);
        const concreteId = ref ? credentialIdByName.get(ref) : undefined;
        return concreteId ? { id: svc.id, natsCredentialId: concreteId } : null;
      })
      .filter((item): item is { id: string; natsCredentialId: string } => item !== null);

    await prisma.$transaction([
      prisma.stack.update({
        where: { id: stackId },
        data: {
          lastAppliedNatsSnapshot: JSON.stringify({ accounts, credentials, streams, consumers, resources }),
          lastFailureReason: null,
        },
      }),
      prisma.stackNatsResource.deleteMany({ where: { stackId } }),
      ...resources.map((resource) =>
        prisma.stackNatsResource.create({
          data: {
            stackId,
            type: resource.type,
            concreteName: resource.concreteName,
            scope: resource.scope ?? null,
          },
        }),
      ),
      ...serviceUpdates.map((update) =>
        prisma.stackService.update({
          where: { id: update.id },
          data: { natsCredentialId: update.natsCredentialId },
        }),
      ),
    ]);

    return {
      status: "applied",
      servicesBound: serviceUpdates.length,
      credentialsMapped: credentialIdByName.size,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await prisma.stack.update({
      where: { id: stackId },
      data: { status: "error", lastFailureReason: error },
    });
    return { status: "error", error };
  }
}

function render(value: string, ctx: Parameters<typeof resolveTemplate>[1]): string {
  return value.includes("{{") ? resolveTemplate(value, ctx) : value;
}

function concreteName(base: string, scope: string, stackName: string, environmentName: string | null): string {
  const prefix =
    scope === "host"
      ? "host"
      : scope === "stack"
        ? stackName
        : environmentName ?? stackName;
  return `${prefix}-${base}`.toLowerCase().replace(/[^a-z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}
