# Username and Password Authentication System Design

## Executive Summary

This document outlines the design and implementation plan for adding username/password authentication to Mini Infra alongside the existing Google OAuth authentication. The system will use industry-standard bcrypt password hashing with automatic salting to ensure secure credential storage.

---

## Table of Contents

1. [Security Requirements](#security-requirements)
2. [Database Schema Changes](#database-schema-changes)
3. [Backend Implementation](#backend-implementation)
4. [Frontend Implementation](#frontend-implementation)
5. [Migration Strategy](#migration-strategy)
6. [Testing Strategy](#testing-strategy)
7. [Implementation Phases](#implementation-phases)
8. [Security Considerations](#security-considerations)

---

## Security Requirements

### Password Hashing Strategy

**Recommended: bcrypt**
- Industry-standard password hashing algorithm
- Automatic salt generation (29-character salt)
- Configurable work factor (cost factor)
- Resistant to rainbow table and brute-force attacks
- NPM package: `bcryptjs` (pure JavaScript, cross-platform)

**Configuration:**
```typescript
const BCRYPT_ROUNDS = 12; // Cost factor (2^12 iterations)
```

### Password Requirements

**Minimum Requirements:**
- Minimum 8 characters
- At least one uppercase letter (A-Z)
- At least one lowercase letter (a-z)
- At least one number (0-9)
- At least one special character (!@#$%^&*()_+-=[]{}|;:,.<>?)

**Optional Enhancements (Phase 2):**
- Check against common password lists (e.g., Have I Been Pwned API)
- Password history to prevent reuse
- Password expiration policy

### Account Security

**Rate Limiting:**
- Maximum 5 failed login attempts per account within 15 minutes
- Temporary account lockout: 15 minutes after 5 failed attempts
- Progressive lockout: increases with repeated failures

**Session Management:**
- Continue using existing JWT token system
- Token expiration: 24 hours (existing)
- Refresh token support (future enhancement)

### Username Requirements

**Format:**
- 3-30 characters
- Alphanumeric, underscores, hyphens, and periods allowed
- Case-insensitive (stored lowercase, searched lowercase)
- Must be unique across the system

---

## Database Schema Changes

### User Model Updates

**File:** `server/prisma/schema.prisma`

```prisma
model User {
  id            String    @id @default(cuid())
  email         String    @unique
  name          String?
  image         String?

  // OAuth fields (now optional)
  googleId      String?   @unique

  // Username/Password authentication fields
  username      String?   @unique
  passwordHash  String?   // bcrypt hash

  // Account security fields
  failedLoginAttempts Int      @default(0)
  lockedUntil         DateTime?
  lastLoginAt         DateTime?
  passwordChangedAt   DateTime?

  // Existing fields
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt

  // Relations
  apiKeys        ApiKey[]
  userPreference UserPreference?
  postgresServers PostgresServer[]
  passwordResetTokens PasswordResetToken[]

  @@map("users")
}
```

### New Model: Password Reset Tokens

```prisma
model PasswordResetToken {
  id          String   @id @default(cuid())
  userId      String
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  token       String   @unique // Cryptographically random token
  expiresAt   DateTime
  usedAt      DateTime?
  createdAt   DateTime @default(now())
  ipAddress   String?  // For security auditing
  userAgent   String?  // For security auditing

  @@index([userId])
  @@index([token])
  @@index([expiresAt])
  @@map("password_reset_tokens")
}
```

### Migration Script

**File:** `server/prisma/migrations/YYYYMMDDHHMMSS_add_username_password_auth/migration.sql`

```sql
-- Add new fields to users table
ALTER TABLE users ADD COLUMN username TEXT;
ALTER TABLE users ADD COLUMN passwordHash TEXT;
ALTER TABLE users ADD COLUMN failedLoginAttempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN lockedUntil DATETIME;
ALTER TABLE users ADD COLUMN lastLoginAt DATETIME;
ALTER TABLE users ADD COLUMN passwordChangedAt DATETIME;

-- Make googleId optional
-- SQLite doesn't support ALTER COLUMN, so we need to handle this in application logic

-- Create unique index on username (case-insensitive)
CREATE UNIQUE INDEX users_username_unique ON users(username COLLATE NOCASE);

-- Create password_reset_tokens table
CREATE TABLE password_reset_tokens (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  expiresAt DATETIME NOT NULL,
  usedAt DATETIME,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ipAddress TEXT,
  userAgent TEXT,
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX password_reset_tokens_userId_idx ON password_reset_tokens(userId);
CREATE INDEX password_reset_tokens_token_idx ON password_reset_tokens(token);
CREATE INDEX password_reset_tokens_expiresAt_idx ON password_reset_tokens(expiresAt);
```

---

## Backend Implementation

### 1. Password Hashing Utilities

**File:** `server/src/lib/password.ts`

```typescript
import bcrypt from 'bcryptjs';
import { appLogger } from './logger-factory';

const logger = appLogger();

// Cost factor (2^12 iterations)
const BCRYPT_ROUNDS = 12;

/**
 * Hash a plain text password using bcrypt
 */
export async function hashPassword(password: string): Promise<string> {
  try {
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    logger.debug('Password hashed successfully');
    return hash;
  } catch (error) {
    logger.error({ error }, 'Failed to hash password');
    throw new Error('Password hashing failed');
  }
}

/**
 * Verify a plain text password against a bcrypt hash
 */
export async function verifyPassword(
  password: string,
  hash: string
): Promise<boolean> {
  try {
    const isValid = await bcrypt.compare(password, hash);
    logger.debug({ isValid }, 'Password verification completed');
    return isValid;
  } catch (error) {
    logger.error({ error }, 'Password verification failed');
    return false;
  }
}

/**
 * Validate password strength
 */
export interface PasswordValidationResult {
  isValid: boolean;
  errors: string[];
}

export function validatePasswordStrength(
  password: string
): PasswordValidationResult {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push('Password must be at least 8 characters long');
  }

  if (!/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (!/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (!/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (!/[!@#$%^&*()_+\-=\[\]{}|;:,.<>?]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}

/**
 * Validate username format
 */
export interface UsernameValidationResult {
  isValid: boolean;
  errors: string[];
}

export function validateUsername(username: string): UsernameValidationResult {
  const errors: string[] = [];

  if (username.length < 3) {
    errors.push('Username must be at least 3 characters long');
  }

  if (username.length > 30) {
    errors.push('Username must not exceed 30 characters');
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(username)) {
    errors.push(
      'Username can only contain letters, numbers, underscores, hyphens, and periods'
    );
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}
```

### 2. Passport Local Strategy

**File:** `server/src/lib/passport-local.ts`

```typescript
import passport from 'passport';
import { Strategy as LocalStrategy } from 'passport-local';
import prisma from './prisma';
import { verifyPassword } from './password';
import { appLogger } from './logger-factory';

const logger = appLogger();

// Configure Local Strategy for username/password authentication
passport.use(
  'local',
  new LocalStrategy(
    {
      usernameField: 'username', // Can be username or email
      passwordField: 'password',
      passReqToCallback: true,
    },
    async (req, username, password, done) => {
      try {
        logger.info({ username }, 'Processing local authentication attempt');

        // Normalize username to lowercase for case-insensitive lookup
        const normalizedUsername = username.toLowerCase();

        // Find user by username or email
        let user = await prisma.user.findFirst({
          where: {
            OR: [
              { username: normalizedUsername },
              { email: normalizedUsername },
            ],
          },
        });

        if (!user) {
          logger.warn({ username }, 'User not found');
          return done(null, false, {
            message: 'Invalid username or password',
          });
        }

        // Check if account is locked
        if (user.lockedUntil && user.lockedUntil > new Date()) {
          const remainingMinutes = Math.ceil(
            (user.lockedUntil.getTime() - Date.now()) / 60000
          );
          logger.warn(
            { userId: user.id, remainingMinutes },
            'Account is locked'
          );
          return done(null, false, {
            message: `Account is locked. Please try again in ${remainingMinutes} minutes.`,
          });
        }

        // Check if user has a password set
        if (!user.passwordHash) {
          logger.warn(
            { userId: user.id },
            'User has no password set (OAuth-only account)'
          );
          return done(null, false, {
            message:
              'This account uses Google sign-in. Please use "Continue with Google".',
          });
        }

        // Verify password
        const isValidPassword = await verifyPassword(
          password,
          user.passwordHash
        );

        if (!isValidPassword) {
          // Increment failed login attempts
          const failedAttempts = user.failedLoginAttempts + 1;
          const shouldLock = failedAttempts >= 5;

          await prisma.user.update({
            where: { id: user.id },
            data: {
              failedLoginAttempts: failedAttempts,
              lockedUntil: shouldLock
                ? new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
                : null,
            },
          });

          logger.warn(
            { userId: user.id, failedAttempts },
            'Invalid password attempt'
          );

          if (shouldLock) {
            return done(null, false, {
              message:
                'Too many failed login attempts. Account locked for 15 minutes.',
            });
          }

          return done(null, false, {
            message: 'Invalid username or password',
          });
        }

        // Successful login - reset failed attempts and update last login
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            failedLoginAttempts: 0,
            lockedUntil: null,
            lastLoginAt: new Date(),
          },
        });

        logger.info({ userId: user.id }, 'Local authentication successful');
        return done(null, user);
      } catch (error) {
        logger.error({ error }, 'Error during local authentication');
        return done(error);
      }
    }
  )
);

logger.info('Local authentication strategy registered successfully');
```

### 3. Update Passport Configuration

**File:** `server/src/lib/passport.ts`

Add import at the top:
```typescript
import './passport-local'; // Initialize local strategy
```

### 4. New Authentication Routes

**File:** `server/src/routes/auth.ts` (additions)

```typescript
import { hashPassword, validatePasswordStrength, validateUsername } from '../lib/password';
import crypto from 'crypto';

// POST /auth/register - Register new user with username/password
router.post('/register', async (req: Request, res: Response) => {
  try {
    const { username, email, password, name } = req.body;

    // Validate input
    if (!username || !email || !password) {
      return res.status(400).json({
        error: 'Missing required fields: username, email, password',
      });
    }

    // Validate username format
    const usernameValidation = validateUsername(username);
    if (!usernameValidation.isValid) {
      return res.status(400).json({
        error: 'Invalid username',
        details: usernameValidation.errors,
      });
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        error: 'Password does not meet requirements',
        details: passwordValidation.errors,
      });
    }

    // Normalize username to lowercase
    const normalizedUsername = username.toLowerCase();

    // Check if username already exists
    const existingUser = await prisma.user.findFirst({
      where: {
        OR: [
          { username: normalizedUsername },
          { email: email.toLowerCase() },
        ],
      },
    });

    if (existingUser) {
      if (existingUser.username === normalizedUsername) {
        return res.status(409).json({ error: 'Username already exists' });
      }
      if (existingUser.email === email.toLowerCase()) {
        return res.status(409).json({ error: 'Email already registered' });
      }
    }

    // Hash password
    const passwordHash = await hashPassword(password);

    // Create user
    const user = await prisma.user.create({
      data: {
        username: normalizedUsername,
        email: email.toLowerCase(),
        name: name || username,
        passwordHash,
        passwordChangedAt: new Date(),
      },
    });

    logger.info({ userId: user.id, username }, 'New user registered');

    // Generate JWT token
    const token = generateToken(user as UserProfile);

    // Set JWT token as HTTP-only cookie
    const shouldUseSecureCookie = serverConfig.nodeEnv === 'production' && !securityConfig.allowInsecure;
    res.cookie('auth-token', token, {
      httpOnly: true,
      secure: shouldUseSecureCookie,
      sameSite: shouldUseSecureCookie ? 'strict' : 'lax',
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    });

    res.status(201).json({
      message: 'User registered successfully',
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        name: user.name,
      },
    });
  } catch (error) {
    logger.error({ error }, 'Registration error');
    res.status(500).json({ error: 'Registration failed' });
  }
});

// POST /auth/login - Login with username/password
router.post('/login', (req: Request, res: Response, next: NextFunction) => {
  passport.authenticate('local', (err: any, user: any, info: any) => {
    if (err) {
      logger.error({ error: err }, 'Login error');
      return res.status(500).json({ error: 'Login failed' });
    }

    if (!user) {
      logger.warn({ info }, 'Login failed - invalid credentials');
      return res.status(401).json({
        error: info?.message || 'Invalid username or password',
      });
    }

    try {
      // Generate JWT token
      const token = generateToken(user as UserProfile);

      // Set JWT token as HTTP-only cookie
      const shouldUseSecureCookie = serverConfig.nodeEnv === 'production' && !securityConfig.allowInsecure;
      res.cookie('auth-token', token, {
        httpOnly: true,
        secure: shouldUseSecureCookie,
        sameSite: shouldUseSecureCookie ? 'strict' : 'lax',
        maxAge: 24 * 60 * 60 * 1000, // 24 hours
      });

      logger.info({ userId: user.id }, 'User logged in successfully');

      res.json({
        message: 'Login successful',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          name: user.name,
        },
      });
    } catch (error) {
      logger.error({ error }, 'Error generating JWT after login');
      res.status(500).json({ error: 'Login failed' });
    }
  })(req, res, next);
});

// POST /auth/forgot-password - Request password reset
router.post('/forgot-password', async (req: Request, res: Response) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });

    // Always return success to prevent email enumeration
    if (!user) {
      logger.warn({ email }, 'Password reset requested for non-existent email');
      return res.json({
        message: 'If the email exists, a password reset link has been sent',
      });
    }

    // Check if user has password authentication enabled
    if (!user.passwordHash) {
      logger.warn(
        { userId: user.id },
        'Password reset requested for OAuth-only account'
      );
      return res.json({
        message: 'If the email exists, a password reset link has been sent',
      });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    // Store token in database
    await prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        token: resetToken,
        expiresAt,
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
      },
    });

    logger.info({ userId: user.id }, 'Password reset token generated');

    // TODO: Send email with reset link
    // For now, log the token (development only)
    if (serverConfig.nodeEnv === 'development') {
      logger.debug(
        { resetToken, userId: user.id },
        'Password reset token (DEV ONLY)'
      );
    }

    res.json({
      message: 'If the email exists, a password reset link has been sent',
    });
  } catch (error) {
    logger.error({ error }, 'Forgot password error');
    res.status(500).json({ error: 'Password reset request failed' });
  }
});

// POST /auth/reset-password - Reset password with token
router.post('/reset-password', async (req: Request, res: Response) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({
        error: 'Token and new password are required',
      });
    }

    // Validate new password
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        error: 'Password does not meet requirements',
        details: passwordValidation.errors,
      });
    }

    // Find valid token
    const resetToken = await prisma.passwordResetToken.findFirst({
      where: {
        token,
        expiresAt: { gt: new Date() },
        usedAt: null,
      },
      include: { user: true },
    });

    if (!resetToken) {
      return res.status(400).json({
        error: 'Invalid or expired reset token',
      });
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update user password and mark token as used
    await prisma.$transaction([
      prisma.user.update({
        where: { id: resetToken.userId },
        data: {
          passwordHash,
          passwordChangedAt: new Date(),
          failedLoginAttempts: 0,
          lockedUntil: null,
        },
      }),
      prisma.passwordResetToken.update({
        where: { id: resetToken.id },
        data: { usedAt: new Date() },
      }),
    ]);

    logger.info({ userId: resetToken.userId }, 'Password reset successfully');

    res.json({ message: 'Password reset successfully' });
  } catch (error) {
    logger.error({ error }, 'Reset password error');
    res.status(500).json({ error: 'Password reset failed' });
  }
});

// POST /auth/change-password - Change password (authenticated)
router.post('/change-password', requireAuth, async (req: Request, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const user = req.user!;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Current password and new password are required',
      });
    }

    // Validate new password
    const passwordValidation = validatePasswordStrength(newPassword);
    if (!passwordValidation.isValid) {
      return res.status(400).json({
        error: 'New password does not meet requirements',
        details: passwordValidation.errors,
      });
    }

    // Get full user record
    const fullUser = await prisma.user.findUnique({
      where: { id: user.id },
    });

    if (!fullUser || !fullUser.passwordHash) {
      return res.status(400).json({
        error: 'Password change not available for this account',
      });
    }

    // Verify current password
    const isValidPassword = await verifyPassword(
      currentPassword,
      fullUser.passwordHash
    );

    if (!isValidPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const passwordHash = await hashPassword(newPassword);

    // Update password
    await prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash,
        passwordChangedAt: new Date(),
      },
    });

    logger.info({ userId: user.id }, 'Password changed successfully');

    res.json({ message: 'Password changed successfully' });
  } catch (error) {
    logger.error({ error }, 'Change password error');
    res.status(500).json({ error: 'Password change failed' });
  }
});
```

### 5. Dependencies to Add

**File:** `server/package.json`

```json
{
  "dependencies": {
    "bcryptjs": "^2.4.3",
    "passport-local": "^1.0.0"
  },
  "devDependencies": {
    "@types/bcryptjs": "^2.4.6",
    "@types/passport-local": "^1.0.38"
  }
}
```

---

## Frontend Implementation

### 1. Update Login Page

**File:** `client/src/app/login/page.tsx`

Add tabs or toggle between OAuth and username/password login.

### 2. New Login Form Component

**File:** `client/src/components/login-form-local.tsx`

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { IconLoader2 } from '@tabler/icons-react';

export function LocalLoginForm() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch('/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
        credentials: 'include',
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Login failed');
      }

      // Redirect to dashboard on success
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="username">Username or Email</Label>
        <Input
          id="username"
          type="text"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Enter your username or email"
          required
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Enter your password"
          required
          disabled={isLoading}
        />
      </div>

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            Signing in...
          </>
        ) : (
          'Sign In'
        )}
      </Button>

      <div className="text-center">
        <a
          href="/forgot-password"
          className="text-sm text-primary hover:underline"
        >
          Forgot password?
        </a>
      </div>
    </form>
  );
}
```

### 3. Registration Form Component

**File:** `client/src/components/register-form.tsx`

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { IconLoader2 } from '@tabler/icons-react';

export function RegisterForm() {
  const [formData, setFormData] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
    name: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setValidationErrors([]);

    // Client-side validation
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/auth/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: formData.username,
          email: formData.email,
          password: formData.password,
          name: formData.name,
        }),
        credentials: 'include',
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.details) {
          setValidationErrors(data.details);
        }
        throw new Error(data.error || 'Registration failed');
      }

      // Redirect to dashboard on success
      navigate('/dashboard');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {validationErrors.length > 0 && (
        <Alert variant="destructive">
          <AlertDescription>
            <ul className="list-disc list-inside">
              {validationErrors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="username">Username</Label>
        <Input
          id="username"
          type="text"
          value={formData.username}
          onChange={(e) =>
            setFormData({ ...formData, username: e.target.value })
          }
          placeholder="Choose a username"
          required
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          value={formData.email}
          onChange={(e) => setFormData({ ...formData, email: e.target.value })}
          placeholder="your.email@example.com"
          required
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="name">Display Name (Optional)</Label>
        <Input
          id="name"
          type="text"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          placeholder="Your name"
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          value={formData.password}
          onChange={(e) =>
            setFormData({ ...formData, password: e.target.value })
          }
          placeholder="Choose a strong password"
          required
          disabled={isLoading}
        />
        <p className="text-xs text-muted-foreground">
          Min 8 characters, uppercase, lowercase, number, and special character
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">Confirm Password</Label>
        <Input
          id="confirmPassword"
          type="password"
          value={formData.confirmPassword}
          onChange={(e) =>
            setFormData({ ...formData, confirmPassword: e.target.value })
          }
          placeholder="Confirm your password"
          required
          disabled={isLoading}
        />
      </div>

      <Button type="submit" className="w-full" disabled={isLoading}>
        {isLoading ? (
          <>
            <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
            Creating account...
          </>
        ) : (
          'Create Account'
        )}
      </Button>
    </form>
  );
}
```

### 4. Updated Combined Login Page

**File:** `client/src/app/login/page.tsx` (update)

```tsx
import { useState } from 'react';
import { LoginForm } from '@/components/login-form'; // Google OAuth
import { LocalLoginForm } from '@/components/login-form-local';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Sign in to Mini Infra</CardTitle>
            <CardDescription>
              Choose your preferred sign-in method
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Tabs defaultValue="oauth" className="w-full">
              <TabsList className="grid w-full grid-cols-2">
                <TabsTrigger value="oauth">Google</TabsTrigger>
                <TabsTrigger value="local">Username/Password</TabsTrigger>
              </TabsList>

              <TabsContent value="oauth" className="mt-6">
                <LoginForm />
              </TabsContent>

              <TabsContent value="local" className="mt-6">
                <LocalLoginForm />
              </TabsContent>
            </Tabs>

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                Don't have an account?{' '}
                <a
                  href="/register"
                  className="text-primary hover:underline font-medium"
                >
                  Sign up
                </a>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

### 5. Registration Page

**File:** `client/src/app/register/page.tsx`

```tsx
import { RegisterForm } from '@/components/register-form';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export function RegisterPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Create an account</CardTitle>
            <CardDescription>
              Sign up to access Mini Infra
            </CardDescription>
          </CardHeader>
          <CardContent>
            <RegisterForm />

            <div className="mt-6 text-center">
              <p className="text-sm text-muted-foreground">
                Already have an account?{' '}
                <a
                  href="/login"
                  className="text-primary hover:underline font-medium"
                >
                  Sign in
                </a>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

### 6. Forgot Password Page

**File:** `client/src/app/forgot-password/page.tsx`

```tsx
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { IconLoader2 } from '@tabler/icons-react';

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const response = await fetch('/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        throw new Error('Request failed');
      }

      setSuccess(true);
    } catch (err) {
      setError('Failed to send reset email. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>
              Enter your email address and we'll send you a reset link
            </CardDescription>
          </CardHeader>
          <CardContent>
            {success ? (
              <Alert>
                <AlertDescription>
                  If an account exists with that email, we've sent a password
                  reset link. Please check your inbox.
                </AlertDescription>
              </Alert>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <Alert variant="destructive">
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input
                    id="email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="your.email@example.com"
                    required
                    disabled={isLoading}
                  />
                </div>

                <Button type="submit" className="w-full" disabled={isLoading}>
                  {isLoading ? (
                    <>
                      <IconLoader2 className="mr-2 h-4 w-4 animate-spin" />
                      Sending...
                    </>
                  ) : (
                    'Send Reset Link'
                  )}
                </Button>
              </form>
            )}

            <div className="mt-6 text-center">
              <a
                href="/login"
                className="text-sm text-primary hover:underline"
              >
                Back to sign in
              </a>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
```

### 7. Add Routes

**File:** `client/src/App.tsx` or routing configuration

Add routes for `/register`, `/forgot-password`, and `/reset-password`.

---

## Migration Strategy

### Existing Google OAuth Users

**Option 1: Automatic Username Generation**
- Generate username from email (e.g., `john.doe@example.com` → `john.doe`)
- Handle conflicts with numeric suffix
- Allow users to change username later

**Option 2: Prompt for Username**
- On next login, prompt OAuth users to set a username
- Optional password setup for dual authentication

### Linking Authentication Methods

Allow users to link both Google OAuth and username/password to the same account:

1. User logs in with Google OAuth
2. User can set a username and password in account settings
3. User can then use either method to log in

**Implementation:**
- Add a "Set Password" option in user settings
- Verify email ownership before allowing password creation
- Update User model to support both `googleId` and `passwordHash`

---

## Testing Strategy

### Unit Tests

**File:** `server/src/__tests__/password.test.ts`

```typescript
import { hashPassword, verifyPassword, validatePasswordStrength, validateUsername } from '../lib/password';

describe('Password Utilities', () => {
  describe('hashPassword', () => {
    it('should hash a password', async () => {
      const hash = await hashPassword('TestPassword123!');
      expect(hash).toBeDefined();
      expect(hash).not.toBe('TestPassword123!');
    });

    it('should generate different hashes for same password', async () => {
      const hash1 = await hashPassword('TestPassword123!');
      const hash2 = await hashPassword('TestPassword123!');
      expect(hash1).not.toBe(hash2); // Different salts
    });
  });

  describe('verifyPassword', () => {
    it('should verify correct password', async () => {
      const hash = await hashPassword('TestPassword123!');
      const isValid = await verifyPassword('TestPassword123!', hash);
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const hash = await hashPassword('TestPassword123!');
      const isValid = await verifyPassword('WrongPassword123!', hash);
      expect(isValid).toBe(false);
    });
  });

  describe('validatePasswordStrength', () => {
    it('should accept strong password', () => {
      const result = validatePasswordStrength('TestPassword123!');
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject short password', () => {
      const result = validatePasswordStrength('Test1!');
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Password must be at least 8 characters long');
    });

    it('should require all character types', () => {
      const result = validatePasswordStrength('testpassword');
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('validateUsername', () => {
    it('should accept valid username', () => {
      const result = validateUsername('john_doe');
      expect(result.isValid).toBe(true);
    });

    it('should reject short username', () => {
      const result = validateUsername('ab');
      expect(result.isValid).toBe(false);
    });

    it('should reject invalid characters', () => {
      const result = validateUsername('john@doe');
      expect(result.isValid).toBe(false);
    });
  });
});
```

### Integration Tests

**File:** `server/src/__tests__/auth-local.test.ts`

```typescript
import request from 'supertest';
import app from '../app';
import prisma from '../lib/prisma';

describe('Local Authentication', () => {
  beforeEach(async () => {
    // Clean up test data
    await prisma.user.deleteMany({
      where: { email: { contains: 'test@example.com' } },
    });
  });

  describe('POST /auth/register', () => {
    it('should register a new user', async () => {
      const response = await request(app)
        .post('/auth/register')
        .send({
          username: 'testuser',
          email: 'test@example.com',
          password: 'TestPassword123!',
          name: 'Test User',
        });

      expect(response.status).toBe(201);
      expect(response.body.user.username).toBe('testuser');
    });

    it('should reject weak password', async () => {
      const response = await request(app)
        .post('/auth/register')
        .send({
          username: 'testuser',
          email: 'test@example.com',
          password: 'weak',
        });

      expect(response.status).toBe(400);
      expect(response.body.details).toBeDefined();
    });
  });

  describe('POST /auth/login', () => {
    beforeEach(async () => {
      // Create test user
      await request(app).post('/auth/register').send({
        username: 'testuser',
        email: 'test@example.com',
        password: 'TestPassword123!',
      });
    });

    it('should login with correct credentials', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'TestPassword123!',
        });

      expect(response.status).toBe(200);
      expect(response.body.message).toBe('Login successful');
    });

    it('should reject incorrect password', async () => {
      const response = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'WrongPassword123!',
        });

      expect(response.status).toBe(401);
    });

    it('should lock account after 5 failed attempts', async () => {
      // Attempt 5 failed logins
      for (let i = 0; i < 5; i++) {
        await request(app).post('/auth/login').send({
          username: 'testuser',
          password: 'WrongPassword123!',
        });
      }

      // 6th attempt should be locked
      const response = await request(app)
        .post('/auth/login')
        .send({
          username: 'testuser',
          password: 'WrongPassword123!',
        });

      expect(response.status).toBe(401);
      expect(response.body.error).toContain('locked');
    });
  });
});
```

---

## Implementation Phases

### Phase 1: Backend Foundation (Week 1)
- [ ] Add bcryptjs and passport-local dependencies
- [ ] Update Prisma schema with username/password fields
- [ ] Create and run database migration
- [ ] Implement password hashing utilities
- [ ] Implement password and username validation
- [ ] Write unit tests for password utilities

### Phase 2: Authentication Logic (Week 1-2)
- [ ] Implement Passport local strategy
- [ ] Create registration endpoint
- [ ] Create login endpoint
- [ ] Implement account lockout mechanism
- [ ] Write integration tests for auth endpoints
- [ ] Test with Postman/curl

### Phase 3: Password Reset Flow (Week 2)
- [ ] Create PasswordResetToken model
- [ ] Implement forgot-password endpoint
- [ ] Implement reset-password endpoint
- [ ] Implement change-password endpoint
- [ ] Set up email sending (future: SMTP/SendGrid)
- [ ] Write tests for password reset flow

### Phase 4: Frontend UI (Week 2-3)
- [ ] Create LocalLoginForm component
- [ ] Create RegisterForm component
- [ ] Update LoginPage with tabs
- [ ] Create RegisterPage
- [ ] Create ForgotPasswordPage
- [ ] Create ResetPasswordPage
- [ ] Add route configurations

### Phase 5: Account Linking (Week 3)
- [ ] Add "Set Password" to user settings
- [ ] Allow OAuth users to add username/password
- [ ] Allow password users to link Google OAuth
- [ ] Update user profile UI

### Phase 6: Testing & Documentation (Week 3-4)
- [ ] End-to-end testing of all flows
- [ ] Security audit
- [ ] Performance testing
- [ ] User documentation
- [ ] API documentation

---

## Security Considerations

### Password Storage
- ✅ Never store passwords in plain text
- ✅ Use bcrypt with cost factor of 12
- ✅ Salts are automatically generated per password
- ✅ Password hashes are one-way (cannot be reversed)

### Account Protection
- ✅ Rate limiting on login attempts
- ✅ Account lockout after failed attempts
- ✅ Password reset tokens expire after 1 hour
- ✅ Tokens are single-use only
- ✅ Case-insensitive username lookup (prevent enumeration)

### Session Security
- ✅ HTTP-only cookies for JWT tokens
- ✅ Secure flag in production
- ✅ SameSite attribute
- ✅ 24-hour token expiration

### Input Validation
- ✅ Server-side validation for all inputs
- ✅ Password strength requirements enforced
- ✅ Username format validation
- ✅ Email format validation
- ✅ Sanitize inputs to prevent injection

### Information Disclosure
- ✅ Generic error messages for login failures
- ✅ Same response for existing/non-existing emails (forgot password)
- ✅ No user enumeration through registration
- ✅ Log security events for auditing

### Future Enhancements
- [ ] Two-factor authentication (2FA/TOTP)
- [ ] Email verification on registration
- [ ] Password breach detection (Have I Been Pwned)
- [ ] Session management (view/revoke active sessions)
- [ ] OAuth linking with email verification
- [ ] Audit log for authentication events
- [ ] CAPTCHA on repeated failed attempts

---

## API Endpoints Summary

| Method | Endpoint | Description | Auth Required |
|--------|----------|-------------|---------------|
| POST | `/auth/register` | Register new user | No |
| POST | `/auth/login` | Login with username/password | No |
| POST | `/auth/logout` | Logout (clear cookie) | Yes |
| GET | `/auth/status` | Check authentication status | No |
| GET | `/auth/user` | Get current user profile | Yes |
| POST | `/auth/forgot-password` | Request password reset | No |
| POST | `/auth/reset-password` | Reset password with token | No |
| POST | `/auth/change-password` | Change password | Yes |
| GET | `/auth/google` | Initiate Google OAuth | No |
| GET | `/auth/google/callback` | Google OAuth callback | No |

---

## Environment Variables

Add to `server/.env`:

```bash
# Existing
SESSION_SECRET=your-session-secret
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

# New (optional - for email sending)
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=noreply@example.com
SMTP_PASSWORD=your-smtp-password
FROM_EMAIL=noreply@example.com
```

---

## Conclusion

This design provides a comprehensive, secure username/password authentication system that:

1. **Securely stores passwords** using bcrypt with automatic salting
2. **Protects user accounts** with rate limiting and lockout mechanisms
3. **Supports both authentication methods** (OAuth and local) simultaneously
4. **Follows security best practices** for password management
5. **Provides a complete user experience** from registration to password reset
6. **Is well-tested** with unit and integration tests
7. **Can be implemented incrementally** using the phased approach

The implementation maintains backward compatibility with existing Google OAuth authentication while adding robust local authentication capabilities.
