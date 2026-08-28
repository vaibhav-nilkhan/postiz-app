import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it, vi } from 'vitest';
import { PostifyConnectionAttemptsController } from './postify.connection-attempts.controller';
import { PublicIntegrationsController } from './public.integrations.controller';
import { IntegrationsController } from '../../../api/routes/integrations.controller';

describe('PostifyConnectionAttemptsController contract', () => {
  it('derives organization from authentication and never forwards caller authority', async () => {
    const attempts = {
      create: vi.fn(async (...args: unknown[]) => args),
      read: vi.fn(async (...args: unknown[]) => args),
      finalizeSelection: vi.fn(async (...args: unknown[]) => args),
    };
    const controller = new PostifyConnectionAttemptsController(
      attempts as never
    );
    const organization = { id: 'authenticated-org' } as never;
    const body = {
      organizationId: 'attacker-org',
      customerId: 'customer-1',
      provider: 'direct',
      purpose: 'connect',
      returnTarget: 'postify',
      externalWorkspaceRef: 'workspace-1',
    } as never;

    await controller.create(organization, body);
    await controller.read(organization, 'attempt-1');
    await controller.select(organization, 'attempt-1', {
      selectionId: 'a'.repeat(32),
    });

    expect(attempts.create).toHaveBeenCalledWith(organization, body);
    expect(attempts.read).toHaveBeenCalledWith(
      'authenticated-org',
      'attempt-1'
    );
    expect(attempts.finalizeSelection).toHaveBeenCalledWith(
      'authenticated-org',
      'attempt-1',
      'a'.repeat(32)
    );
  });

  it('preserves legacy public and dashboard OAuth route paths', () => {
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        PublicIntegrationsController.prototype.getIntegrationUrl
      )
    ).toBe('/social/:integration');
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        IntegrationsController.prototype.getIntegrationUrl
      )
    ).toBe('/social/:integration');
    expect(
      Reflect.getMetadata(PATH_METADATA, PostifyConnectionAttemptsController)
    ).toBe('/public/v1/postify/connection-attempts');
  });
});
