import { describe, expect, it, vi } from 'vitest';
import { NoAuthIntegrationsController } from './no.auth.integrations.controller';

describe('NoAuthIntegrationsController connection-attempt dispatch', () => {
  it('dispatches durable machine state before touching the legacy flow', async () => {
    const machineResponse = {
      id: 'attempt-1',
      postifyConnectionAttempt: { status: 'succeeded' },
    };
    const manager = {
      getAllowedSocialsIntegrations: () => ['direct'],
      getSocialIntegration: vi.fn(),
    };
    const attempts = {
      tryHandleCallback: vi.fn(async () => machineResponse),
    };
    const controller = new NoAuthIntegrationsController(
      manager as never,
      {} as never,
      {} as never,
      {} as never,
      attempts as never
    );

    await expect(
      controller.connectSocialMedia('direct', {
        state: 'durable-state',
        code: 'code',
        timezone: '0',
      })
    ).resolves.toBe(machineResponse);
    expect(attempts.tryHandleCallback).toHaveBeenCalledWith('direct', {
      state: 'durable-state',
      code: 'code',
      timezone: '0',
    });
    expect(manager.getSocialIntegration).not.toHaveBeenCalled();
  });

  it('keeps unmatched state on the legacy path', async () => {
    const manager = {
      getAllowedSocialsIntegrations: () => ['direct'],
      getSocialIntegration: vi.fn(() => ({ customFields: undefined })),
    };
    const attempts = { tryHandleCallback: vi.fn(async () => null) };
    const controller = new NoAuthIntegrationsController(
      manager as never,
      {} as never,
      {} as never,
      {} as never,
      attempts as never
    );

    await expect(
      controller.connectSocialMedia('direct', {
        state: 'legacy-state',
        code: 'code',
        timezone: '0',
      })
    ).rejects.toThrow('Invalid state');
    expect(manager.getSocialIntegration).toHaveBeenCalledWith('direct');
  });
});
