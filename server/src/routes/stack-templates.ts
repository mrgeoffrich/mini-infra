import { Router } from 'express';
import prisma from '../lib/prisma';
import { appLogger } from '../lib/logger-factory';
import { requirePermission } from '../middleware/auth';
import {
  StackTemplateService,
  TemplateError,
} from '../services/stacks/stack-template-service';
import {
  createTemplateSchema,
  updateTemplateMetaSchema,
  draftVersionSchema,
  publishDraftSchema,
  instantiateTemplateSchema,
} from '../services/stacks/stack-template-schemas';

const router = Router();
const logger = appLogger();

function getTemplateService() {
  return new StackTemplateService(prisma);
}

function handleTemplateError(error: unknown, res: any, fallbackMessage: string) {
  if (error instanceof TemplateError) {
    return res.status(error.statusCode).json({ success: false, message: error.message });
  }
  logger.error({ error }, fallbackMessage);
  return res.status(500).json({ success: false, message: fallbackMessage });
}

// GET / — List templates
router.get('/', requirePermission('stacks:read'), async (req, res) => {
  try {
    const service = getTemplateService();
    const { source, scope, includeArchived, includeLinkedStacks } = req.query;

    const templates = await service.listTemplates({
      source: source as any,
      scope: scope as any,
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
    const parsed = createTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const service = getTemplateService();
    const template = await service.createUserTemplate(
      parsed.data as any,
      (req as any).user?.id
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

// POST /:templateId/draft — Create or replace draft version
router.post('/:templateId/draft', requirePermission('stacks:write'), async (req, res) => {
  try {
    const parsed = draftVersionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ success: false, message: 'Validation failed', issues: parsed.error.issues });
    }

    const service = getTemplateService();
    const version = await service.createOrUpdateDraft(
      String(req.params.templateId),
      parsed.data as any,
      (req as any).user?.id
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
      (req as any).user?.id
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
