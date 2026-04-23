/**
 * Helpers to translate between the form shape (UI-friendly: arrays of
 * key/value pairs, plain strings) and the backend shape (records, numbers,
 * template strings).
 *
 * Port/healthcheck numeric fields are entered as strings so the user can type
 * a literal number *or* a `{{params.name}}` template reference.
 */

import type {
  StackServiceRouting,
  StackInitCommand,
  StackContainerConfig,
} from "@mini-infra/types";

export type KeyValuePair = { key: string; value: string };

const TEMPLATE_STRING = /^\{\{params\.[a-zA-Z0-9_-]+\}\}$/;

export function recordToArray(
  rec: Record<string, string> | undefined,
): KeyValuePair[] {
  if (!rec) return [];
  return Object.entries(rec).map(([key, value]) => ({ key, value }));
}

export function arrayToRecord(arr: KeyValuePair[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (const { key, value } of arr) {
    if (key) result[key] = value;
  }
  return result;
}

/** Commands are stored as string[] but edited as a single space-joined string. */
export function commandToString(cmd: string[] | undefined): string {
  return cmd?.join(" ") ?? "";
}

export function stringToCommand(str: string): string[] | undefined {
  const trimmed = str.trim();
  if (!trimmed) return undefined;
  return trimmed.split(/\s+/);
}

/** Number-or-template fields: text input, parsed on submit. */
export function parseNumberOrTemplate(
  input: string,
  { allowEmpty }: { allowEmpty?: boolean } = {},
): { ok: true; value: number | string | undefined } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return allowEmpty
      ? { ok: true, value: undefined }
      : { ok: false, error: "Value is required" };
  }
  if (TEMPLATE_STRING.test(trimmed)) {
    return { ok: true, value: trimmed };
  }
  const n = Number(trimmed);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: "Must be an integer or a {{params.name}} reference" };
  }
  return { ok: true, value: n };
}

export function stringifyNumberOrTemplate(v: number | string | undefined): string {
  if (v === undefined || v === null) return "";
  return String(v);
}

/** A routing config is considered empty if no meaningful field is set. */
export function hasRoutingContent(r: Partial<StackServiceRouting> | undefined): boolean {
  if (!r) return false;
  return Boolean(r.hostname) || Boolean(r.listeningPort);
}

/** Strip undefined/empty keys so the payload stays small + matches server schema. */
export function compactContainerConfig(
  cfg: StackContainerConfig,
): StackContainerConfig {
  const out: StackContainerConfig = {};
  if (cfg.command?.length) out.command = cfg.command;
  if (cfg.entrypoint?.length) out.entrypoint = cfg.entrypoint;
  if (cfg.user) out.user = cfg.user;
  if (cfg.env && Object.keys(cfg.env).length > 0) out.env = cfg.env;
  if (cfg.ports?.length) out.ports = cfg.ports;
  if (cfg.mounts?.length) out.mounts = cfg.mounts;
  if (cfg.labels && Object.keys(cfg.labels).length > 0) out.labels = cfg.labels;
  if (cfg.joinNetworks?.length) out.joinNetworks = cfg.joinNetworks;
  if (cfg.joinResourceNetworks?.length)
    out.joinResourceNetworks = cfg.joinResourceNetworks;
  if (cfg.restartPolicy) out.restartPolicy = cfg.restartPolicy;
  if (cfg.healthcheck) out.healthcheck = cfg.healthcheck;
  if (cfg.logConfig) out.logConfig = cfg.logConfig;
  return out;
}

export function normalizeInitCommands(
  cmds: StackInitCommand[] | undefined,
): StackInitCommand[] | undefined {
  if (!cmds?.length) return undefined;
  const filtered = cmds
    .map((c) => ({
      volumeName: c.volumeName.trim(),
      mountPath: c.mountPath.trim(),
      commands: c.commands.map((s) => s.trim()).filter(Boolean),
    }))
    .filter((c) => c.volumeName && c.mountPath && c.commands.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}
