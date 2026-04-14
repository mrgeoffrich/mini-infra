import { describe, it, expect, vi, beforeEach } from 'vitest';

const hoisted = vi.hoisted(() => ({
  createEvent: vi.fn(),
  updateEvent: vi.fn(),
  appendLogs: vi.fn(),
}));
const { createEvent, updateEvent, appendLogs } = hoisted;

vi.mock('../../user-events', () => ({
  UserEventService: class {
    createEvent = hoisted.createEvent;
    updateEvent = hoisted.updateEvent;
    appendLogs = hoisted.appendLogs;
  },
}));

import { StackUserEvent } from '../stack-user-event';

const fakePrisma = {} as never;

describe('StackUserEvent', () => {
  beforeEach(() => {
    createEvent.mockReset();
    updateEvent.mockReset();
    appendLogs.mockReset();
  });

  const createArgs = {
    eventType: 'stack_deploy' as const,
    eventCategory: 'infrastructure' as const,
    eventName: 'Deploy',
    status: 'running' as const,
    resourceId: 'stack-1',
  };

  it('captures the event id from begin() and exposes via id', async () => {
    createEvent.mockResolvedValue({ id: 'event-42' });
    const ev = new StackUserEvent(fakePrisma);
    await ev.begin(createArgs, 'failed to create');
    expect(ev.id).toBe('event-42');
  });

  it('swallows errors from begin() and leaves id undefined', async () => {
    createEvent.mockRejectedValue(new Error('db down'));
    const ev = new StackUserEvent(fakePrisma);
    await expect(ev.begin(createArgs, 'ctx')).resolves.toBeUndefined();
    expect(ev.id).toBeUndefined();
  });

  it('no-ops when begin() failed: update/appendLogs/updateProgress do nothing', async () => {
    createEvent.mockRejectedValue(new Error('db down'));
    const ev = new StackUserEvent(fakePrisma);
    await ev.begin(createArgs, 'ctx');

    await ev.appendLogs('line');
    await ev.updateProgress(50);
    await ev.update({ status: 'completed' });
    await ev.fail(new Error('boom'));

    expect(appendLogs).not.toHaveBeenCalled();
    expect(updateEvent).not.toHaveBeenCalled();
  });

  it('swallows appendLogs failure after a successful begin', async () => {
    createEvent.mockResolvedValue({ id: 'event-1' });
    appendLogs.mockRejectedValue(new Error('write failed'));

    const ev = new StackUserEvent(fakePrisma);
    await ev.begin(createArgs, 'ctx');
    await expect(ev.appendLogs('log')).resolves.toBeUndefined();
    expect(appendLogs).toHaveBeenCalledWith('event-1', 'log');
  });

  it('swallows updateProgress failure', async () => {
    createEvent.mockResolvedValue({ id: 'event-1' });
    updateEvent.mockRejectedValue(new Error('update failed'));

    const ev = new StackUserEvent(fakePrisma);
    await ev.begin(createArgs, 'ctx');
    await expect(ev.updateProgress(25)).resolves.toBeUndefined();
    expect(updateEvent).toHaveBeenCalledWith('event-1', { progress: 25 });
  });

  it('fail() writes failed status with error message + error type', async () => {
    createEvent.mockResolvedValue({ id: 'event-1' });
    updateEvent.mockResolvedValue({});

    const ev = new StackUserEvent(fakePrisma);
    await ev.begin(createArgs, 'ctx');

    class CustomBoom extends Error {}
    await ev.fail(new CustomBoom('kaboom'));

    expect(updateEvent).toHaveBeenCalledWith('event-1', {
      status: 'failed',
      errorMessage: 'kaboom',
      errorDetails: { type: 'CustomBoom', message: 'kaboom' },
    });
  });

  it('fail() handles non-Error rejections', async () => {
    createEvent.mockResolvedValue({ id: 'event-1' });
    updateEvent.mockResolvedValue({});

    const ev = new StackUserEvent(fakePrisma);
    await ev.begin(createArgs, 'ctx');
    await ev.fail('string rejection');

    expect(updateEvent).toHaveBeenCalledWith(
      'event-1',
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'string rejection',
      }),
    );
  });
});
