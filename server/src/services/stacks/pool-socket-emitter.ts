import { Channel, ServerEvent } from '@mini-infra/types';
import { emitToChannel } from '../../lib/socket';

/**
 * Typed wrappers around `emitToChannel` for pool instance lifecycle events.
 * Every emit is wrapped in try/catch — a socket failure must never break the
 * underlying spawn/reap/stop operation.
 */

export function emitPoolInstanceStarting(payload: {
  stackId: string;
  serviceName: string;
  instanceId: string;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.POOL_INSTANCE_STARTING, payload);
  } catch { /* never break the caller */ }
}

export function emitPoolInstanceStarted(payload: {
  stackId: string;
  serviceName: string;
  instanceId: string;
  containerId: string;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.POOL_INSTANCE_STARTED, payload);
  } catch { /* never break the caller */ }
}

export function emitPoolInstanceFailed(payload: {
  stackId: string;
  serviceName: string;
  instanceId: string;
  error: string;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.POOL_INSTANCE_FAILED, payload);
  } catch { /* never break the caller */ }
}

export function emitPoolInstanceIdleStopped(payload: {
  stackId: string;
  serviceName: string;
  instanceId: string;
  idleMinutes: number;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.POOL_INSTANCE_IDLE_STOPPED, payload);
  } catch { /* never break the caller */ }
}

export function emitPoolInstanceStopped(payload: {
  stackId: string;
  serviceName: string;
  instanceId: string;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.POOL_INSTANCE_STOPPED, payload);
  } catch { /* never break the caller */ }
}

/**
 * JobPool run terminated with exit code 0. Mirrors the NATS event published
 * to the per-pool JetStream history stream; this one is the realtime
 * fan-out for connected UI clients.
 */
export function emitJobPoolRunCompleted(payload: {
  stackId: string;
  serviceName: string;
  runId: string;
  triggerKind: 'cron' | 'nats-request' | 'manual';
  triggerName: string;
  /** Always 0 for completed runs; non-zero exits use `emitJobPoolRunFailed`. */
  exitCode: 0;
  startedAtMs: number;
  finishedAtMs: number;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.JOB_POOL_RUN_COMPLETED, payload);
  } catch { /* never break the caller */ }
}

/**
 * JobPool run terminated with a non-zero exit code, or was killed by the
 * `killAfterSeconds` reaper (in which case `exitCode === -1`).
 */
export function emitJobPoolRunFailed(payload: {
  stackId: string;
  serviceName: string;
  runId: string;
  triggerKind: 'cron' | 'nats-request' | 'manual';
  triggerName: string;
  exitCode: number;
  errorMessage: string;
  startedAtMs: number;
  finishedAtMs: number;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.JOB_POOL_RUN_FAILED, payload);
  } catch { /* never break the caller */ }
}

/**
 * Trigger fired but the JobPool's concurrency cap was already hit, so no run
 * was started. `PoolInstance` row is never created in this branch — only the
 * event is emitted, so the UI can surface "missed beats" without polluting
 * the pool's run history.
 */
export function emitJobPoolRunSkipped(payload: {
  stackId: string;
  serviceName: string;
  reason: 'concurrency_cap';
  triggerKind: 'cron' | 'nats-request' | 'manual';
  triggerName: string;
  scheduledAtMs: number;
  maxConcurrent: number;
}): void {
  try {
    emitToChannel(Channel.POOLS, ServerEvent.JOB_POOL_RUN_SKIPPED, payload);
  } catch { /* never break the caller */ }
}
