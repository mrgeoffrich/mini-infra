import type { PrismaClient } from "../../../generated/prisma/client";
import type { ServiceApplyResult } from "@mini-infra/types";

export interface PostInstallContext {
  stackId: string;
  stackName: string;
  projectName: string;
  parameterValues: Record<string, string | number | boolean>;
  serviceResults: ServiceApplyResult[];
  triggeredBy?: string;
  prisma: PrismaClient;
}
