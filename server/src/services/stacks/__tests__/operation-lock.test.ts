import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StackOperationLock, STACK_OPERATION_LOCK_TTL_MS } from '../operation-lock';

describe('StackOperationLock', () => {
  let lock: StackOperationLock;

  beforeEach(() => {
    lock = new StackOperationLock();
  });

  it('has() returns false for unknown stack', () => {
    expect(lock.has('stack-1')).toBe(false);
  });

  it('tryAcquire() returns true on first attempt and false while held', () => {
    expect(lock.tryAcquire('stack-1')).toBe(true);
    expect(lock.tryAcquire('stack-1')).toBe(false);
    expect(lock.has('stack-1')).toBe(true);
  });

  it('release() allows re-acquisition', () => {
    lock.tryAcquire('stack-1');
    lock.release('stack-1');
    expect(lock.has('stack-1')).toBe(false);
    expect(lock.tryAcquire('stack-1')).toBe(true);
  });

  it('locks stacks independently', () => {
    expect(lock.tryAcquire('stack-1')).toBe(true);
    expect(lock.tryAcquire('stack-2')).toBe(true);
    expect(lock.has('stack-1')).toBe(true);
    expect(lock.has('stack-2')).toBe(true);
  });

  it('release() on unheld stack is a no-op', () => {
    expect(() => lock.release('nobody')).not.toThrow();
    expect(lock.has('nobody')).toBe(false);
  });
});

describe('StackOperationLock — staleness / TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exposes a generous default TTL (30 minutes)', () => {
    expect(STACK_OPERATION_LOCK_TTL_MS).toBe(30 * 60 * 1000);
  });

  it('has() reports a held lock as free once it is older than the TTL', () => {
    const lock = new StackOperationLock(1000);
    expect(lock.tryAcquire('stack-1')).toBe(true);
    expect(lock.has('stack-1')).toBe(true);

    // Advance past the TTL — the entry is now considered abandoned.
    vi.advanceTimersByTime(1001);
    expect(lock.has('stack-1')).toBe(false);
  });

  it('tryAcquire() steals a stale lock instead of 409-ing forever', () => {
    const lock = new StackOperationLock(1000);
    expect(lock.tryAcquire('stack-1')).toBe(true);
    // Still held before the TTL elapses.
    vi.advanceTimersByTime(500);
    expect(lock.tryAcquire('stack-1')).toBe(false);

    // After the TTL the next caller steals the lock.
    vi.advanceTimersByTime(600);
    expect(lock.tryAcquire('stack-1')).toBe(true);
  });

  it('a fresh acquisition after a steal resets the staleness clock', () => {
    const lock = new StackOperationLock(1000);
    lock.tryAcquire('stack-1');
    vi.advanceTimersByTime(1001);
    // Steal.
    expect(lock.tryAcquire('stack-1')).toBe(true);
    // The re-acquired lock is fresh again.
    expect(lock.has('stack-1')).toBe(true);
    expect(lock.tryAcquire('stack-1')).toBe(false);
  });
});
