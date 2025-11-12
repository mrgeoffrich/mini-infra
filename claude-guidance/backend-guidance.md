
## API Route Development Guide

### Creating New Routes

When creating new API routes in `server/src/routes/`, follow this pattern:

#### 1. Basic Route Structure
```typescript
import { appLogger } from "../lib/logger-factory";
import { requireSessionOrApiKey, getAuthenticatedUser } from "../middleware/auth";
import { z } from "zod";
import prisma from "../lib/prisma";

const logger = appLogger();
const router = express.Router();
// Your route handlers here...

export default router;
```

#### 2. Authentication Middleware Options

**ALWAYS import authentication middleware from `../middleware/auth`** - never import directly from lib files.

Available authentication middleware:
- **`requireSessionOrApiKey`** - Accepts either JWT session or API key (most common)
- **`requireAuth`** - Requires JWT session only (browser users)
- **`requireAuthorization`** - Advanced authorization checks
- **`requireOwnership(paramName)`** - Ensures user owns the resource

#### 3. Route Handler Pattern
```typescript

// POST endpoint with authentication
router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
```

#### 4. Validation with Zod
```typescript
const createSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional()
});

router.post('/', requireSessionOrApiKey, async (req, res) => {
  try {
    const validatedData = createSchema.parse(req.body);
    // Use validatedData...
  } catch (error) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: error.errors
    });
  }
});
```

### Authentication Import Rules

✅ **DO** import all auth functions from the centralized middleware:
```typescript
// CORRECT - Always use this
import {
  requireSessionOrApiKey,
  getAuthenticatedUser,
  requireAuth,
  getCurrentUserId
} from "../middleware/auth";
```

This ensures consistent authentication patterns and maintainable code across all routes.
