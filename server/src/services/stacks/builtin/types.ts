import { PrismaClient } from "@prisma/client";
import { StackDefinition } from "@mini-infra/types";

export interface BuiltinStackContext {
  environmentId?: string;
  prisma: PrismaClient;
}

export interface BuiltinStackDefinition {
  name: string;
  builtinVersion: number;
  scope: 'host' | 'environment';
  resolve: (context: BuiltinStackContext) => Promise<StackDefinition>;
}
