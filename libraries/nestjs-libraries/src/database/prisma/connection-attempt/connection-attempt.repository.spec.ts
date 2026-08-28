import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionAttemptPurpose,
  ConnectionAttemptStatus,
} from '@prisma/client';
import { ConnectionAttemptRepository } from './connection-attempt.repository';
import { IntegrationRepository } from '../integrations/integration.repository';

function transactionDatabase() {
  const database: any = {
    connectionAttempt: {
      findUniqueOrThrow: vi.fn(),
      findFirstOrThrow: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(),
    },
    customer: { findFirst: vi.fn(async () => ({ id: 'customer-1' })) },
    integration: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (database: any) => unknown) =>
      callback(database)
    ),
  };
  return { database, prisma };
}

const authenticatingAttempt = {
  id: 'attempt-1',
  organizationId: 'org-1',
  customerId: 'customer-1',
  provider: 'direct',
  purpose: ConnectionAttemptPurpose.CONNECT,
  reconnectIntegrationId: null,
  reconnectIntegration: null,
  status: ConnectionAttemptStatus.AUTHENTICATING,
  expiresAt: new Date(Date.now() + 60_000),
};

describe('ConnectionAttemptRepository atomic ownership', () => {
  it('assigns the exact customer and marks direct success in one transaction', async () => {
    const { database, prisma } = transactionDatabase();
    database.connectionAttempt.findUniqueOrThrow.mockResolvedValue(
      authenticatingAttempt
    );
    database.connectionAttempt.findUnique.mockResolvedValue({
      ...authenticatingAttempt,
      status: ConnectionAttemptStatus.SUCCEEDED,
      finalIntegrationId: 'integration-1',
    });
    const integrations = {
      createOrUpdateIntegration: vi.fn(async () => ({ id: 'integration-1' })),
    };
    const repository = new ConnectionAttemptRepository(
      prisma as never,
      integrations as never
    );

    await repository.completeAuthentication({
      attemptId: 'attempt-1',
      details: {
        id: 'account-1',
        name: 'Account',
        accessToken: 'secret-token',
      },
      oneTimeToken: false,
    });

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(integrations.createOrUpdateIntegration).toHaveBeenCalledWith(
      undefined,
      false,
      'org-1',
      'Account',
      undefined,
      'social',
      'account-1',
      'direct',
      'secret-token',
      '',
      undefined,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      {
        customerId: 'customer-1',
        rootInternalId: 'account-1',
        database,
      }
    );
    expect(database.connectionAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'attempt-1',
        status: ConnectionAttemptStatus.AUTHENTICATING,
      },
      data: expect.objectContaining({
        status: ConnectionAttemptStatus.SUCCEEDED,
        finalIntegrationId: 'integration-1',
      }),
    });
  });

  it('atomically verifies interim ownership, assigns customer, and succeeds', async () => {
    const { database, prisma } = transactionDatabase();
    const interim = {
      id: 'interim-1',
      organizationId: 'org-1',
      customerId: 'customer-1',
      providerIdentifier: 'two-step',
      inBetweenSteps: true,
      deletedAt: null,
      refreshToken: 'refresh-secret',
      tokenExpiration: new Date('2026-09-01T00:00:00Z'),
      rootInternalId: 'root-1',
    };
    database.connectionAttempt.findFirstOrThrow.mockResolvedValue({
      id: 'attempt-1',
      organizationId: 'org-1',
      customerId: 'customer-1',
      provider: 'two-step',
      interimIntegration: interim,
    });
    database.integration.findUnique.mockResolvedValue(null);
    database.integration.update.mockResolvedValue({ id: 'interim-1' });
    database.connectionAttempt.findUnique.mockResolvedValue({
      id: 'attempt-1',
      status: ConnectionAttemptStatus.SUCCEEDED,
    });
    const repository = new ConnectionAttemptRepository(
      prisma as never,
      {} as never
    );

    await repository.completeSelection({
      organizationId: 'org-1',
      attemptId: 'attempt-1',
      selectionId: 'a'.repeat(32),
      information: {
        id: 'page-1',
        name: 'Page',
        access_token: 'page-token',
      },
    });

    expect(database.integration.update).toHaveBeenCalledWith({
      where: { id: 'interim-1', organizationId: 'org-1' },
      data: expect.objectContaining({
        internalId: 'page-1',
        token: 'page-token',
        customer: { connect: { id: 'customer-1' } },
        inBetweenSteps: false,
      }),
    });
    expect(database.connectionAttempt.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'attempt-1',
        organizationId: 'org-1',
        status: ConnectionAttemptStatus.FINALIZING,
        selectedOptionId: 'a'.repeat(32),
      },
      data: expect.objectContaining({
        status: ConnectionAttemptStatus.SUCCEEDED,
        finalIntegrationId: 'interim-1',
      }),
    });
  });

  it("rejects another attempt's interim integration before any write", async () => {
    const { database, prisma } = transactionDatabase();
    database.connectionAttempt.findFirstOrThrow.mockResolvedValue({
      id: 'attempt-1',
      organizationId: 'org-1',
      customerId: 'customer-1',
      provider: 'two-step',
      interimIntegration: {
        id: 'interim-other-attempt',
        organizationId: 'org-2',
        customerId: 'customer-2',
        providerIdentifier: 'two-step',
        inBetweenSteps: true,
        deletedAt: null,
      },
    });
    const repository = new ConnectionAttemptRepository(
      prisma as never,
      {} as never
    );

    await expect(
      repository.completeSelection({
        organizationId: 'org-1',
        attemptId: 'attempt-1',
        selectionId: 'a'.repeat(32),
        information: {
          id: 'page-1',
          name: 'Page',
          access_token: 'token',
        },
      })
    ).rejects.toThrow('ownership mismatch');
    expect(database.integration.update).not.toHaveBeenCalled();
    expect(database.connectionAttempt.updateMany).not.toHaveBeenCalled();
  });
});

describe('IntegrationRepository shared ownership hardening', () => {
  it('rejects a cross-organization customer ID before group assignment', async () => {
    const integrations = { update: vi.fn() };
    const customers = {
      findFirst: vi.fn(async () => null),
    };
    const repository = new IntegrationRepository(
      { model: { integration: integrations } } as never,
      {} as never,
      {} as never,
      {} as never,
      { model: { customer: customers } } as never,
      {} as never
    );

    await expect(
      repository.updateIntegrationGroup(
        'org-1',
        'integration-1',
        'customer-from-org-2'
      )
    ).rejects.toThrow('Customer not found in organization');
    expect(integrations.update).not.toHaveBeenCalled();
  });

  it('scopes page-selection mutation by organization, not bare ID', async () => {
    const integrations = {
      findFirst: vi.fn(async () => ({
        id: 'integration-1',
        providerIdentifier: 'two-step',
      })),
      findUnique: vi.fn(async () => null),
      update: vi.fn(async () => ({ id: 'integration-1' })),
    };
    const repository = new IntegrationRepository(
      { model: { integration: integrations } } as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await repository.updateIntegration('org-1', 'integration-1', {
      organizationId: 'org-1',
      internalId: 'page-1',
      providerIdentifier: 'two-step',
    });

    expect(integrations.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'integration-1', organizationId: 'org-1' },
      })
    );
  });
});
