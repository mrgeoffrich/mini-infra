/**
 * Phase 6 integration test — Applications-page "Claude Shell" preset create flow.
 *
 * Exercises the same HTTP sequence the form submits:
 *
 *   1. POST /api/stack-templates  — body identical to what the
 *      `client/src/app/applications/new/claude-shell/page.tsx` form builds.
 *   2. (skip publish — for a deploy-immediately flow the UI flips publish
 *       in via the `useCreateApplication` hook after this test's surface;
 *       what we care about here is the *persisted shape* of the v0 draft.)
 *   3. Verify the StackTemplate row + v0 draft's StackTemplateService row
 *      carry the expected `addons: { 'claude-shell': { gitRepo, extraTags? } }`,
 *      the published image + tag, the `/workspace` and `/home/claude` volume
 *      mounts, and the `Stateful` service type.
 *
 * The image is `ghcr.io/mrgeoffrich/mini-infra-claude-shell:latest` — the
 * GH-Actions publish workflow may not have fired yet for a fresh checkout,
 * so the test deliberately stops at the persisted-draft layer rather than
 * trying to pull the image. Container health is verified by the live UI
 * smoke (see the worktree's `playwright` flow), not here.
 *
 * The `claude-shell` addon is registered into `productionAddonRegistry`
 * automatically by the side-effect imports in
 * `server/src/services/stack-addons/index.ts`; this test imports through
 * `../routes/stack-templates`, which triggers the side-effects.
 */

import supertest from 'supertest';
import express, { type Request, type Response, type NextFunction } from 'express';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { testPrisma } from './integration-test-helpers';

// Make sure the addon registry is populated.
import '../services/stack-addons';

vi.mock('../middleware/auth', () => ({
  requirePermission:
    () => (req: Request, _res: Response, next: NextFunction) => {
      (req as Request & { user?: { id: string } }).user = { id: 'session-user' };
      next();
    },
}));

vi.mock('../lib/prisma', () => ({ default: testPrisma }));

import stackTemplateRouter from '../routes/stack-templates';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/stack-templates', stackTemplateRouter);
  return app;
}

const CLAUDE_SHELL_IMAGE = 'ghcr.io/mrgeoffrich/mini-infra-claude-shell';
const CLAUDE_SHELL_TAG = 'latest';

/**
 * Build a request body that matches what
 * `client/src/app/applications/new/claude-shell/page.tsx` POSTs. Lives in
 * this file so a future schema drift between the form and the server route
 * surfaces in one test rather than across two layers.
 */
function buildClaudeShellPresetBody(overrides: {
  name: string;
  environmentId: string;
  gitRepo?: string;
  extraTags?: string[];
}) {
  const stackName = overrides.name;
  const claudeShellConfig: Record<string, unknown> = {};
  if (overrides.gitRepo) claudeShellConfig.gitRepo = overrides.gitRepo;
  if (overrides.extraTags && overrides.extraTags.length > 0) {
    claudeShellConfig.extraTags = overrides.extraTags;
  }

  return {
    name: stackName,
    displayName: stackName,
    description:
      'Claude Shell — developer container with Claude Code over Tailscale SSH',
    scope: 'environment' as const,
    environmentId: overrides.environmentId,
    deployImmediately: true,
    networks: [],
    volumes: [
      { name: `${stackName}-workspace` },
      { name: `${stackName}-home` },
    ],
    services: [
      {
        serviceName: 'shell',
        serviceType: 'Stateful' as const,
        dockerImage: CLAUDE_SHELL_IMAGE,
        dockerTag: CLAUDE_SHELL_TAG,
        containerConfig: {
          mounts: [
            {
              source: `${stackName}-workspace`,
              target: '/workspace',
              type: 'volume' as const,
            },
            {
              source: `${stackName}-home`,
              target: '/home/claude',
              type: 'volume' as const,
            },
          ],
          restartPolicy: 'unless-stopped' as const,
        },
        dependsOn: [],
        order: 0,
        addons: { 'claude-shell': claudeShellConfig },
      },
    ],
  };
}

async function createEnvironmentRow(): Promise<string> {
  const row = await testPrisma.environment.create({
    data: {
      name: `env-${Math.random().toString(36).slice(2, 8)}`,
      networkType: 'local',
      type: 'nonproduction',
    },
  });
  return row.id;
}

describe('Phase 6 — Claude Shell preset create flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('persists a fully-formed Claude Shell template via POST /api/stack-templates', async () => {
    const environmentId = await createEnvironmentRow();
    const stackName = `cs-${Math.random().toString(36).slice(2, 8)}`;

    const body = buildClaudeShellPresetBody({
      name: stackName,
      environmentId,
      gitRepo: 'git@github.com:owner/private.git',
      extraTags: ['tag:dev-team'],
    });

    const res = await supertest(buildApp())
      .post('/api/stack-templates')
      .send(body);

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);

    const templateId = res.body.data.id as string;

    // Template row carries the correct displayName + scope + environmentId.
    const tmpl = await testPrisma.stackTemplate.findUnique({
      where: { id: templateId },
      include: { draftVersion: true },
    });
    expect(tmpl).not.toBeNull();
    expect(tmpl!.displayName).toBe(stackName);
    expect(tmpl!.scope).toBe('environment');
    expect(tmpl!.environmentId).toBe(environmentId);
    expect(tmpl!.draftVersionId).not.toBeNull();

    // The v0 draft's service row carries the expected addons block.
    const svc = await testPrisma.stackTemplateService.findFirst({
      where: { versionId: tmpl!.draftVersionId! },
    });
    expect(svc).not.toBeNull();
    expect(svc!.serviceName).toBe('shell');
    expect(svc!.serviceType).toBe('Stateful');
    expect(svc!.dockerImage).toBe(CLAUDE_SHELL_IMAGE);
    expect(svc!.dockerTag).toBe(CLAUDE_SHELL_TAG);
    expect(svc!.addons).toEqual({
      'claude-shell': {
        gitRepo: 'git@github.com:owner/private.git',
        extraTags: ['tag:dev-team'],
      },
    });

    // Container config carries the workspace + home/claude volume mounts.
    const cc = svc!.containerConfig as {
      mounts: Array<{ source: string; target: string; type: string }>;
      restartPolicy: string;
    };
    const mountTargets = cc.mounts.map((m) => m.target).sort();
    expect(mountTargets).toEqual(['/home/claude', '/workspace']);
    expect(cc.restartPolicy).toBe('unless-stopped');
  });

  it('persists the minimal-shape addons block when no extras are set', async () => {
    const environmentId = await createEnvironmentRow();
    const stackName = `cs-min-${Math.random().toString(36).slice(2, 8)}`;

    const body = buildClaudeShellPresetBody({
      name: stackName,
      environmentId,
      // No gitRepo, no extraTags — the form sends `addons: { 'claude-shell': {} }`.
    });

    const res = await supertest(buildApp())
      .post('/api/stack-templates')
      .send(body);

    expect(res.status).toBe(201);
    const tmplId = res.body.data.id as string;
    const tmpl = await testPrisma.stackTemplate.findUnique({
      where: { id: tmplId },
    });
    const svc = await testPrisma.stackTemplateService.findFirst({
      where: { versionId: tmpl!.draftVersionId! },
    });
    expect(svc!.addons).toEqual({ 'claude-shell': {} });
  });

  it('rejects bodies whose addon config violates `claudeShellConfigSchema`', async () => {
    const environmentId = await createEnvironmentRow();
    const stackName = `cs-bad-${Math.random().toString(36).slice(2, 8)}`;

    // Pass an obviously-bogus tag — the addon's strict() + regex catches it.
    const body = buildClaudeShellPresetBody({
      name: stackName,
      environmentId,
    });
    // Mutate the body in place so we keep the rest of the shape valid.
    (
      body.services[0].addons['claude-shell'] as Record<string, unknown>
    ).extraTags = ['not-a-valid-tag-prefix'];

    const res = await supertest(buildApp())
      .post('/api/stack-templates')
      .send(body);

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    // Surface the addon name in the issue path so operators can find the
    // offending field quickly.
    const issuePaths = (res.body.issues as Array<{ path: unknown[] }>).map((i) =>
      i.path.join('.'),
    );
    expect(issuePaths.some((p) => p.includes('claude-shell'))).toBe(true);
  });
});
