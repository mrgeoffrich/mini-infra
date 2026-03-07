import { PrismaClient } from "@prisma/client";
import { StackDefinition } from "@mini-infra/types";

export interface BuiltinStackContext {
  environmentId: string;
  prisma: PrismaClient;
}

export interface BuiltinStackDefinition {
  name: string;
  builtinVersion: number;
  resolve: (context: BuiltinStackContext) => Promise<StackDefinition>;
}
