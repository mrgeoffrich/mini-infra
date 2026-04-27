import type { PrismaClient } from '../../lib/prisma';
import { getLogger } from '../../lib/logger-factory';
import { encryptInputValues, decryptInputValues } from './stack-input-values-service';
import type { TemplateInputDeclaration } from '@mini-infra/types';

const log = getLogger('stacks', 'orphan-input-pruner');

/**
 * After a successful apply, prune encryptedInputValues to contain only keys
 * that match the current template version's inputs[] declarations. Orphaned
 * values from prior template versions are silently removed.
 */
export async function pruneOrphanedInputValues(
  prisma: PrismaClient,
  stackId: string,
): Promise<void> {
  try {
    const stack = await prisma.stack.findUnique({
      where: { id: stackId },
      select: { templateId: true, templateVersion: true, encryptedInputValues: true },
    });
    if (!stack?.encryptedInputValues || !stack.templateId || stack.templateVersion == null) return;

    const tv = await prisma.stackTemplateVersion.findFirst({
      where: { templateId: stack.templateId, version: stack.templateVersion },
      select: { inputs: true },
    });
    if (!tv?.inputs) return;

    const declarations = tv.inputs as unknown as TemplateInputDeclaration[];
    const validKeys = new Set(declarations.map((d) => d.name));

    let stored: Record<string, string>;
    try {
      stored = decryptInputValues(stack.encryptedInputValues);
    } catch {
      return;
    }

    const pruned = Object.fromEntries(
      Object.entries(stored).filter(([k]) => validKeys.has(k)),
    );

    if (Object.keys(pruned).length === Object.keys(stored).length) return;

    const newBlob = Object.keys(pruned).length > 0 ? encryptInputValues(pruned) : null;
    await prisma.stack.update({
      where: { id: stackId },
      data: { encryptedInputValues: newBlob },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), stackId },
      'Failed to prune orphaned input values (non-fatal)',
    );
  }
}
