/**
 * Phase 2 of split-vault-nats: bootstrapFwAgentStack must NOT dispatch an
 * apply at boot. The cross-stack `requires` system on the egress-fw-agent
 * template handles "NATS not synced yet" as a structured 409
 * `PREREQUISITES_NOT_MET` if anyone fires the apply before NATS is up — so
 * boot only ensures the DB row exists.
 *
 * Asserts:
 *   - When the template is missing the function returns null, no UserEvent.
 *   - When the template exists and there is no prior stack the function
 *     creates the stack row and returns `applyDispatched: false` with a
 *     deferral reason — and crucially, no UserEvent is created (no apply
 *     was dispatched).
 *   - A second call after the stack row exists is a no-op (idempotent).
 *
 * Pure DB; no docker/socket interactions are exercised here.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { createId } from '@paralleldrive/cuid2';
import { testPrisma } from './integration-test-helpers';
import { bootstrapFwAgentStack } from '../services/egress/fw-agent-stack-bootstrap';

const TEMPLATE_NAME = 'egress-fw-agent';

async function ensureTemplate(): Promise<{ templateId: string; versionId: string }> {
  // The integration harness truncates the database after every test, so we
  // always create a fresh template here.
  const templateId = createId();
  const versionId = createId();
  await testPrisma.stackTemplate.create({
    data: {
      id: templateId,
      name: TEMPLATE_NAME,
      displayName: 'Egress Firewall Agent',
      source: 'system',
      scope: 'host',
    },
  });
  await testPrisma.stackTemplateVersion.create({
    data: {
      id: versionId,
      templateId,
      version: 1,
      status: 'published',
      parameters: [],
      defaultParameterValues: {},
      networkTypeDefaults: {},
      networks: [],
      volumes: [],
      requires: [
        { kind: 'stack', templateName: 'nats', minState: 'synced', scopeMatch: 'host' },
      ] as object,
    },
  });
  await testPrisma.stackTemplate.update({
    where: { id: templateId },
    data: { currentVersionId: versionId },
  });
  return { templateId, versionId };
}

describe('bootstrapFwAgentStack — Phase 2 no-apply behavior', () => {
  let templateId: string;

  beforeEach(async () => {
    const { templateId: id } = await ensureTemplate();
    templateId = id;
  });

  it('creates the stack row but does NOT dispatch an apply', async () => {
    const result = await bootstrapFwAgentStack(testPrisma);
    expect(result.stackId).not.toBeNull();
    expect(result.applyDispatched).toBe(false);
    expect(result.reason).toBe('deferred to operator/seeder per cross-stack-prereqs design');

    // Stack row exists
    const stack = await testPrisma.stack.findFirst({
      where: { templateId, environmentId: null },
    });
    expect(stack).not.toBeNull();

    // No UserEvent was created (apply wasn't fired)
    const events = await testPrisma.userEvent.findMany({
      where: { resourceId: stack!.id },
    });
    expect(events).toEqual([]);
  });

  it('is idempotent — second call reuses the existing stack row', async () => {
    const first = await bootstrapFwAgentStack(testPrisma);
    expect(first.stackId).not.toBeNull();

    const second = await bootstrapFwAgentStack(testPrisma);
    expect(second.stackId).toBe(first.stackId);
    expect(second.applyDispatched).toBe(false);

    // Still exactly one stack row.
    const count = await testPrisma.stack.count({
      where: { templateId, environmentId: null },
    });
    expect(count).toBe(1);
  });

  it('honors auto-start opt-out — still creates the row but reports auto-start disabled', async () => {
    await testPrisma.systemSettings.upsert({
      where: {
        category_key: { category: 'egress-fw-agent', key: 'auto_start' },
      },
      create: {
        category: 'egress-fw-agent',
        key: 'auto_start',
        value: 'false',
        isActive: true,
        isEncrypted: false,
        createdBy: 'test',
        updatedBy: 'test',
      },
      update: { value: 'false', isActive: true, updatedBy: 'test' },
    });

    const result = await bootstrapFwAgentStack(testPrisma);
    expect(result.stackId).not.toBeNull();
    expect(result.applyDispatched).toBe(false);
    expect(result.reason).toBe('auto-start disabled');
  });
});
