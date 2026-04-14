import { describe, it, expect, beforeEach } from 'vitest';
import { StackOperationLock } from '../operation-lock';

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
