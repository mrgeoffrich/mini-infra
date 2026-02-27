# Local Username/Password Authentication - Implementation Plan

## Context

Mini Infra currently requires Google OAuth for all authentication. Every user deploying the app must create a Google Cloud Console project, configure OAuth credentials, and add them to environment variables. This is a significant barrier to adoption.

Every major self-hosted application (Portainer, Gitea, Nextcloud, Home Assistant, Grafana, Immich) uses **local username/password as the default** with a first-run setup wizard. OAuth/SSO is always optional, configured by the user if they want it.

This plan adds local auth as the default authentication method and makes Google OAuth optional. An existing design doc exists at `projectmanagement/username-password-auth-design.md` — this plan supersedes it with corrections for first-run detection, restricted registration, and a local-first login UI.

### Key Design Decisions

- **No separate username field** — the existing `email` field serves as the unique login identifier
- **No email-based password reset** — self-hosted apps often lack SMTP; instead, authenticated users can change their password, and admins can reset via DB in emergencies
- **No `passport-local`** — the app already uses stateless JWT auth; credential validation is implemented directly without Passport's local strategy overhead
- **Registration is restricted** — only the first user can self-register (via setup wizard). Future users would be added by an admin (Phase 2 work)
- **bcryptjs over bcrypt** — pure JavaScript, no native compilation, works on all platforms including Alpine Docker

---

## Phase 1: Database Schema & Dependencies

### Prisma Schema Changes

**File:** `server/prisma/schema.prisma`

Add to the `User` model:

```prisma
model User {
  // ... existing fields ...

  // Local auth fields
  passwordHash        String?       // bcrypt hash, null for Google-only users
  failedLoginAttempts Int       @default(0)
  lockedUntil         DateTime?     // Account lockout expiry
  lastLoginAt         DateTime?     // Last successful login
  passwordChangedAt   DateTime?     // When password was last changed
}
```

**Migration command:** `cd server && npx prisma migrate dev --name add_local_auth_fields`

This is a non-breaking migration — all new fields are nullable or have defaults. Existing Google OAuth users are unaffected.

### Dependencies

```bash
cd server && npm install bcryptjs && npm install -D @types/bcryptjs
```

---

## Phase 2: Shared Types

**File:** `lib/types/auth.ts`

### New Types

```typescript
// Setup status for first-run detection
export interface SetupStatus {
  needsSetup: boolean;
  googleOAuthAvailable: boolean;
}

// Local login
export interface LocalLoginRequest {
  email: string;
  password: string;
}

// First-run registration
export interface SetupRequest {
  email: string;
  password: string;
  name?: string;
}

// Password management
export interface ChangePasswordRequest {
  currentPassword?: string; // Optional for Google-only users setting first password
  newPassword: string;
}

export interface SetPasswordRequest {
  password: string;
}

export interface PasswordValidationResult {
  isValid: boolean;
  errors: string[];
}
```

### Extended Types

```typescript
// Add fields to AuthStatus
export interface AuthStatus {
  isAuthenticated: boolean;
  user: UserProfile | null;
  googleOAuthAvailable?: boolean;  // NEW
  hasPassword?: boolean;           // NEW
}

// Add loginLocal to AuthContextType
export type AuthContextType = {
  authState: AuthState;
  login: (options?: LoginOptions) => void;
  loginLocal: (email: string, password: string) => Promise<void>;  // NEW
  logout: (options?: LogoutOptions) => Promise<void>;
  refetch: () => Promise<unknown>;
};
```

**Rebuild:** `cd lib && npm run build`

---

## Phase 3: Server — Password Utilities

**New file:** `server/src/lib/password.ts`

Follows the pattern of other `lib/` utility modules like `jwt.ts`.

### Functions

```typescript
import bcrypt from "bcryptjs";

const BCRYPT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string>
export async function verifyPassword(password: string, hash: string): Promise<boolean>
export function validatePasswordStrength(password: string): PasswordValidationResult
```

### Password Requirements

Per NIST SP 800-63B guidelines (modern password policy):
- Minimum 8 characters
- At least one uppercase letter (A-Z)
- At least one lowercase letter (a-z)
- At least one number (0-9)
- **No special character requirement** — length and basic variety are sufficient

---

## Phase 4: Server — Setup Detection & Auth Status

**File:** `server/src/routes/auth.ts`

### New Endpoint: `GET /auth/setup-status`

No authentication required. Returns whether the app needs initial setup and what auth methods are available.

```typescript
// Response
{
  needsSetup: boolean;           // true when prisma.user.count() === 0
  googleOAuthAvailable: boolean; // true when GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are configured
}
```

### Helper Function

```typescript
function isGoogleOAuthConfigured(): boolean {
  // Check if Google OAuth credentials are set and not placeholder values
  const clientId = authConfig?.google?.clientId || process.env.GOOGLE_CLIENT_ID;
  const clientSecret = authConfig?.google?.clientSecret || process.env.GOOGLE_CLIENT_SECRET;
  return !!(clientId && clientSecret && clientId !== "not-configured" && clientSecret !== "not-configured");
}
```

### Updated Endpoint: `GET /auth/status`

Add `googleOAuthAvailable` and `hasPassword` to the response:

```typescript
// When authenticated, look up full user to check passwordHash
const fullUser = await prisma.user.findUnique({
  where: { id: req.user.id },
  select: { passwordHash: true },
});

const response: AuthStatus = {
  isAuthenticated: true,
  user: serializeUserProfile(req.user),
  googleOAuthAvailable: isGoogleOAuthConfigured(),
  hasPassword: !!fullUser?.passwordHash,
};
```

### JWT Middleware Update

**File:** `server/src/lib/jwt-middleware.ts`

Update the skip logic at line 56-63 to also skip the new public auth routes:

```typescript
// Current: skips /auth/* except /auth/status and /auth/user
// New: also needs to let /auth/setup-status, /auth/setup, and /auth/login pass through
// (These routes don't need JWT extraction since they handle their own auth)
if (
  (req.path.startsWith("/auth") &&
    req.path !== "/auth/status" &&
    req.path !== "/auth/user" &&
    req.path !== "/auth/change-password" &&
    req.path !== "/auth/set-password") ||
  req.path === "/health"
) {
  return next();
}
```

Note: `/auth/change-password` and `/auth/set-password` DO need JWT extraction (they require auth), so they must NOT be skipped.

---

## Phase 5: Server — Auth Routes

**File:** `server/src/routes/auth.ts`

### `POST /auth/setup` — First-Run Account Creation

- **No auth required** — only works when zero users exist
- Validates request body with Zod: `{ email: z.string().email(), password: z.string(), name: z.string().optional() }`
- Validates password strength via `validatePasswordStrength()`
- Checks `prisma.user.count()` === 0, returns 403 if users exist
- Creates user with `passwordHash` from `hashPassword()`
- Generates JWT token using existing `generateToken()`
- Sets HTTP-only cookie (reuse exact pattern from Google OAuth callback, lines 107-113)
- Returns `201` with `{ message, user: UserProfile }`

### `POST /auth/login` — Local Login

- **No auth required**
- Validates request body: `{ email: z.string().email(), password: z.string().min(1) }`
- Looks up user by email
- Checks lockout: if `lockedUntil > now()`, return 423 with "Account temporarily locked"
- Verifies password with `verifyPassword()`
- On failure: increment `failedLoginAttempts`, lock after 5 attempts for 15 minutes, return 401 "Invalid email or password"
- On success: reset `failedLoginAttempts`, clear `lockedUntil`, set `lastLoginAt`, issue JWT cookie, return 200
- **Rate limiting:** inherits any app-level rate limiting; account lockout handles per-account brute force

### `POST /auth/change-password` — Change Existing Password

- **Auth required** (JWT extraction + `requireAuth` middleware)
- Validates: `{ currentPassword: z.string(), newPassword: z.string() }`
- Verifies `currentPassword` against stored `passwordHash`
- If user has no `passwordHash` (Google-only), return 400 directing them to use `/auth/set-password`
- Validates new password strength
- Updates `passwordHash` and `passwordChangedAt`
- Returns 200

### `POST /auth/set-password` — Set Initial Password (for Google-only users)

- **Auth required**
- Validates: `{ password: z.string() }`
- Only works if user has no existing `passwordHash` (returns 400 otherwise)
- Validates password strength
- Sets `passwordHash` and `passwordChangedAt`
- Returns 200

### Cookie Pattern (reused from existing code)

```typescript
const shouldUseSecureCookie = serverConfig.nodeEnv === "production" && !securityConfig.allowInsecure;
res.cookie("auth-token", token, {
  httpOnly: true,
  secure: shouldUseSecureCookie,
  sameSite: shouldUseSecureCookie ? "strict" : "lax",
  maxAge: 24 * 60 * 60 * 1000, // 24 hours
});
```

---

## Phase 6: Client — Setup Wizard

### Setup Status Hook

**New file:** `client/src/hooks/use-setup-status.ts`

```typescript
// Fetches GET /auth/setup-status
// Returns { needsSetup, googleOAuthAvailable, isLoading, error }
// Uses TanStack Query with long staleTime (setup status rarely changes)
```

### Setup Page

**New file:** `client/src/app/setup/page.tsx`

Welcoming first-run page with:
- App logo/name
- "Set up Mini Infra" heading
- Description: "Create your admin account to get started"
- Fields: Email, Password, Confirm Password, Display Name (optional)
- Submit button: "Create Account"
- On success: auth cookie is set, redirect to `/dashboard`

### Setup Form Component

**New file:** `client/src/components/setup-form.tsx`

Uses established patterns:
- React Hook Form + `zodResolver`
- Zod schema with email validation, password strength checks, confirm password match
- shadcn/ui Card, Input, Button, Form components
- TanStack Query mutation for POST to `/auth/setup`
- Sonner toast on success/error
- Loading state on submit button

---

## Phase 7: Client — Login Form Update

**File:** `client/src/components/login-form.tsx`

Replace the current Google-only form with:

1. **Email input field**
2. **Password input field**
3. **"Sign in" button** (primary action)
4. **Error display** for invalid credentials
5. **Horizontal divider** with "or" text (only if Google is available)
6. **"Continue with Google" button** (secondary, only shown if `googleOAuthAvailable`)

The form uses React Hook Form + Zod for client-side validation. On submit, calls `loginLocal(email, password)` from the auth context. The Google button calls the existing `login()` function.

The `googleOAuthAvailable` flag comes from `useSetupStatus()` hook (which caches the setup-status response) or from the auth status response.

---

## Phase 8: Client — Auth Context Updates

### Auth Context

**File:** `client/src/lib/auth-context.tsx`

Add `loginLocal` function:

```typescript
const loginLocal = async (email: string, password: string) => {
  const response = await fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
    credentials: "include",
  });

  if (!response.ok) {
    const data = await response.json();
    throw new Error(data.error || "Login failed");
  }

  // Cookie is set by server, refetch auth status to update context
  await refetch();
  broadcastAuthEvent("AUTH_LOGIN");
};
```

The existing `login()` function (Google OAuth redirect) remains unchanged.

### Login Hook

**File:** `client/src/hooks/use-login.ts`

Expose `loginLocal` alongside existing `login`:

```typescript
export interface UseLoginResult {
  login: (options?: LoginOptions) => void;        // Google OAuth
  loginLocal: (email: string, password: string) => Promise<void>;  // Local
  isLoading: boolean;
  isAuthenticated: boolean;
}
```

---

## Phase 9: Client — Routing Updates

### New Route

**File:** `client/src/lib/routes.tsx`

Add `/setup` as a public restricted route:

```typescript
{
  path: "/setup",
  element: (
    <AuthErrorBoundary>
      <PublicRoute restricted>
        <SetupPage />
      </PublicRoute>
    </AuthErrorBoundary>
  ),
}
```

### Protected Route Update

**File:** `client/src/components/protected-route.tsx`

When the user is not authenticated, check `needsSetup` before deciding where to redirect:

```typescript
if (!authState.isAuthenticated && setupStatus?.needsSetup) {
  return <Navigate to="/setup" replace />;
}
if (!authState.isAuthenticated) {
  return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
}
```

The login page should also redirect to `/setup` if `needsSetup` is true, to prevent showing an empty login page on first run.

---

## Phase 10: Client — Password Change UI

### User Settings

**File:** `client/src/app/user/settings/page.tsx`

Add a new "Password & Security" card below the existing Timezone Settings card:

**If user has a password (`hasPassword` from auth status):**
- "Change Password" form: Current Password, New Password, Confirm New Password
- Submit calls `POST /auth/change-password`

**If user has no password (Google-only user):**
- "Set Password" form: New Password, Confirm New Password
- Description: "Set a password to enable email/password login alongside Google"
- Submit calls `POST /auth/set-password`

### Password Change Hook

**New file:** `client/src/hooks/use-change-password.ts`

TanStack Query mutation hook for password change/set API calls.

---

## Phase 11: Testing

### Unit Tests

**New file:** `server/src/__tests__/password.test.ts`

- `hashPassword` produces valid bcrypt hash
- `verifyPassword` returns true for correct, false for wrong password
- `validatePasswordStrength` accepts/rejects various passwords (edge cases: 7 chars, no uppercase, etc.)

### Integration Tests

**New file:** `server/src/__tests__/auth-local.test.ts`

- `POST /auth/setup` creates first user when no users exist
- `POST /auth/setup` returns 403 when users already exist
- `GET /auth/setup-status` returns `{ needsSetup: true }` with empty DB
- `GET /auth/setup-status` returns `{ needsSetup: false }` with existing users
- `POST /auth/login` with correct credentials returns 200 + sets cookie
- `POST /auth/login` with wrong password returns 401
- Account lockout after 5 failed attempts
- Lockout expires after 15 minutes
- `POST /auth/change-password` with valid current password succeeds
- `POST /auth/change-password` with wrong current password fails
- `POST /auth/set-password` works for Google-only users
- `POST /auth/set-password` fails for users with existing password
- `GET /auth/status` includes `hasPassword` and `googleOAuthAvailable`

Follow existing test patterns from `server/src/__tests__/` using Jest + Supertest with mocked Prisma.

---

## Migration Path for Existing Deployments

When an existing Mini Infra deployment (with Google OAuth users) upgrades:

1. **Prisma migration adds nullable columns** — no data loss, no breaking changes
2. **Existing Google OAuth users** have `passwordHash = null` and continue logging in via Google exactly as before
3. **`GET /auth/setup-status`** returns `{ needsSetup: false }` because users already exist — the setup wizard is never shown
4. **Login page** shows email/password fields plus the Google button — existing users click Google as before
5. **Optional password setup** — existing users can set a password via User Settings > Password & Security
6. **If Google OAuth is removed** (env vars unset) — users who set a password can still log in; users who never set one would need admin help

---

## Files Summary

### New Files (7)

| File | Purpose |
|------|---------|
| `server/src/lib/password.ts` | Password hashing, verification, validation |
| `client/src/app/setup/page.tsx` | First-run setup wizard page |
| `client/src/components/setup-form.tsx` | Setup form component |
| `client/src/hooks/use-setup-status.ts` | Hook for fetching setup status |
| `client/src/hooks/use-change-password.ts` | Hook for password change mutation |
| `server/src/__tests__/password.test.ts` | Password utility unit tests |
| `server/src/__tests__/auth-local.test.ts` | Local auth integration tests |

### Modified Files (11)

| File | Changes |
|------|---------|
| `server/prisma/schema.prisma` | Add 5 fields to User model |
| `server/package.json` | Add `bcryptjs` + `@types/bcryptjs` |
| `lib/types/auth.ts` | New types, extend `AuthStatus` and `AuthContextType` |
| `server/src/routes/auth.ts` | Add 5 new endpoints |
| `server/src/lib/jwt-middleware.ts` | Update route skip logic |
| `client/src/components/login-form.tsx` | Email/password form + optional Google |
| `client/src/lib/auth-context.tsx` | Add `loginLocal` function |
| `client/src/hooks/use-login.ts` | Expose `loginLocal` |
| `client/src/lib/routes.tsx` | Add `/setup` route |
| `client/src/components/protected-route.tsx` | Redirect to `/setup` when needed |
| `client/src/app/user/settings/page.tsx` | Add Password & Security card |

---

## Implementation Order

```
Phase 1  (DB + deps)        ─── no dependencies
Phase 2  (Shared types)     ─── no dependencies
Phase 3  (Password utils)   ─── depends on Phase 1 (bcryptjs)
Phase 4  (Setup detection)  ─── depends on Phases 1, 2
Phase 5  (Auth routes)      ─── depends on Phases 1-4
Phase 6  (Setup wizard)     ─── depends on Phases 2, 4
Phase 7  (Login form)       ─── depends on Phases 2, 5
Phase 8  (Auth context)     ─── depends on Phases 2, 7
Phase 9  (Routing)          ─── depends on Phases 6-8
Phase 10 (Password change)  ─── depends on Phases 2, 5
Phase 11 (Tests)            ─── depends on all above
```

## Verification Checklist

1. **Fresh install:** Start with empty DB → visit app → redirects to `/setup` → create account → lands on dashboard
2. **Local login:** Log out → login with email/password → works
3. **Google OAuth (optional):** Set `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` → login page shows Google button alongside email/password form
4. **Password change:** User settings → change password → works
5. **Account lockout:** 5 failed logins → account locked, returns 423 → unlocks after 15 min
6. **Existing deployments:** Existing Google OAuth users still work, can optionally set a password
7. **Tests pass:** `cd server && npm test`
