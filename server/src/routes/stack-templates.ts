import { Router, type Request } from 'express';
import type { StackTemplateSource, StackTemplateScope, CreateStackTemplateRequest, DraftVersionInput } from '@mini-infra/types';
import { hasPermission, Permission, ErrorCode } from '@mini-infra/types';
import prisma from '../lib/prisma';
import { getLogger } from '../lib/logger-factory';
import { asyncHandler } from '../lib/async-handler';
import { requirePermission } from '../middleware/auth';
import { NotFoundError, ValidationError, ForbiddenError } from '../lib/errors';
import { StackTemplateService } from '../services/stacks/stack-template-service';
import { evaluatePrerequisitesForTemplateVersion } from '../services/stacks/template-prerequisites';
import {
  createTemplateSchema,
  updateTemplateMetaSchema,
  draftVersionSchema,
  publishDraftSchema,
  instantiateTemplateSchema,
} from '../services/stacks/stack-template-schemas';
import {
  translateUnifiedNetworkDeclarations,
  UnifiedNetworkDeclarationError,
} from '../services/networks';

/**
 * Phase 10 — translate a template create/draft payload's unified
 * `networks[]` (+ per-service `networks[]`) declarations into the legacy
 * shapes `StackTemplateService`/`createUserTemplate`/`createOrUpdateDraft`
 * already understand. Runs immediately after schema validation, before the
 * payload reaches the template service, so the service layer never sees a
 * unified entry. Throws `ValidationError` (folding in `UnifiedNetworkDeclarationError`
 * from `services/networks`, which owns the unified-declaration parsing) on
 * ambiguous input — the central error middleware turns that into a 400.
 */
function translateTemplateNetworks<
  T extends Pick<CreateStackTemplateRequest, 'networks' | 'resourceOutputs' | 'resourceInputs' | 'services'>,
>(data: T): T {
  try {
    const translated = translateUnifiedNetworkDeclarations({
      networks: data.networks,
      resourceOutputs: data.resourceOutputs,
      resourceInputs: data.resourceInputs,
      services: data.services,
    });
    return {
      ...data,
      networks: translated.networks ?? [],
      resourceOutputs: translated.resourceOutputs,
      resourceInputs: translated.resourceInputs,
      services: translated.services ?? data.services,
    } as T;
  } catch (err) {
    if (err instanceof UnifiedNetworkDeclarationError) {
      throw new ValidationError(ErrorCode.STACK_NETWORK_DECLARATION_INVALID, err.message, {
        action: 'Fix the ambiguous network declaration and try again.',
      });
    }
    throw err;
  }
}

const router = Router();
const logger = getLogger("stacks", "stack-templates");

function getTemplateService() {
  return new StackTemplateService(prisma);
}

// GET / — List templates
router.get('/', requirePermission(Permission.StacksRead), asyncHandler(async (req, res) => {
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
}));

// GET /:templateId — Get template with current version
router.get('/:templateId', requirePermission(Permission.StacksRead), asyncHandler(async (req, res) => {
  const service = getTemplateService();
  const templateId = String(req.params.templateId);
  const template = await service.getTemplate(templateId);

  if (!template) {
    throw new NotFoundError(ErrorCode.STACK_TEMPLATE_NOT_FOUND, 'Template not found', {
      resource: { type: 'stackTemplate', id: templateId },
      action: 'Check the template ID or refresh the templates list.',
    });
  }

  res.json({ success: true, data: template });
}));

// GET /:templateId/versions — List all versions
router.get('/:templateId/versions', requirePermission(Permission.StacksRead), asyncHandler(async (req, res) => {
  const service = getTemplateService();
  const templateId = String(req.params.templateId);

  // Verify template exists
  const template = await service.getTemplate(templateId);
  if (!template) {
    throw new NotFoundError(ErrorCode.STACK_TEMPLATE_NOT_FOUND, 'Template not found', {
      resource: { type: 'stackTemplate', id: templateId },
      action: 'Check the template ID or refresh the templates list.',
    });
  }

  const versions = await service.listVersions(templateId);
  res.json({ success: true, data: versions });
}));

// GET /:templateId/versions/:versionId — Get specific version with services + config files
router.get('/:templateId/versions/:versionId', requirePermission(Permission.StacksRead), asyncHandler(async (req, res) => {
  const service = getTemplateService();
  const version = await service.getTemplateVersion(String(req.params.versionId));

  if (!version || version.templateId !== String(req.params.templateId)) {
    throw new NotFoundError(ErrorCode.STACK_TEMPLATE_VERSION_NOT_FOUND, 'Version not found', {
      resource: { type: 'stackTemplateVersion', id: String(req.params.versionId) },
      action: 'Check the version ID or refresh the template.',
    });
  }

  res.json({ success: true, data: version });
}));

// POST / — Create user template (with initial draft)
router.post('/', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
  // Same gate as POST /:templateId/draft: a vault section in the body
  // requires the elevated template-vault:write scope on top of stacks:write.
  // Session users always pass.
  if (draftHasVaultSection(req.body) && !callerHasScope(req, Permission.TemplateVaultWrite)) {
    throw new ForbiddenError(
      ErrorCode.STACK_TEMPLATE_VAULT_SCOPE_REQUIRED,
      'The vault section requires the template-vault:write scope',
      { action: 'Use an API key with the template-vault:write scope, or remove the vault section.' },
    );
  }
  if (draftHasNatsSection(req.body) && !callerHasScope(req, Permission.TemplateNatsWrite)) {
    throw new ForbiddenError(
      ErrorCode.STACK_TEMPLATE_NATS_SCOPE_REQUIRED,
      'The nats section requires the template-nats:write scope',
      { action: 'Use an API key with the template-nats:write scope, or remove the nats section.' },
    );
  }

  const parsed = createTemplateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
  }

  const templateInput = translateTemplateNetworks(parsed.data as CreateStackTemplateRequest);

  const service = getTemplateService();
  const template = await service.createUserTemplate(
    templateInput,
    (req as { user?: { id?: string } }).user?.id
  );

  logger.info({ templateId: template.id, templateName: template.name }, 'Template created');
  res.status(201).json({ success: true, data: template });
}));

// PATCH /:templateId — Update template metadata
router.patch('/:templateId', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
  const parsed = updateTemplateMetaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
  }

  const service = getTemplateService();
  const template = await service.updateTemplateMeta(String(req.params.templateId), parsed.data);

  res.json({ success: true, data: template });
}));

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
router.post('/:templateId/draft', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
  // Vault sections require an additional elevated scope on top of stacks:write.
  if (draftHasVaultSection(req.body) && !callerHasScope(req, Permission.TemplateVaultWrite)) {
    throw new ForbiddenError(
      ErrorCode.STACK_TEMPLATE_VAULT_SCOPE_REQUIRED,
      'The vault section requires the template-vault:write scope',
      { action: 'Use an API key with the template-vault:write scope, or remove the vault section.' },
    );
  }
  if (draftHasNatsSection(req.body) && !callerHasScope(req, Permission.TemplateNatsWrite)) {
    throw new ForbiddenError(
      ErrorCode.STACK_TEMPLATE_NATS_SCOPE_REQUIRED,
      'The nats section requires the template-nats:write scope',
      { action: 'Use an API key with the template-nats:write scope, or remove the nats section.' },
    );
  }

  const parsed = draftVersionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
  }

  const draftInput = translateTemplateNetworks(parsed.data as DraftVersionInput);

  const service = getTemplateService();
  const version = await service.createOrUpdateDraft(
    String(req.params.templateId),
    draftInput,
    (req as { user?: { id?: string } }).user?.id
  );

  res.json({ success: true, data: version });
}));

// POST /:templateId/publish — Publish draft
router.post('/:templateId/publish', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
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
}));

// DELETE /:templateId/draft — Discard draft
router.delete('/:templateId/draft', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
  const service = getTemplateService();
  await service.discardDraft(String(req.params.templateId));

  res.json({ success: true, message: 'Draft discarded' });
}));

// DELETE /:templateId — Delete template and all linked stacks
router.delete('/:templateId', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
  const service = getTemplateService();
  await service.deleteTemplate(String(req.params.templateId));

  res.json({ success: true, message: 'Template deleted' });
}));

// GET /:templateId/prerequisites — Precheck cross-stack prereqs for what
// would happen if this template were instantiated into the given scope.
// Used by the instantiate dialog to show a soft-warn before creation.
//
// `environmentId` is required when the template is environment-scoped
// (or `any`-scoped and the caller intends to instantiate into an env).
// Host-scoped templates don't need it; the route falls back to host
// scope when the template scope is `host` and no env is given.
router.get('/:templateId/prerequisites', requirePermission(Permission.StacksRead), asyncHandler(async (req, res) => {
  const service = getTemplateService();
  const templateId = String(req.params.templateId);
  const template = await service.getTemplate(templateId);
  if (!template) {
    throw new NotFoundError(ErrorCode.STACK_TEMPLATE_NOT_FOUND, 'Template not found', {
      resource: { type: 'stackTemplate', id: templateId },
      action: 'Check the template ID or refresh the templates list.',
    });
  }
  if (!template.currentVersionId || !template.currentVersion) {
    throw new ValidationError(
      ErrorCode.STACK_TEMPLATE_NOT_PUBLISHED,
      'Template has no published version',
      {
        resource: { type: 'stackTemplate', id: templateId, name: template.name },
        action: 'Publish a draft version of this template first.',
      },
    );
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
      throw new ValidationError(
        ErrorCode.STACK_ENVIRONMENT_ID_REQUIRED,
        'environmentId query parameter is required for environment-scoped templates',
        { action: 'Pass an environmentId query parameter.' },
      );
    }
    scope = { kind: 'environment', environmentId };
  } else {
    // 'any'
    scope = environmentId
      ? { kind: 'environment', environmentId }
      : { kind: 'host' };
  }

  // Prerequisite-authoring errors are a distinct 422 zone (neither a bad
  // request shape nor a state conflict) — kept as a locally-built response
  // rather than the 4xx taxonomy, which has no 422 member.
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
}));

// POST /:templateId/instantiate — Create stack from template
router.post('/:templateId/instantiate', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
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
}));

export default router;
