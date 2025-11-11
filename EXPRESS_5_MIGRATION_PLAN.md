# Express.js 5 Migration Plan

## Executive Summary

The Mini Infra application is currently running **Express.js 5.1.0** and requires a comprehensive review and update to ensure full compliance with Express 5 breaking changes and best practices. This migration plan outlines the necessary changes, verification steps, and testing strategy.

## Current Status

- **Current Express Version**: 5.1.0 (already upgraded)
- **Node.js Version**: Compatible (v20+)
- **Application Type**: Full-stack TypeScript application with 40+ route files
- **Risk Level**: Medium (already on Express 5, but may have non-compliant code patterns)

## Migration Categories

### ✅ Already Compliant

The following Express 5 requirements are already met:

1. **No deprecated methods**
   - No usage of `req.param(name)` found
   - No usage of `res.sendfile()` (lowercase) found
   - No usage of deprecated singular methods (`req.acceptsCharset`, etc.)
   - No usage of `app.del()` method

2. **Response signatures**
   - No old-style `res.json(obj, status)` patterns found
   - No old-style `res.send(body, status)` patterns found
   - Status codes are set correctly using `res.status(code).json()`

3. **Body parser configuration**
   - `express.urlencoded()` explicitly sets `extended: true` (Express 5 default is `false`)
   - `express.json()` has appropriate configuration with size limits

4. **Error handling**
   - Error handlers properly typed with 4 parameters `(error, req, res, next)`
   - Error handler positioned as last middleware
   - Proper error logging and response structure

### ⚠️ Requires Review

The following areas need investigation and potential changes:

#### 1. **Static File Serving & Dotfiles**

**Issue**: Express 5 changes the default `dotfiles` option from `'allow'` to `'ignore'`

**Current Code** (`server/src/app.ts:183`):
```typescript
app.use(express.static(path.join(__dirname, "../public")));
```

**Impact**:
- `.well-known` directories (ACME challenges, security.txt, etc.) will be blocked
- Other dotfiles in public directory will not be served

**Recommendation**:
```typescript
// Explicitly serve .well-known directory if needed
app.use('/.well-known', express.static(path.join(__dirname, "../public/.well-known"), {
  dotfiles: 'allow'
}));

// Main static files with explicit dotfiles setting
app.use(express.static(path.join(__dirname, "../public"), {
  dotfiles: 'ignore' // Explicit for clarity
}));
```

**Action Required**:
- [ ] Review if application serves any dotfiles or `.well-known` resources
- [ ] Update static middleware configuration if needed
- [ ] Test ACME/Let's Encrypt certificate renewals if using HTTP-01 challenges

#### 2. **Async/Await Error Handling**

**Issue**: Express 5 now automatically catches rejected promises from async route handlers

**Current Pattern** (`server/src/lib/error-handler.ts:113-119`):
```typescript
export const asyncHandler = (
  fn: (req: Request, res: Response, next: NextFunction) => Promise<void> | void,
) => {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};
```

**Impact**:
- The `asyncHandler` wrapper is **no longer necessary** in Express 5
- Can simplify code by removing the wrapper
- Native async/await support reduces boilerplate

**Recommendation**:
1. **Option A**: Keep `asyncHandler` for backwards compatibility (no breaking changes)
2. **Option B**: Remove `asyncHandler` and update all routes to use native async handlers

**Action Required**:
- [ ] Decide on migration strategy (gradual vs. immediate)
- [ ] Update route handlers to remove `asyncHandler` wrapper
- [ ] Test error propagation in async routes
- [ ] Update route development guide in CLAUDE.md

#### 3. **Route Path Patterns**

**Issue**: Express 5 has stricter route pattern syntax

**Search Results**: No problematic patterns found, but should verify:
- No wildcard `*` without naming (must use `/*splat`)
- No optional parameter syntax like `/:file.:ext?` (should be `/:file{.:ext}`)
- No unescaped regex characters `()[]?+!` in path strings

**Action Required**:
- [ ] Run automated codemod to detect edge cases
- [ ] Manual review of all route definitions in 40+ route files
- [ ] Test all route patterns with edge cases

#### 4. **Request Query Parameters**

**Issue**: Express 5 makes `req.query` a read-only getter

**Current Usage**: Multiple route files use `req.query` for reading query parameters

**Impact**:
- Cannot modify `req.query` directly
- Should already be read-only in practice

**Action Required**:
- [ ] Search for any code that attempts to modify `req.query`
- [ ] Verify query parameter validation works correctly with Zod schemas

#### 5. **MIME Type Changes**

**Issue**: Express 5 uses `mime-types` package with different defaults

**Changed MIME Types**:
- `.js`: `"text/javascript"` (was `"application/javascript"`)
- `.json`: `"application/json"` (was `"text/json"`)
- `.css`: `"text/css"` (was `"text/plain"`)
- `.svg`: `"image/svg+xml"` (was `"application/svg+xml"`)

**Impact**:
- May affect browser caching
- May affect CSP headers
- Should generally be improvements

**Action Required**:
- [ ] Verify frontend loads JavaScript, CSS, JSON, SVG correctly
- [ ] Check CSP headers in Helmet configuration if they include MIME types
- [ ] Test in multiple browsers

#### 6. **Error Handler Typing**

**Current Implementation** (`server/src/app.ts:216`):
```typescript
app.use(errorHandler as any);
```

**Issue**: Using `as any` bypasses TypeScript type checking

**Recommendation**:
```typescript
import { ErrorRequestHandler } from 'express';

export const errorHandler: ErrorRequestHandler = (
  error: AppError | ZodError,
  req: Request,
  res: Response,
  _next: NextFunction,
) => {
  // ... implementation
};
```

Then use without casting:
```typescript
app.use(errorHandler);
```

**Action Required**:
- [ ] Update error handler typing
- [ ] Remove `as any` cast
- [ ] Verify TypeScript compilation

### 🔧 Automated Migration Tools

Express provides official codemods for automated migration:

```bash
npx @expressjs/codemod upgrade
```

**Benefits**:
- Automatically detects deprecated patterns
- Suggests fixes for common issues
- Generates migration report

**Action Required**:
- [ ] Run codemod in dry-run mode to see suggested changes
- [ ] Review and apply automated fixes
- [ ] Commit changes separately for easy rollback

## Migration Strategy

### Phase 1: Analysis & Planning (Current Phase)
- [x] Review Express 5 migration guide
- [x] Analyze current codebase
- [x] Create migration plan
- [ ] Run automated codemod in dry-run mode
- [ ] Identify all areas requiring changes

### Phase 2: Low-Risk Changes
- [ ] Update error handler typing (remove `as any`)
- [ ] Explicitly set `dotfiles` option for `express.static()`
- [ ] Add comments documenting Express 5 specific behavior
- [ ] Update type definitions if needed

### Phase 3: Medium-Risk Changes
- [ ] Remove `asyncHandler` wrapper from routes (gradual migration)
- [ ] Update route handler patterns
- [ ] Test async error handling thoroughly

### Phase 4: Testing & Validation
- [ ] Run full test suite (`npm test`)
- [ ] Manual testing of all major features
- [ ] Test error scenarios and error handling
- [ ] Test static file serving (including edge cases)
- [ ] Load testing to verify performance
- [ ] Browser compatibility testing

### Phase 5: Documentation & Cleanup
- [ ] Update CLAUDE.md with Express 5 specific guidance
- [ ] Update route development guide
- [ ] Document removed patterns
- [ ] Update inline code comments

## Testing Checklist

### Unit Tests
- [ ] All existing Jest tests pass
- [ ] Test coverage maintained or improved
- [ ] Add tests for Express 5 specific behavior

### Integration Tests
- [ ] All API endpoints return correct responses
- [ ] Authentication flow works (Google OAuth)
- [ ] Error handling works correctly
- [ ] Async route handlers handle errors properly

### Manual Testing
- [ ] Login flow
- [ ] Container management operations
- [ ] PostgreSQL backup operations
- [ ] Deployment workflows
- [ ] Static file serving (frontend loads correctly)
- [ ] Health check endpoint
- [ ] API key authentication

### Edge Cases
- [ ] Invalid route parameters
- [ ] Malformed request bodies
- [ ] Concurrent requests
- [ ] Large payloads (10mb limit)
- [ ] Error scenarios (DB connection failures, etc.)

## Rollback Plan

If issues are discovered:

1. **Immediate Rollback** (if critical):
   ```bash
   git revert <migration-commit>
   npm install
   npm run build
   ```

2. **Selective Rollback**:
   - Revert specific changes using git
   - Keep non-breaking improvements

3. **Downgrade Express** (last resort):
   ```bash
   npm install express@4.21.2
   npm install @types/express@4.17.21
   ```

## Risk Assessment

| Category | Risk Level | Impact | Mitigation |
|----------|-----------|--------|------------|
| Static file serving | Low | .well-known routes may break | Explicit dotfiles configuration |
| Async error handling | Low | Already works, just simplification | Gradual migration, thorough testing |
| MIME types | Low | Frontend may not load correctly | Test in multiple browsers |
| Route patterns | Very Low | No problematic patterns found | Run codemod to verify |
| Type safety | Very Low | Improved with better typing | Remove `as any` casts |

**Overall Risk**: **Low**

The application is already running Express 5.1.0 in production, so the main goal is to ensure full compliance with Express 5 best practices and remove any remaining Express 4 patterns.

## Verification Commands

### Run Automated Codemod
```bash
cd server
npx @expressjs/codemod upgrade
```

### Search for Deprecated Patterns
```bash
# Check for req.param usage
npx grep -r "req\.param\(" src/

# Check for res.sendfile usage
npx grep -r "res\.sendfile\(" src/

# Check for old response signatures
npx grep -r "res\.(json|send|redirect)\(.+,\s*\d{3}" src/

# Check for asyncHandler usage
npx grep -r "asyncHandler" src/
```

### Run Tests
```bash
npm test
npm run test:coverage
npm run build
```

### Verify Running Application
```bash
npm run dev

# In another terminal:
curl http://localhost:5000/health
curl -H "x-api-key: <dev-key>" http://localhost:5000/api/containers
```

## Timeline Estimate

- **Phase 1 (Analysis)**: 2-4 hours
- **Phase 2 (Low-risk changes)**: 2-3 hours
- **Phase 3 (Medium-risk changes)**: 4-6 hours
- **Phase 4 (Testing)**: 4-8 hours
- **Phase 5 (Documentation)**: 2-3 hours

**Total Estimated Time**: 14-24 hours

## References

- [Express 5 Migration Guide](https://expressjs.com/en/guide/migrating-5.html)
- [Express 5 Breaking Changes](https://github.com/expressjs/express/blob/5.x/History.md)
- [Express Codemod Tool](https://github.com/expressjs/codemod)
- [Express TypeScript Examples](https://github.com/microsoft/TypeScript-Express-Starter)

## Next Steps

1. **Review and approve this migration plan**
2. **Run automated codemod** to identify any additional issues
3. **Create a migration branch** for tracking changes
4. **Execute Phase 2** (low-risk changes) first
5. **Deploy to staging/test environment** for validation
6. **Execute remaining phases** with thorough testing

## Sign-off

- [ ] Technical lead reviewed
- [ ] Migration plan approved
- [ ] Testing strategy confirmed
- [ ] Rollback plan validated
- [ ] Timeline accepted

---

**Document Version**: 1.0
**Created**: 2025-11-11
**Last Updated**: 2025-11-11
**Status**: Draft - Pending Review
