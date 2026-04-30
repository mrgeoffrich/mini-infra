import type { PrismaClient } from "../../generated/prisma/client";
import type { StackContainerConfig } from "@mini-infra/types";
import { getNatsControlPlaneService } from "./nats-control-plane-service";

export class NatsCredentialInjector {
  constructor(private readonly prisma: PrismaClient) {}

  async resolve(
    credentialId: string | null,
    containerConfig: StackContainerConfig,
  ): Promise<Record<string, string> | null> {
    const dynamicEnv = containerConfig.dynamicEnv;
    if (!dynamicEnv) return null;

    const hasNatsCreds = Object.values(dynamicEnv).some((src) => src.kind === "nats-creds");
    if (hasNatsCreds && !credentialId) {
      throw new Error("Service declares nats-creds but no NATS credential profile is bound");
    }

    const service = getNatsControlPlaneService(this.prisma);
    const values: Record<string, string> = {};
    let mintedCreds: string | null = null;

    for (const [key, src] of Object.entries(dynamicEnv)) {
      if (src.kind === "nats-url") {
        values[key] = await service.getInternalUrl();
      }
      if (src.kind === "nats-creds") {
        if (!credentialId) continue;
        if (!mintedCreds) {
          const profile = await this.prisma.natsCredentialProfile.findUniqueOrThrow({
            where: { id: credentialId },
            include: { account: true },
          });
          mintedCreds = await service.mintCredentials(profile);
        }
        values[key] = mintedCreds;
      }
    }

    return Object.keys(values).length > 0 ? values : null;
  }
}
