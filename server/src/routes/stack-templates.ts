import { Router, type Request } from 'express';
import * as yaml from 'js-yaml';
import type {
  StackTemplateSource,
  StackTemplateScope,
  CreateStackTemplateRequest,
  DraftVersionInput,
  TemplateExportEnvelope,
} from '@mini-infra/types';
import {
  hasPermission,
  Permission,
  ErrorCode,
  buildTemplateExportDocument,
  mapTemplateImportDocument,
} from '@mini-infra/types';
import prisma from '../lib/prisma';
import { getLogger } from '../lib/logger-factory';
import { asyncHandler } from '../lib/async-handler';
import { requirePermission } from '../middleware/auth';
import { NotFoundError, ValidationError, ForbiddenError } from '../lib/errors';
import { StackTemplateService } from '../services/stacks/stack-template-service';
import { evaluatePrerequisitesForTemplateVersion } from '../services/stacks/template-prerequisites';
import { listPredicateNames } from '../services/stacks/template-prerequisites/predicates';
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

// GET /predicates — The predicate names a template's `requires` block may use.
// The registry is code-only and fixed at build time, so the authoring UI has to
// be told what is in it; a hardcoded client copy would silently drift the first
// time a predicate is added or renamed, and the only feedback would be a 400 on
// save.
//
// MUST stay above `GET /:templateId` — Express matches in order, and below it
// "predicates" would be parsed as a template id.
router.get('/predicates', requirePermission(Permission.StacksRead), asyncHandler(async (_req, res) => {
  res.json({ success: true, data: { predicates: listPredicateNames() } });
}));

// GET /:templateId — Get template with current version
router.get('/:templateId', requirePermission(Permission.StacksRead), asyncHandler(async (req, res) => {
  const service = getTemplateService();
  const templateId = String(req.params.templateId);
  const template = await service.getTemplate(templateId, {
    includeLinkedStacks: req.query.includeLinkedStacks === 'true',
  });

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

// GET /:templateId/versions/:versionId/export — Serialize a version to a
// portable YAML document that can be imported on another Mini Infra instance.
// Literal Vault secrets are redacted (reported via `issues`); the client turns
// `yaml` into a file download and surfaces the issues.
router.get(
  '/:templateId/versions/:versionId/export',
  requirePermission(Permission.StacksRead),
  asyncHandler(async (req, res) => {
    const service = getTemplateService();
    const templateId = String(req.params.templateId);
    const template = await service.getTemplate(templateId);
    if (!template) {
      throw new NotFoundError(ErrorCode.STACK_TEMPLATE_NOT_FOUND, 'Template not found', {
        resource: { type: 'stackTemplate', id: templateId },
        action: 'Check the template ID or refresh the templates list.',
      });
    }

    const version = await service.getTemplateVersion(String(req.params.versionId));
    if (!version || version.templateId !== templateId) {
      throw new NotFoundError(ErrorCode.STACK_TEMPLATE_VERSION_NOT_FOUND, 'Version not found', {
        resource: { type: 'stackTemplateVersion', id: String(req.params.versionId) },
        action: 'Check the version ID or refresh the template.',
      });
    }

    const envelope: TemplateExportEnvelope = {
      name: template.name,
      displayName: template.displayName,
      description: template.description ?? undefined,
      category: template.category ?? undefined,
      scope: template.scope,
      networkType: template.networkType ?? undefined,
    };

    const { document, issues } = buildTemplateExportDocument({
      template: envelope,
      version,
      exportedAt: new Date().toISOString(),
    });

    const body = yaml.dump(document, { lineWidth: 120, noRefs: true, sortKeys: false });
    const filename = `${template.name}-v${version.version}.stack-template.yaml`;

    res.json({ success: true, data: { filename, yaml: body, issues } });
  }),
);

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

// POST /import — Create a user template from an exported YAML document.
//
// Single-segment path, so it never collides with the `/:templateId/...` POSTs
// (all of which have ≥2 segments). The file is parsed here (the YAML parser
// lives with the caller, per the transfer codec), mapped to a create request,
// then run through the exact same validation + creation path as `POST /` so an
// import can't produce a template a normal create couldn't. `createUserTemplate`
// hard-codes `source: "user"`, so importing a system template lands it as a user
// template automatically.
router.post('/import', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
  const rawYaml = (req.body as { yaml?: unknown })?.yaml;
  if (typeof rawYaml !== 'string' || rawYaml.trim() === '') {
    throw new ValidationError(ErrorCode.VALIDATION_FAILED, 'A "yaml" string body is required', {
      action: 'Send the exported template file contents as { "yaml": "<file contents>" }.',
    });
  }

  let parsedDoc: unknown;
  try {
    parsedDoc = yaml.load(rawYaml);
  } catch (err) {
    throw new ValidationError(
      ErrorCode.VALIDATION_FAILED,
      `The file is not valid YAML: ${err instanceof Error ? err.message : 'parse error'}`,
      { action: 'Re-export the template or fix the YAML syntax, then try again.' },
    );
  }

  const mapped = mapTemplateImportDocument(parsedDoc);
  if (!mapped.ok || !mapped.request) {
    // Blocking issues (bad format, missing name, unsupported version). Return
    // them so the import dialog can render exactly what's wrong.
    return res.status(400).json({
      success: false,
      message: 'Template import failed',
      issues: mapped.issues,
    });
  }

  // Optional name/displayName overrides let the operator rename on import —
  // required when the exported name already exists on this instance (a same-host
  // re-import would otherwise 409). The client import dialog collects these.
  const body = req.body as { name?: unknown; displayName?: unknown };
  if (typeof body.name === 'string' && body.name.trim() !== '') {
    mapped.request.name = body.name.trim();
  }
  if (typeof body.displayName === 'string' && body.displayName.trim() !== '') {
    mapped.request.displayName = body.displayName.trim();
  }

  // From here the mapped request is treated exactly like a POST / body: the same
  // elevated-scope gate on vault/nats sections, the same Zod validation, and the
  // same network translation.
  if (draftHasVaultSection(mapped.request) && !callerHasScope(req, Permission.TemplateVaultWrite)) {
    throw new ForbiddenError(
      ErrorCode.STACK_TEMPLATE_VAULT_SCOPE_REQUIRED,
      'The imported template has a vault section, which requires the template-vault:write scope',
      { action: 'Use an API key with the template-vault:write scope, or remove the vault section from the file.' },
    );
  }
  if (draftHasNatsSection(mapped.request) && !callerHasScope(req, Permission.TemplateNatsWrite)) {
    throw new ForbiddenError(
      ErrorCode.STACK_TEMPLATE_NATS_SCOPE_REQUIRED,
      'The imported template has a nats section, which requires the template-nats:write scope',
      { action: 'Use an API key with the template-nats:write scope, or remove the nats section from the file.' },
    );
  }

  const parsed = createTemplateSchema.safeParse(mapped.request);
  if (!parsed.success) {
    return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
  }

  const templateInput = translateTemplateNetworks(parsed.data as CreateStackTemplateRequest);

  const service = getTemplateService();
  const template = await service.createUserTemplate(
    templateInput,
    (req as { user?: { id?: string } }).user?.id,
  );

  logger.info({ templateId: template.id, templateName: template.name }, 'Template imported');
  // Non-blocking issues (redaction notices, the NATS-prefix allowlist caveat)
  // ride along so the client can surface them after a successful import.
  res.status(201).json({ success: true, data: template, issues: mapped.issues });
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

// POST /:templateId/rollback — Re-point currentVersion to an older published
// version. Body: { versionId }. 404 if the version doesn't belong to the
// template, 400 if it isn't published, 403 for system templates.
router.post('/:templateId/rollback', requirePermission(Permission.StacksWrite), asyncHandler(async (req, res) => {
  const versionId = typeof req.body?.versionId === 'string' ? req.body.versionId : '';
  if (!versionId) {
    throw new ValidationError(ErrorCode.VALIDATION_FAILED, 'versionId is required', {
      action: 'Pass the id of the published version to make current.',
    });
  }

  const service = getTemplateService();
  const template = await service.rollbackToVersion(String(req.params.templateId), versionId);

  logger.info(
    { templateId: req.params.templateId, versionId },
    'Template rolled back to earlier published version'
  );
  res.json({ success: true, data: template });
}));

// POST /:templateId/versions/:versionId/archive — Retire an old published
// version so it can no longer be instantiated, upgraded to, or made current.
// Body: { archived: boolean } — false un-archives. 404 if the version doesn't
// belong to the template, 400 for a draft or for the template's current
// version, 403 for system templates.
router.post(
  '/:templateId/versions/:versionId/archive',
  requirePermission(Permission.StacksWrite),
  asyncHandler(async (req, res) => {
    const archived = req.body?.archived;
    if (typeof archived !== 'boolean') {
      throw new ValidationError(ErrorCode.VALIDATION_FAILED, 'archived must be a boolean', {
        action: 'Pass { "archived": true } to archive, or false to restore.',
      });
    }

    const service = getTemplateService();
    const version = await service.setVersionArchived(
      String(req.params.templateId),
      String(req.params.versionId),
      archived,
    );

    logger.info(
      { templateId: req.params.templateId, versionId: req.params.versionId, archived },
      archived ? 'Template version archived' : 'Template version restored',
    );
    res.json({ success: true, data: version });
  }),
);

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
