import prisma from "./prisma";
import { appLogger } from "./logger-factory";

const logger = appLogger();

const MAX_FAILED_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 60 * 60 * 1000; // 1 hour

/**
 * Check if a user account is currently locked out
 */
export function checkLockout(user: {
  failedAttempts: number;
  lockedUntil: Date | null;
}): { locked: boolean; remainingMinutes?: number } {
  if (!user.lockedUntil) {
    return { locked: false };
  }

  const now = new Date();
  if (user.lockedUntil > now) {
    const remainingMs = user.lockedUntil.getTime() - now.getTime();
    const remainingMinutes = Math.ceil(remainingMs / (60 * 1000));
    return { locked: true, remainingMinutes };
  }

  // Lockout has expired
  return { locked: false };
}

/**
 * Record a failed login attempt. Locks the account after MAX_FAILED_ATTEMPTS.
 */
export async function recordFailedAttempt(userId: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { failedAttempts: true, lockedUntil: true },
  });

  if (!user) return;

  // If lockout expired, reset counter first
  let currentAttempts = user.failedAttempts;
  if (user.lockedUntil && user.lockedUntil <= new Date()) {
    currentAttempts = 0;
  }

  const newAttempts = currentAttempts + 1;
  const data: { failedAttempts: number; lockedUntil?: Date | null } = {
    failedAttempts: newAttempts,
  };

  if (newAttempts >= MAX_FAILED_ATTEMPTS) {
    data.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
    logger.warn(
      { userId, attempts: newAttempts },
      "Account locked due to too many failed login attempts",
    );
  }

  await prisma.user.update({ where: { id: userId }, data });
}

/**
 * Reset failed attempts and clear lockout after a successful login
 */
export async function resetFailedAttempts(userId: string): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { failedAttempts: 0, lockedUntil: null },
  });
}
