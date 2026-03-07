import { BuiltinStackDefinition } from "./types";
import { monitoringStack } from "./monitoring";
import { haproxyStack } from "./haproxy";

export const BUILTIN_STACKS: BuiltinStackDefinition[] = [
  monitoringStack,
  haproxyStack,
];

export type { BuiltinStackDefinition, BuiltinStackContext } from "./types";
