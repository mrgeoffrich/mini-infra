import { Router, type Request, type Response } from 'express';
import type { StackTemplateSource, StackTemplateScope, CreateStackTemplateRequest, DraftVersionInput } from '@mini-infra/types';
import { hasPermission } from '@mini-infra/types';
import prisma from '../lib/prisma';
import { getLogger } from '../lib/logger-factory';
import { requirePermission } from '../middleware/auth';
import {
  StackTemplateService,
  TemplateError,
} from '../services/stacks/stack-template-service';
import { evaluatePrerequisitesForTemplateVersion } from '../services/stacks/template-prerequisites';
import {
  createTemplateSchema,
  updateTemplateMetaSchema,
  draftVersionSchema,
  publishDraftSchema,
  instantiateTemplateSchema,
} from '../services/stacks/stack-template-schemas';

const router = Router();
const logger = getLogger("stacks", "stack-templates");

function getTemplateService() {
  return new StackTemplateService(prisma);
}

function handleTemplateError(error: unknown, res: Response, fallbackMessage: string) {
  if (error instanceof TemplateError) {
    return res.status(error.statusCode).json({ success: false, message: (error instanceof Error ? error.message : String(error)) });
  }
  logger.error({ error }, fallbackMessage);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

// GET / — List templates
router.get('/', requirePermission('stacks:read'), async (req, res) => {
  try {
    const service = getTemplateService();
    const { source, scope, environmentId, includeArchived, includeLinkedStacks } = req.query;

    const templates = await service.listTemplates({
      source: source as StackTemplateSource,
      scope: scope as StackTemplateScope,
      environmentId: typeof environmentId === 'string' && environmentId.length > 0 ? environmentId : undefined,
      includeArchived: includeArchived === 'true',
      includeLinkedStacks: includeLinkedStacks === 'true',
    });

    res.json({ success: true, data: templates });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to list templates');
  }
});

// GET /:templateId — Get template with current version
router.get('/:templateId', requirePermission('stacks:read'), async (req, res) => {
  try {
    const service = getTemplateService();
    const template = await service.getTemplate(String(req.params.templateId));

    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    res.json({ success: true, data: template });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to get template');
  }
});

// GET /:templateId/versions — List all versions
router.get('/:templateId/versions', requirePermission('stacks:read'), async (req, res) => {
  try {
    const service = getTemplateService();

    // Verify template exists
    const template = await service.getTemplate(String(req.params.templateId));
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    const versions = await service.listVersions(String(req.params.templateId));
    res.json({ success: true, data: versions });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to list template versions');
  }
});

// GET /:templateId/versions/:versionId — Get specific version with services + config files
router.get('/:templateId/versions/:versionId', requirePermission('stacks:read'), async (req, res) => {
  try {
    const service = getTemplateService();
    const version = await service.getTemplateVersion(String(req.params.versionId));

    if (!version || version.templateId !== String(req.params.templateId)) {
      return res.status(404).json({ success: false, message: 'Version not found' });
    }

    res.json({ success: true, data: version });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to get template version');
  }
});

// POST / — Create user template (with initial draft)
router.post('/', requirePermission('stacks:write'), async (req, res) => {
  try {
    // Same gate as POST /:templateId/draft: a vault section in the body
    // requires the elevated template-vault:write scope on top of stacks:write.
    // Session users always pass.
    if (draftHasVaultSection(req.body) && !callerHasScope(req, 'template-vault:write')) {
      return res.status(403).json({
        success: false,
        message: 'The vault section requires the template-vault:write scope',
        code: 'template_vault_scope_required',
      });
    }
    if (draftHasNatsSection(req.body) && !callerHasScope(req, 'template-nats:write')) {
      return res.status(403).json({
        success: false,
        message: 'The nats section requires the template-nats:write scope',
        code: 'template_nats_scope_required',
      });
    }

    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const service = getTemplateService();
    const template = await service.createUserTemplate(
      parsed.data as CreateStackTemplateRequest,
      (req as { user?: { id?: string } }).user?.id
    );

    logger.info({ templateId: template.id, templateName: template.name }, 'Template created');
    res.status(201).json({ success: true, data: template });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to create template');
  }
});

// PATCH /:templateId — Update template metadata
router.patch('/:templateId', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = updateTemplateMetaSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const service = getTemplateService();
    const template = await service.updateTemplateMeta(String(req.params.templateId), parsed.data);

    res.json({ success: true, data: template });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to update template');
  }
});

/**
 * Check if a draft input contains a non-empty vault section.
 * Used to gate template-vault:write permission.
 */
function draftHasVaultSection(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const vault = (body as Record<string, unknown>).vault;
  if (typeof vault !== 'object' || vault === null) return false;
  const v = vault as Record<string, unknown>;
  return (
    (Array.isArray(v.policies) && v.policies.length > 0) ||
    (Array.isArray(v.appRoles) && v.appRoles.length > 0) ||
    (Array.isArray(v.kv) && v.kv.length > 0)
  );
}

function draftHasNatsSection(body: unknown): boolean {
  if (typeof body !== 'object' || body === null) return false;
  const nats = (body as Record<string, unknown>).nats;
  if (typeof nats !== 'object' || nats === null) return false;
  const n = nats as Record<string, unknown>;
  return (
    (Array.isArray(n.accounts) && n.accounts.length > 0) ||
    (Array.isArray(n.credentials) && n.credentials.length > 0) ||
    (Array.isArray(n.streams) && n.streams.length > 0) ||
    (Array.isArray(n.consumers) && n.consumers.length > 0)
  );
}

/**
 * Return true if the caller has a specific scope (session users always pass).
 */
function callerHasScope(req: Request, scope: string): boolean {
  if (req.user && !(req as { apiKey?: unknown }).apiKey) return true;
  const apiKey = (req as { apiKey?: { permissions: string[] | null } }).apiKey;
  if (!apiKey) return false;
  return hasPermission(apiKey.permissions, scope);
}

// POST /:templateId/draft — Create or replace draft version
router.post('/:templateId/draft', requirePermission('stacks:write'), async (req, res) => {
  try {
    // Vault sections require an additional elevated scope on top of stacks:write.
    if (draftHasVaultSection(req.body) && !callerHasScope(req, 'template-vault:write')) {
      return res.status(403).json({
        success: false,
        message: 'The vault section requires the template-vault:write scope',
        code: 'template_vault_scope_required',
      });
    }
    if (draftHasNatsSection(req.body) && !callerHasScope(req, 'template-nats:write')) {
      return res.status(403).json({
        success: false,
        message: 'The nats section requires the template-nats:write scope',
        code: 'template_nats_scope_required',
      });
    }

    const parsed = draftVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const service = getTemplateService();
    const version = await service.createOrUpdateDraft(
      String(req.params.templateId),
      parsed.data as DraftVersionInput,
      (req as { user?: { id?: string } }).user?.id
    );

    res.json({ success: true, data: version });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to create/update draft');
  }
});

// POST /:templateId/publish — Publish draft
router.post('/:templateId/publish', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = publishDraftSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const service = getTemplateService();
    const version = await service.publishDraft(String(req.params.templateId), parsed.data);

    logger.info(
      { templateId: req.params.templateId, version: version.version },
      'Template version published'
    );
    res.json({ success: true, data: version });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to publish draft');
  }
});

// DELETE /:templateId/draft — Discard draft
router.delete('/:templateId/draft', requirePermission('stacks:write'), async (req, res) => {
  try {
    const service = getTemplateService();
    await service.discardDraft(String(req.params.templateId));

    res.json({ success: true, message: 'Draft discarded' });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to discard draft');
  }
});

// DELETE /:templateId — Delete template and all linked stacks
router.delete('/:templateId', requirePermission('stacks:write'), async (req, res) => {
  try {
    const service = getTemplateService();
    await service.deleteTemplate(String(req.params.templateId));

    res.json({ success: true, message: 'Template deleted' });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to delete template');
  }
});

// GET /:templateId/prerequisites — Precheck cross-stack prereqs for what
// would happen if this template were instantiated into the given scope.
// Used by the instantiate dialog to show a soft-warn before creation.
//
// `environmentId` is required when the template is environment-scoped
// (or `any`-scoped and the caller intends to instantiate into an env).
// Host-scoped templates don't need it; the route falls back to host
// scope when the template scope is `host` and no env is given.
router.get('/:templateId/prerequisites', requirePermission('stacks:read'), async (req, res) => {
  try {
    const service = getTemplateService();
    const template = await service.getTemplate(String(req.params.templateId));
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }
    if (!template.currentVersionId || !template.currentVersion) {
      return res.status(400).json({
        success: false,
        message: 'Template has no published version',
        code: 'NO_PUBLISHED_VERSION',
      });
    }

    const envQuery = req.query.environmentId;
    const environmentId =
      typeof envQuery === 'string' && envQuery.length > 0 ? envQuery : undefined;

    // Determine the scope under which prereqs should be evaluated.
    // - host-scoped template: always host scope (env query ignored).
    // - environment-scoped template: env query required.
    // - any-scoped template: env query optional; presence picks the scope.
    let scope: { kind: 'host' } | { kind: 'environment'; environmentId: string };
    if (template.scope === 'host') {
      scope = { kind: 'host' };
    } else if (template.scope === 'environment') {
      if (!environmentId) {
        return res.status(400).json({
          success: false,
          message: 'environmentId query parameter is required for environment-scoped templates',
          code: 'ENVIRONMENT_ID_REQUIRED',
        });
      }
      scope = { kind: 'environment', environmentId };
    } else {
      // 'any'
      scope = environmentId
        ? { kind: 'environment', environmentId }
        : { kind: 'host' };
    }

    try {
      const result = await evaluatePrerequisitesForTemplateVersion(
        prisma,
        template.currentVersionId,
        scope,
      );
      return res.json({ success: true, ...result });
    } catch (err) {
      return res.status(422).json({
        success: false,
        message: err instanceof Error ? err.message : 'Prerequisite evaluation failed',
        code: 'PREREQUISITES_INVALID',
      });
    }
  } catch (error) {
    handleTemplateError(error, res, 'Failed to evaluate template prerequisites');
  }
});

// POST /:templateId/instantiate — Create stack from template
router.post('/:templateId/instantiate', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = instantiateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const service = getTemplateService();
    const stack = await service.createStackFromTemplate(
      {
        templateId: String(req.params.templateId),
        ...parsed.data,
      },
      (req as { user?: { id?: string } }).user?.id
    );

    logger.info(
      { templateId: req.params.templateId, stackId: stack.id, stackName: stack.name },
      'Stack created from template'
    );
    res.status(201).json({ success: true, data: stack });
  } catch (error) {
    handleTemplateError(error, res, 'Failed to create stack from template');
  }
});

export default router;
