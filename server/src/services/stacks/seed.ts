import { PrismaClient } from "../../generated/prisma/client";
import { syncBuiltinStacksForEnvironment } from "./builtin-stack-sync";

export async function seedStacksForEnvironment(
  prisma: PrismaClient,
  environmentId: string
): Promise<void> {
  await syncBuiltinStacksForEnvironment(prisma, environmentId);
}
