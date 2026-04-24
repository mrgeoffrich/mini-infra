import * as fs from 'node:fs';

export interface XmlAdminDetails {
  email?: string;
  password?: string;
  apiKey?: string;
}

export interface EnvironmentDetailsSummary {
  seeded: boolean;
  admin: XmlAdminDetails;
}

export function xmlEscape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTag(xml: string, tag: string, parent?: string): string | undefined {
  let scope = xml;
  if (parent) {
    const parentMatch = new RegExp(`<${parent}>([\\s\\S]*?)<\\/${parent}>`).exec(xml);
    if (!parentMatch) return undefined;
    scope = parentMatch[1];
  }
  const m = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(scope);
  if (!m) return undefined;
  return xmlUnescape(m[1]);
}

export function readEnvironmentDetails(filePath: string): EnvironmentDetailsSummary | null {
  if (!fs.existsSync(filePath)) return null;
  const xml = fs.readFileSync(filePath, 'utf8');
  const seeded = (extractTag(xml, 'seeded') || '').trim().toLowerCase() === 'true';
  return {
    seeded,
    admin: {
      email: extractTag(xml, 'email', 'admin'),
      password: extractTag(xml, 'password', 'admin'),
      apiKey: extractTag(xml, 'apiKey', 'admin'),
    },
  };
}

export interface MinimalEnvironmentDetailsInput {
  profile: string;
  projectRoot: string;
  dockerHost: string;
  dockerSocket: string;
  composeProject: string;
  uiPort: number;
  registryPort: number;
  agentSidecarImageTag: string;
}

function isoWithUtcOffset(): string {
  // Match Python's datetime.now(timezone.utc).isoformat(timespec='seconds').
  return new Date().toISOString().replace(/\.\d{3}Z$/, '+00:00');
}

export function writeMinimalEnvironmentDetails(
  filePath: string,
  input: MinimalEnvironmentDetailsInput,
): void {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<environment>
  <generated>${xmlEscape(isoWithUtcOffset())}</generated>
  <seeded>false</seeded>
  <worktree>
    <profile>${xmlEscape(input.profile)}</profile>
    <path>${xmlEscape(input.projectRoot)}</path>
    <dockerHost>${xmlEscape(input.dockerHost)}</dockerHost>
    <dockerSocket>${xmlEscape(input.dockerSocket)}</dockerSocket>
    <composeProject>${xmlEscape(input.composeProject)}</composeProject>
  </worktree>
  <endpoints>
    <ui>http://localhost:${input.uiPort}</ui>
    <registry>localhost:${input.registryPort}</registry>
  </endpoints>
  <images>
    <agentSidecar>${xmlEscape(input.agentSidecarImageTag)}</agentSidecar>
  </images>
</environment>
`;
  fs.writeFileSync(filePath, xml);
}

export interface StackSummary {
  id?: string;
  name?: string;
  status?: string;
  lastAppliedAt?: string;
}

export interface LocalEnvironmentSummary {
  id?: string;
  name?: string;
  type?: string;
  networkType?: string;
}

export interface FullEnvironmentDetailsInput {
  profile: string;
  projectRoot: string;
  dockerHost: string;
  composeProject: string;
  uiPort: number;
  registryPort: number;
  agentSidecarImageTag: string;
  adminEmail: string;
  adminPassword: string;
  apiKey: string;
  azureConfigured: boolean;
  cloudflareConfigured: boolean;
  githubConfigured: boolean;
  localEnvironment: LocalEnvironmentSummary | null;
  stacks: StackSummary[];
}

export function writeFullEnvironmentDetails(
  filePath: string,
  input: FullEnvironmentDetailsInput,
): void {
  // Downstream skills (test-dev, fix-and-validate, diagnose-dev,
  // owasp-zap-guide) read this file via xmllint — keep tag names and nesting
  // stable.
  const t = (v: string | undefined): string => xmlEscape(v || '');

  const stacksXml = input.stacks
    .map(
      (s) =>
        `    <stack>\n` +
        `      <id>${t(s.id)}</id>\n` +
        `      <name>${t(s.name)}</name>\n` +
        `      <status>${t(s.status)}</status>\n` +
        `      <lastAppliedAt>${t(s.lastAppliedAt)}</lastAppliedAt>\n` +
        `    </stack>`,
    )
    .join('\n');

  const localEnvBlock = input.localEnvironment
    ? `  <localEnvironment>\n` +
      `    <id>${t(input.localEnvironment.id)}</id>\n` +
      `    <name>${t(input.localEnvironment.name)}</name>\n` +
      `    <type>${t(input.localEnvironment.type)}</type>\n` +
      `    <networkType>${t(input.localEnvironment.networkType)}</networkType>\n` +
      `  </localEnvironment>`
    : '';

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<environment>
  <generated>${t(isoWithUtcOffset())}</generated>
  <seeded>true</seeded>
  <worktree>
    <profile>${t(input.profile)}</profile>
    <path>${t(input.projectRoot)}</path>
    <dockerHost>${t(input.dockerHost)}</dockerHost>
    <composeProject>${t(input.composeProject)}</composeProject>
  </worktree>
  <endpoints>
    <ui>http://localhost:${input.uiPort}</ui>
    <registry>localhost:${input.registryPort}</registry>
  </endpoints>
  <images>
    <agentSidecar>${t(input.agentSidecarImageTag)}</agentSidecar>
  </images>
  <admin>
    <email>${t(input.adminEmail)}</email>
    <password>${t(input.adminPassword)}</password>
    <apiKey>${t(input.apiKey)}</apiKey>
  </admin>
  <connectedServices>
    <azure configured="${input.azureConfigured}"/>
    <cloudflare configured="${input.cloudflareConfigured}"/>
    <github configured="${input.githubConfigured}"/>
  </connectedServices>
${localEnvBlock}
  <stacks>
${stacksXml}
  </stacks>
</environment>
`;
  fs.writeFileSync(filePath, xml);
}
