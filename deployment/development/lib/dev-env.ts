// Minimal parser for ~/.mini-infra/dev.env.
//
// Replaces `set -a; source dev.env` with a pure-TS reader. Handles the forms
// that actually appear in dev.env.example:
//   KEY=value
//   KEY='single-quoted with ; and spaces'
//   KEY="double quoted"
//   # comments
//   <blank lines>
// No shell-style variable interpolation, no backslash escapes, no `export`.

import * as fs from 'node:fs';

export interface DevEnv {
  ADMIN_EMAIL: string;
  ADMIN_PASSWORD: string;
  ADMIN_DISPLAY_NAME: string;
  LOCAL_ENV_NAME: string;
  AZURE_STORAGE_CONNECTION_STRING?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  DOCKER_HOST_IP?: string;
  GITHUB_TOKEN?: string;
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function parseDevEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = stripQuotes(line.slice(eq + 1));
  }
  return out;
}

export function loadDevEnv(filePath: string): DevEnv {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Env file not found: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const map = parseDevEnv(raw);

  const adminEmail = map.ADMIN_EMAIL;
  const adminPassword = map.ADMIN_PASSWORD;
  if (!adminEmail) throw new Error('ADMIN_EMAIL must be set in dev.env');
  if (!adminPassword) throw new Error('ADMIN_PASSWORD must be set in dev.env');

  return {
    ADMIN_EMAIL: adminEmail,
    ADMIN_PASSWORD: adminPassword,
    ADMIN_DISPLAY_NAME: map.ADMIN_DISPLAY_NAME || 'Admin',
    LOCAL_ENV_NAME: map.LOCAL_ENV_NAME || 'local',
    AZURE_STORAGE_CONNECTION_STRING: map.AZURE_STORAGE_CONNECTION_STRING || undefined,
    CLOUDFLARE_API_TOKEN: map.CLOUDFLARE_API_TOKEN || undefined,
    CLOUDFLARE_ACCOUNT_ID: map.CLOUDFLARE_ACCOUNT_ID || undefined,
    DOCKER_HOST_IP: map.DOCKER_HOST_IP || undefined,
    GITHUB_TOKEN: map.GITHUB_TOKEN || undefined,
  };
}
