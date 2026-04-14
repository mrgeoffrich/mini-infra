import { Router } from 'express';
import crudRoutes from './stacks-crud-routes';
import serviceRoutes from './stacks-service-routes';
import validationRoutes from './stacks-validation-routes';
import applyRoutes from './stacks-apply-route';
import updateRoutes from './stacks-update-route';
import destroyRoutes from './stacks-destroy-route';
import historyRoutes from './stacks-history-routes';
import { stacksErrorHandler } from './stacks-error-handler';

const router = Router();

// Route order matters: sub-routers that define specific paths like
// `/eligible-containers` and `/:stackId/...` must be composed in a way that
// avoids parameter-route collisions. All sub-routers mount at the same root;
// Express dispatches by matching the most-specific route first within each.
router.use(crudRoutes);
router.use(serviceRoutes);
router.use(validationRoutes);
router.use(applyRoutes);
router.use(updateRoutes);
router.use(destroyRoutes);
router.use(historyRoutes);

router.use(stacksErrorHandler);

export default router;
