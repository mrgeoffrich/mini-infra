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
