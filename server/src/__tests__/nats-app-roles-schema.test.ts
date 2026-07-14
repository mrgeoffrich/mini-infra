/**
 * Phase 1 — Zod-level coverage for the new NATS app-author surface
 * (`roles`, `signers`, `imports`, `exports`, `subjectPrefix`).
 *
 * Tests both the file-loader path (templateFileSchema) and the HTTP draft
 * path (draftVersionSchema) since they share the `validateNatsSectionShape`
 * cross-validator and must both reject the same shapes (per `service-schema-
 * drift.test.ts` invariant).
 */

import { describe, it, expect } from 'vitest';
import { templateFileSchema } from '../services/stacks/template-file-loader';
import { draftVersionSchema } from '../services/stacks/stack-template-schemas';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fileBody(over: Record<string, unknown>) {
  return {
    name: 'tpl',
    displayName: 'Test',
    builtinVersion: 1,
    scope: 'environment' as const,
    networks: [],
    volumes: [],
    services: [],
    ...over,
  };
}

function draftBody(over: Record<string, unknown>) {
  return {
    networks: [],
    volumes: [],
    services: [],
    ...over,
  };
}

// ─── Per-pattern escape-attempt rejection ────────────────────────────────────

describe('templateNatsRoleSchema — relative subject pattern guards', () => {
  it('rejects publish: ">" (would shadow whole prefix)', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { roles: [{ name: 'gateway', publish: ['>'] }] },
    }));
    expect(r.success).toBe(false);
  });

  it('rejects publish: "*" at root', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { roles: [{ name: 'gateway', publish: ['*.in'] }] },
    }));
    expect(r.success).toBe(false);
  });

  it('rejects subscribe: "_INBOX.>" (must use inboxAuto)', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { roles: [{ name: 'gateway', subscribe: ['_INBOX.>'] }] },
    }));
    expect(r.success).toBe(false);
  });

  it('rejects publish: "$SYS.foo"', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { roles: [{ name: 'gateway', publish: ['$SYS.foo'] }] },
    }));
    expect(r.success).toBe(false);
  });

  it('rejects publish: "agent..in" (empty token)', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { roles: [{ name: 'gateway', publish: ['agent..in'] }] },
    }));
    expect(r.success).toBe(false);
  });

  it('accepts a normal relative subject', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { roles: [{ name: 'gateway', publish: ['agent.in'], subscribe: ['agent.reply.>'] }] },
    }));
    expect(r.success).toBe(true);
  });
});

// ─── Signer subjectScope guards ──────────────────────────────────────────────

describe('templateNatsSignerSchema — subjectScope guards', () => {
  it('rejects scope containing wildcards', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { signers: [{ name: 'minter', subjectScope: 'agent.worker.>' }] },
    }));
    expect(r.success).toBe(false);
  });

  it('rejects scope with empty tokens', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { signers: [{ name: 'minter', subjectScope: 'agent..worker' }] },
    }));
    expect(r.success).toBe(false);
  });

  it('accepts a concrete dotted scope', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: { signers: [{ name: 'minter', subjectScope: 'agent.worker' }] },
    }));
    expect(r.success).toBe(true);
  });
});

// ─── Mixing rule: legacy credentials and new roles cannot coexist ────────────

describe('removed low-level NATS surface', () => {
  // These four sections and the per-service `natsCredentialRef` binding were
  // the pre-roles authoring surface. They are rejected rather than deleted,
  // because Zod strips unknown keys: silently dropping them would let a
  // template still on the old shape save "successfully" with its whole NATS
  // section gone. Each rejection has to name the replacement.
  const cases: Array<{ key: string; nats: Record<string, unknown>; expect: string }> = [
    {
      key: 'accounts',
      nats: { accounts: [{ name: 'app', scope: 'host' }] },
      expect: 'nats.accounts[] was removed',
    },
    {
      key: 'credentials',
      nats: {
        credentials: [
          { name: 'app-cred', account: 'app', publishAllow: ['app.>'], subscribeAllow: ['app.>'] },
        ],
      },
      expect: 'declare nats.roles[] instead',
    },
    {
      key: 'streams',
      nats: { streams: [{ name: 'legacy', account: 'app', subjects: ['legacy.>'], scope: 'host' }] },
      expect: 'nats.roles[].streams[]',
    },
    {
      key: 'consumers',
      nats: { consumers: [{ name: 'leg', stream: 'legacy', scope: 'host' }] },
      expect: 'nats.roles[].consumers[]',
    },
  ];

  for (const c of cases) {
    it(`rejects nats.${c.key} with a migration message (file loader)`, () => {
      const r = templateFileSchema.safeParse(fileBody({ nats: c.nats }));
      expect(r.success).toBe(false);
      if (!r.success) {
        const msg = r.error.issues.map((i) => i.message).join('|');
        expect(msg).toContain(c.expect);
      }
    });

    it(`rejects nats.${c.key} with a migration message (HTTP draft)`, () => {
      const r = draftVersionSchema.safeParse(draftBody({ nats: c.nats }));
      expect(r.success).toBe(false);
      if (!r.success) {
        const msg = r.error.issues.map((i) => i.message).join('|');
        expect(msg).toContain(c.expect);
      }
    });
  }

  it('rejects services[].natsCredentialRef and points at natsRole (HTTP draft)', () => {
    const service = {
      serviceName: 'api',
      serviceType: 'Stateful' as const,
      dockerImage: 'nginx',
      dockerTag: '1.25',
      containerConfig: {},
      dependsOn: [],
      order: 0,
    };
    // Sanity-check the fixture parses without the removed field, so the
    // rejection below can only be attributed to `natsCredentialRef` itself.
    expect(draftVersionSchema.safeParse(draftBody({ services: [service] })).success).toBe(true);

    const r = draftVersionSchema.safeParse(
      draftBody({ services: [{ ...service, natsCredentialRef: 'app-cred' }] }),
    );
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain('services[].natsCredentialRef was removed');
      expect(msg).toContain('services[].natsRole');
    }
  });

  it('the roles surface on its own is still accepted', () => {
    const nats = { roles: [{ name: 'gateway', publish: ['agent.in'] }] };
    expect(templateFileSchema.safeParse(fileBody({ nats })).success).toBe(true);
    expect(draftVersionSchema.safeParse(draftBody({ nats })).success).toBe(true);
  });
});

// ─── roles[].streams + roles[].consumers — name uniqueness, refs, validation ─

describe('NATS role-nested streams + consumers', () => {
  it('a role with prefix-relative streams[] is accepted', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [
          {
            name: 'worker',
            publish: ['work.>'],
            streams: [
              { name: 'jobs', subjects: ['work.in.>'], retention: 'workqueue' },
            ],
          },
        ],
      },
    }));
    expect(r.success).toBe(true);
  });

  it('rejects a role-stream with a wildcard at root (would shadow the prefix)', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [{ name: 'worker', streams: [{ name: 'wide', subjects: ['>'] }] }],
      },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain('must not start with a wildcard');
    }
  });

  it('rejects duplicate stream names within a role', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [
          {
            name: 'worker',
            streams: [
              { name: 'jobs', subjects: ['x.>'] },
              { name: 'jobs', subjects: ['y.>'] },
            ],
          },
        ],
      },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain("Duplicate stream name 'jobs'");
    }
  });

  it("rejects a consumer whose `stream` doesn't reference one of the role's streams", () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [
          {
            name: 'worker',
            streams: [{ name: 'jobs', subjects: ['x.>'] }],
            consumers: [{ name: 'broken', stream: 'no-such-stream' }],
          },
        ],
      },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain("references unknown stream 'no-such-stream'");
    }
  });

  it('accepts a consumer with a relative filterSubject', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [
          {
            name: 'worker',
            streams: [{ name: 'jobs', subjects: ['work.>'] }],
            consumers: [
              { name: 'high', stream: 'jobs', filterSubject: 'work.priority.high' },
            ],
          },
        ],
      },
    }));
    expect(r.success).toBe(true);
  });

  it('rejects a consumer filterSubject that targets _INBOX directly', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [
          {
            name: 'worker',
            streams: [{ name: 'jobs', subjects: ['x.>'] }],
            consumers: [
              { name: 'evil', stream: 'jobs', filterSubject: '_INBOX.intercept' },
            ],
          },
        ],
      },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain('_INBOX');
    }
  });
});

// ─── Name uniqueness ─────────────────────────────────────────────────────────

describe('NATS role/signer name uniqueness', () => {
  it('duplicate role names rejected', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [
          { name: 'gateway', publish: ['a.in'] },
          { name: 'gateway', publish: ['b.in'] },
        ],
      },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain('Duplicate NATS role');
    }
  });

  it('duplicate signer names rejected', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        signers: [
          { name: 'minter', subjectScope: 'a' },
          { name: 'minter', subjectScope: 'b' },
        ],
      },
    }));
    expect(r.success).toBe(false);
  });
});

// ─── imports[].forRoles must reference declared roles ────────────────────────

describe('NATS imports[].forRoles role-resolution', () => {
  it('forRoles referencing an undeclared role is rejected', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [{ name: 'watcher', subscribe: ['x.>'] }],
        imports: [
          { fromStack: 'producer', subjects: ['events.>'], forRoles: ['notARealRole'] },
        ],
      },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain("references unknown role 'notARealRole'");
    }
  });

  it('forRoles referencing a declared role is accepted', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [{ name: 'watcher', subscribe: ['x.>'] }],
        imports: [
          { fromStack: 'producer', subjects: ['events.>'], forRoles: ['watcher'] },
        ],
      },
    }));
    expect(r.success).toBe(true);
  });

  it('forRoles must be non-empty (required, per security decision)', () => {
    const r = templateFileSchema.safeParse(fileBody({
      nats: {
        roles: [{ name: 'watcher', subscribe: ['x.>'] }],
        imports: [{ fromStack: 'producer', subjects: ['events.>'], forRoles: [] }],
      },
    }));
    expect(r.success).toBe(false);
  });
});

// ─── Service-level natsRole / natsSigner refs must resolve ───────────────────

describe('service.natsRole / service.natsSigner reference resolution', () => {
  function svc(extra: Record<string, unknown>) {
    return {
      serviceName: 'manager',
      serviceType: 'Stateful' as const,
      dockerImage: 'app',
      dockerTag: 'latest',
      containerConfig: {},
      dependsOn: [],
      order: 1,
      ...extra,
    };
  }

  it('natsRole referencing an undeclared role is rejected (file loader)', () => {
    const r = templateFileSchema.safeParse(fileBody({
      services: [svc({ natsRole: 'gateway' })],
      nats: { roles: [{ name: 'manager-role', publish: ['x'] }] },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain("natsRole 'gateway' references unknown role");
    }
  });

  it('natsSigner referencing an undeclared signer is rejected (HTTP draft)', () => {
    const r = draftVersionSchema.safeParse(draftBody({
      services: [svc({ natsSigner: 'absent' })],
      nats: { signers: [{ name: 'minter', subjectScope: 'a' }] },
    }));
    expect(r.success).toBe(false);
    if (!r.success) {
      const msg = r.error.issues.map((i) => i.message).join('|');
      expect(msg).toContain("natsSigner 'absent' references unknown signer");
    }
  });

  it('correct natsRole + natsSigner round-trip on a service', () => {
    const r = templateFileSchema.safeParse(fileBody({
      services: [svc({ natsRole: 'manager-role', natsSigner: 'minter' })],
      nats: {
        roles: [{ name: 'manager-role', publish: ['x'] }],
        signers: [{ name: 'minter', subjectScope: 'agent.worker' }],
      },
    }));
    expect(r.success).toBe(true);
    if (r.success) {
      expect(r.data.services[0].natsRole).toBe('manager-role');
      expect(r.data.services[0].natsSigner).toBe('minter');
    }
  });
});

// ─── DynamicEnvSource: nats-signer-seed parses ───────────────────────────────

describe('dynamicEnvSourceSchema — nats-signer-seed', () => {
  // Inline-import to keep the file's primary focus on the section schema.
  it('nats-signer-seed dynamicEnv parses', async () => {
    const { stackContainerConfigSchema } = await import('../services/stacks/schemas');
    const r = stackContainerConfigSchema.safeParse({
      dynamicEnv: { NATS_SIGNER_SEED: { kind: 'nats-signer-seed', signer: 'minter' } },
    });
    expect(r.success).toBe(true);
  });

  it('nats-signer-seed with empty signer rejected', async () => {
    const { stackContainerConfigSchema } = await import('../services/stacks/schemas');
    const r = stackContainerConfigSchema.safeParse({
      dynamicEnv: { NATS_SIGNER_SEED: { kind: 'nats-signer-seed', signer: '' } },
    });
    expect(r.success).toBe(false);
  });
});

// ─── DynamicEnvSource: nats-account-public parses ────────────────────────────

describe('dynamicEnvSourceSchema — nats-account-public', () => {
  it('nats-account-public dynamicEnv parses', async () => {
    const { stackContainerConfigSchema } = await import('../services/stacks/schemas');
    const r = stackContainerConfigSchema.safeParse({
      dynamicEnv: { NATS_ACCOUNT_PUB: { kind: 'nats-account-public', signer: 'minter' } },
    });
    expect(r.success).toBe(true);
  });

  it('nats-account-public with empty signer rejected', async () => {
    const { stackContainerConfigSchema } = await import('../services/stacks/schemas');
    const r = stackContainerConfigSchema.safeParse({
      dynamicEnv: { NATS_ACCOUNT_PUB: { kind: 'nats-account-public', signer: '' } },
    });
    expect(r.success).toBe(false);
  });

  it('nats-account-public with invalid signer name rejected', async () => {
    const { stackContainerConfigSchema } = await import('../services/stacks/schemas');
    const r = stackContainerConfigSchema.safeParse({
      dynamicEnv: { NATS_ACCOUNT_PUB: { kind: 'nats-account-public', signer: 'has spaces' } },
    });
    expect(r.success).toBe(false);
  });
});
