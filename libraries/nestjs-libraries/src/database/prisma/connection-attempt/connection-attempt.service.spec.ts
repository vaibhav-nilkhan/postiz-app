import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionAttemptFailureCode,
  ConnectionAttemptStatus,
} from '@prisma/client';
import { ConnectionAttemptService } from './connection-attempt.service';

const directProvider = {
  identifier: 'direct',
  isBetweenSteps: false,
  generateAuthUrl: vi.fn(async () => ({
    url: 'https://provider.test/oauth?state=weak-state',
    state: 'weak-state',
    codeVerifier: 'pkce-verifier',
  })),
  authenticate: vi.fn(async () => ({
    id: 'provider-account-1',
    name: 'Direct account',
    accessToken: 'provider-access-token',
    refreshToken: 'provider-refresh-token',
    expiresIn: 3600,
    username: 'direct-user',
  })),
};

const twoStepProvider = {
  ...directProvider,
  identifier: 'two-step',
  isBetweenSteps: true,
  generateAuthUrl: vi.fn(async () => ({
    url: 'https://provider.test/oauth?state=weak-state',
    state: 'weak-state',
    codeVerifier: 'pkce-verifier',
  })),
  authenticate: vi.fn(async () => ({
    id: 'provider-root-1',
    name: 'Root account',
    accessToken: 'provider-access-token',
    refreshToken: 'provider-refresh-token',
    expiresIn: 3600,
    username: 'root-user',
  })),
  pages: vi.fn(async () => [
    {
      id: 'page-1',
      name: 'Safe page',
      username: 'safe-page',
      access_token: 'page-list-token-must-not-leak',
      picture: {
        data: {
          url: 'https://images.provider.test/page.png?access_token=secret',
        },
      },
    },
  ]),
  fetchPageInformation: vi.fn(async (_token: string, selection: any) => ({
    id: selection.page,
    name: 'Safe page',
    access_token: 'selected-page-token',
    picture: 'https://images.provider.test/page.png?secret=value',
    username: 'safe-page',
  })),
};

function finalIntegration(id = 'integration-final') {
  return {
    id,
    organizationId: 'org-1',
    customerId: 'customer-1',
    providerIdentifier: 'direct',
    disabled: false,
    inBetweenSteps: false,
    refreshNeeded: false,
    tokenExpiration: new Date('2026-09-01T00:00:00.000Z'),
    deletedAt: null,
  };
}

class MemoryRepository {
  attempts = new Map<string, any>();
  customers = new Set(['org-1:customer-1']);
  reconnects = new Map<string, any>();
  completeAuthenticationCalls = 0;
  completeAuthenticationError?: Error;
  completeAuthenticationErrorAfterCommit?: Error;
  completeSelectionError?: Error;
  completeSelectionErrorAfterCommit?: Error;

  async findCustomer(organizationId: string, customerId: string) {
    return this.customers.has(`${organizationId}:${customerId}`)
      ? { id: customerId }
      : null;
  }

  async findReconnectIntegration(
    organizationId: string,
    integrationId: string
  ) {
    const integration = this.reconnects.get(integrationId);
    return integration?.organizationId === organizationId ? integration : null;
  }

  async reserve(input: any) {
    const existing = [...this.attempts.values()].find(
      (attempt) =>
        attempt.organizationId === input.organizationId &&
        attempt.externalOperationRef === input.externalOperationRef
    );
    if (existing) {
      return { attempt: existing, created: false };
    }
    const attempt = {
      ...input,
      stateHash: null,
      stateCorrelation: null,
      authorizationContext: null,
      externalActorRef: input.externalActorRef || null,
      reconnectIntegrationId: input.reconnectIntegrationId || null,
      reconnectIntegration: input.reconnectIntegrationId
        ? this.reconnects.get(input.reconnectIntegrationId)
        : null,
      status: ConnectionAttemptStatus.PENDING,
      interimIntegrationId: null,
      interimIntegration: null,
      finalIntegrationId: null,
      finalIntegration: null,
      selectionMetadata: null,
      selectedOptionId: null,
      stateConsumedAt: null,
      completedAt: null,
      failedAt: null,
      failureCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.attempts.set(attempt.id, attempt);
    return { attempt, created: true };
  }

  async findByExternalOperation(
    organizationId: string,
    externalOperationRef: string
  ) {
    return (
      [...this.attempts.values()].find(
        (attempt) =>
          attempt.organizationId === organizationId &&
          attempt.externalOperationRef === externalOperationRef
      ) || null
    );
  }

  async activate(
    id: string,
    stateHash: string,
    stateCorrelation: string,
    authorizationContext: string
  ) {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.stateHash) return null;
    Object.assign(attempt, {
      stateHash,
      stateCorrelation,
      authorizationContext,
    });
    return attempt;
  }

  async findByStateHash(stateHash: string) {
    return (
      [...this.attempts.values()].find(
        (attempt) => attempt.stateHash === stateHash
      ) || null
    );
  }

  async claimState(id: string, now: Date, authorizationContext: string | null) {
    const attempt = this.attempts.get(id);
    if (
      !attempt ||
      attempt.status !== ConnectionAttemptStatus.PENDING ||
      attempt.stateConsumedAt ||
      attempt.expiresAt <= now
    ) {
      return null;
    }
    attempt.status = ConnectionAttemptStatus.AUTHENTICATING;
    attempt.stateConsumedAt = now;
    attempt.authorizationContext = authorizationContext;
    return attempt;
  }

  async clearAuthorizationContext(id: string) {
    const attempt = this.attempts.get(id);
    if (attempt?.status === ConnectionAttemptStatus.AUTHENTICATING) {
      attempt.authorizationContext = null;
    }
  }

  async fail(
    id: string,
    code: ConnectionAttemptFailureCode,
    allowedStatuses?: ConnectionAttemptStatus[]
  ) {
    const attempt = this.attempts.get(id);
    if (
      !attempt ||
      attempt.status === ConnectionAttemptStatus.SUCCEEDED ||
      (allowedStatuses && !allowedStatuses.includes(attempt.status))
    )
      return;
    attempt.status = ConnectionAttemptStatus.FAILED;
    attempt.failureCode = code;
    attempt.failedAt = new Date();
    attempt.stateConsumedAt ||= new Date();
    attempt.authorizationContext = null;
  }

  async expire(id: string, organizationId?: string) {
    const attempt = this.attempts.get(id);
    if (
      attempt &&
      (!organizationId || attempt.organizationId === organizationId) &&
      attempt.expiresAt <= new Date() &&
      ![
        ConnectionAttemptStatus.SUCCEEDED,
        ConnectionAttemptStatus.FAILED,
      ].includes(attempt.status)
    ) {
      attempt.status = ConnectionAttemptStatus.EXPIRED;
      attempt.failureCode = ConnectionAttemptFailureCode.EXPIRED;
      attempt.failedAt = new Date();
      attempt.stateConsumedAt ||= new Date();
      attempt.authorizationContext = null;
    }
  }

  async getOwned(organizationId: string, id: string) {
    const attempt = this.attempts.get(id);
    return attempt?.organizationId === organizationId ? attempt : null;
  }

  async completeAuthentication(input: any) {
    this.completeAuthenticationCalls++;
    if (this.completeAuthenticationError) {
      throw this.completeAuthenticationError;
    }
    const attempt = this.attempts.get(input.attemptId);
    if (input.selectionOptions) {
      attempt.status = ConnectionAttemptStatus.AWAITING_SELECTION;
      attempt.selectionMetadata = input.selectionOptions;
      attempt.interimIntegrationId = 'integration-interim';
      attempt.interimIntegration = {
        ...finalIntegration('integration-interim'),
        providerIdentifier: attempt.provider,
        inBetweenSteps: true,
        token: input.details.accessToken,
      };
    } else {
      attempt.status = ConnectionAttemptStatus.SUCCEEDED;
      attempt.finalIntegrationId =
        attempt.reconnectIntegrationId || 'integration-final';
      attempt.finalIntegration = {
        ...finalIntegration(attempt.finalIntegrationId),
        providerIdentifier: attempt.provider,
      };
      attempt.completedAt = new Date();
    }
    attempt.authorizationContext = null;
    if (this.completeAuthenticationErrorAfterCommit) {
      throw this.completeAuthenticationErrorAfterCommit;
    }
    return attempt;
  }

  async claimSelection(
    organizationId: string,
    id: string,
    selectionId: string
  ) {
    const attempt = await this.getOwned(organizationId, id);
    if (!attempt) return null;
    if (attempt.expiresAt <= new Date()) return { expired: true };
    const option = attempt.selectionMetadata?.find(
      (value: any) => value.id === selectionId
    );
    if (!option || !attempt.interimIntegration)
      throw new Error('bad selection');
    if (
      attempt.status === ConnectionAttemptStatus.SUCCEEDED &&
      attempt.selectedOptionId === selectionId
    ) {
      const option = attempt.selectionMetadata?.find(
        (value: any) => value.id === selectionId
      );
      return { expired: false, completed: true, attempt, option };
    }
    if (
      attempt.status !== ConnectionAttemptStatus.AWAITING_SELECTION &&
      !(
        attempt.status === ConnectionAttemptStatus.FINALIZING &&
        attempt.selectedOptionId === selectionId
      )
    ) {
      throw new Error('bad status');
    }
    attempt.status = ConnectionAttemptStatus.FINALIZING;
    attempt.selectedOptionId = selectionId;
    return { expired: false, completed: false, attempt, option };
  }

  async completeSelection(input: any) {
    if (this.completeSelectionError) {
      throw this.completeSelectionError;
    }
    const attempt = this.attempts.get(input.attemptId);
    attempt.status = ConnectionAttemptStatus.SUCCEEDED;
    attempt.finalIntegrationId = 'integration-selected';
    attempt.finalIntegration = {
      ...finalIntegration('integration-selected'),
      providerIdentifier: attempt.provider,
    };
    attempt.completedAt = new Date();
    if (this.completeSelectionErrorAfterCommit) {
      throw this.completeSelectionErrorAfterCommit;
    }
    return attempt;
  }
}

function harness(
  provider: any = directProvider,
  repository = new MemoryRepository()
) {
  const manager = {
    getAllowedSocialsIntegrations: () => ['direct', 'two-step'],
    getSocialIntegration: (name: string) =>
      name === provider.identifier
        ? provider
        : name === 'two-step'
        ? twoStepProvider
        : directProvider,
  };
  const refresh = { startRefreshWorkflow: vi.fn(async () => undefined) };
  const service = new ConnectionAttemptService(
    repository as never,
    manager as never,
    refresh as never
  );
  return { service, repository, refresh };
}

const createBody = {
  customerId: 'customer-1',
  provider: 'direct',
  purpose: 'connect' as const,
  returnTarget: 'postify',
  externalOperationRef: 'connect-operation-1',
  externalWorkspaceRef: 'workspace-1',
  externalActorRef: 'actor-1',
};

async function createdAttempt(
  service: ConnectionAttemptService,
  body: any = createBody
) {
  const created = await service.create({ id: 'org-1' } as never, body);
  const state = new URL(created.authorizationUrl).searchParams.get('state')!;
  return { created, state };
}

describe('ConnectionAttemptService', () => {
  beforeEach(() => {
    process.env.POSTIZ_CONNECTION_ATTEMPT_SECRET =
      '0123456789abcdef0123456789abcdef';
    process.env.POSTIZ_POSTIFY_OAUTH_PROVIDERS = 'direct,two-step';
    process.env.POSTIZ_POSTIFY_RETURN_URLS = JSON.stringify({
      postify: 'https://postify.test/settings/social/callback',
    });
    vi.clearAllMocks();
  });

  it('replays a serial create with the exact attempt and authorization URL', async () => {
    const { service, repository } = harness();
    const first = await service.create({ id: 'org-1' } as never, createBody);
    const replay = await service.create({ id: 'org-1' } as never, createBody);

    expect(replay).toEqual(first);
    expect(directProvider.generateAuthUrl).toHaveBeenCalledOnce();
    expect(repository.attempts.size).toBe(1);
    expect(JSON.stringify([...repository.attempts.values()])).not.toContain(
      first.authorizationUrl
    );
  });

  it('recovers a lost create response by external operation without regeneration', async () => {
    const { service } = harness();
    const created = await service.create({ id: 'org-1' } as never, createBody);

    const recovered = await service.readByExternalOperation(
      'org-1',
      createBody.externalOperationRef
    );
    expect(recovered).toEqual(created);
    expect(directProvider.generateAuthUrl).toHaveBeenCalledOnce();
    await expect(
      service.readByExternalOperation('org-2', createBody.externalOperationRef)
    ).rejects.toThrow('not found');
  });

  it('serializes concurrent creates to one generated authorization URL', async () => {
    const { service, repository } = harness();
    const [first, second] = await Promise.all([
      service.create({ id: 'org-1' } as never, createBody),
      service.create({ id: 'org-1' } as never, createBody),
    ]);

    expect(second).toEqual(first);
    expect(directProvider.generateAuthUrl).toHaveBeenCalledOnce();
    expect(repository.attempts.size).toBe(1);
  });

  it('rejects reuse of an external operation with mismatched identity', async () => {
    const { service } = harness();
    await service.create({ id: 'org-1' } as never, createBody);

    for (const mismatch of [
      { customerId: 'different-customer' },
      { provider: 'two-step' },
      {
        purpose: 'reauthorize' as const,
        reconnectIntegrationId: 'different-integration',
      },
      { returnTarget: 'different-return-target' },
      { externalActorRef: 'different-actor' },
      { externalWorkspaceRef: 'different-workspace' },
    ]) {
      await expect(
        service.create({ id: 'org-1' } as never, {
          ...createBody,
          ...mismatch,
        })
      ).rejects.toThrow('identity conflict');
    }
    expect(directProvider.generateAuthUrl).toHaveBeenCalledOnce();
    await expect(
      service.create({ id: 'org-1' } as never, {
        ...createBody,
        externalOperationRef: 'bad/reference',
      })
    ).rejects.toThrow('operation reference is invalid');
    expect(directProvider.generateAuthUrl).toHaveBeenCalledOnce();
  });

  it('completes a direct provider and exposes no credentials', async () => {
    const { service, repository } = harness();
    const { created, state } = await createdAttempt(service);
    expect(state).toHaveLength(43);
    expect(JSON.stringify([...repository.attempts.values()])).not.toContain(
      state
    );

    const callback = await service.tryHandleCallback('direct', {
      state,
      code: 'authorization-code',
      timezone: '0',
    });

    expect(callback?.postifyConnectionAttempt).toMatchObject({
      status: 'succeeded',
      customerId: 'customer-1',
      finalIntegrationId: 'integration-final',
    });
    const publicJson = JSON.stringify({ created, callback });
    for (const secret of [
      'provider-access-token',
      'provider-refresh-token',
      'pkce-verifier',
      'authorization-code',
    ]) {
      expect(publicJson).not.toContain(secret);
    }
    const recovery = await service.readByExternalOperation(
      'org-1',
      createBody.externalOperationRef
    );
    expect(recovery).not.toHaveProperty('authorizationUrl');
    expect(repository.attempts.get(created.id).authorizationContext).toBeNull();
  });

  it('keeps uncertain provider exchange and storage outcomes authenticating', async () => {
    for (const uncertainty of ['provider', 'storage'] as const) {
      const provider = {
        ...directProvider,
        authenticate:
          uncertainty === 'provider'
            ? vi.fn(async () => {
                throw new Error('provider timeout');
              })
            : directProvider.authenticate,
      };
      const { service, repository } = harness(provider);
      if (uncertainty === 'storage') {
        repository.completeAuthenticationError = new Error(
          'unknown commit outcome'
        );
      }
      const { created, state } = await createdAttempt(service, {
        ...createBody,
        externalOperationRef: `uncertain-${uncertainty}`,
      });

      const callback = await service.tryHandleCallback('direct', {
        state,
        code: 'one-time-code',
        timezone: '0',
      });
      expect(callback?.postifyConnectionAttempt).toMatchObject({
        status: 'authenticating',
      });
      expect(callback?.postifyConnectionAttempt).not.toHaveProperty(
        'failureCode'
      );
      expect(
        repository.attempts.get(created.id).authorizationContext
      ).toBeNull();
      await expect(
        service.tryHandleCallback('direct', {
          state,
          code: 'must-not-replay',
          timezone: '0',
        })
      ).rejects.toThrow('already used');
      expect(provider.authenticate).toHaveBeenCalledOnce();
    }
  });

  it('fails a definitive malformed authentication response', async () => {
    const provider = {
      ...directProvider,
      authenticate: vi.fn(async () => ({ error: 'invalid_grant' })),
    };
    const { service } = harness(provider);
    const { state } = await createdAttempt(service, {
      ...createBody,
      externalOperationRef: 'definitive-auth-failure',
    });

    const callback = await service.tryHandleCallback('direct', {
      state,
      code: 'code',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt).toMatchObject({
      status: 'failed',
      failureCode: 'authentication_failed',
    });
  });

  it('projects a committed authentication after an unknown commit acknowledgement', async () => {
    const { service, repository } = harness();
    repository.completeAuthenticationErrorAfterCommit = new Error(
      'commit acknowledgement lost'
    );
    const { state } = await createdAttempt(service, {
      ...createBody,
      externalOperationRef: 'committed-authentication',
    });

    const callback = await service.tryHandleCallback('direct', {
      state,
      code: 'one-time-code',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt).toMatchObject({
      status: 'succeeded',
      finalIntegrationId: 'integration-final',
    });
  });

  it('keeps uncertain two-step account enumeration authenticating', async () => {
    const provider = {
      ...twoStepProvider,
      pages: vi.fn(async () => {
        throw new Error('provider page read timeout');
      }),
    };
    const { service } = harness(provider);
    const { state } = await createdAttempt(service, {
      ...createBody,
      provider: 'two-step',
      externalOperationRef: 'uncertain-account-enumeration',
    });

    const callback = await service.tryHandleCallback('two-step', {
      state,
      code: 'one-time-code',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt.status).toBe('authenticating');
    expect(callback?.postifyConnectionAttempt).not.toHaveProperty(
      'failureCode'
    );
  });

  it('durably pauses and resumes a two-step provider with safe metadata', async () => {
    const { service, repository } = harness(twoStepProvider);
    const { created, state } = await createdAttempt(service, {
      ...createBody,
      provider: 'two-step',
    });
    await service.tryHandleCallback('two-step', {
      state,
      code: 'authorization-code',
      timezone: '0',
    });

    const pending = await service.read('org-1', created.id);
    expect(pending.status).toBe('awaiting_selection');
    expect(pending.metadata?.selection).toEqual([
      expect.objectContaining({ name: 'Safe page', username: 'safe-page' }),
    ]);
    expect(JSON.stringify(pending)).not.toContain('token');
    expect(JSON.stringify(pending)).not.toContain('payload');
    expect(pending.metadata?.selection[0].picture).toBe(
      'https://images.provider.test/page.png'
    );

    await expect(
      service.finalizeSelection('org-1', created.id, '0'.repeat(32))
    ).rejects.toThrow('selection is invalid');
    expect((await service.read('org-1', created.id)).status).toBe(
      'awaiting_selection'
    );

    const selectionId = pending.metadata!.selection[0].id;
    const resumedService = harness(twoStepProvider, repository).service;
    const completed = await resumedService.finalizeSelection(
      'org-1',
      created.id,
      selectionId
    );
    expect(completed).toMatchObject({
      status: 'succeeded',
      finalIntegrationId: 'integration-selected',
    });
    expect(twoStepProvider.fetchPageInformation).toHaveBeenCalledWith(
      'provider-access-token',
      expect.objectContaining({ id: 'page-1', page: 'page-1' })
    );
  });

  it('keeps uncertain selection reads/final writes resumable for the same selection', async () => {
    for (const uncertainty of ['provider-read', 'storage'] as const) {
      const provider = {
        ...twoStepProvider,
        fetchPageInformation: vi.fn(async (_token: string, selection: any) => ({
          id: selection.page,
          name: 'Safe page',
          access_token: 'selected-page-token',
          username: 'safe-page',
        })),
      };
      const { service, repository } = harness(provider);
      const { created, state } = await createdAttempt(service, {
        ...createBody,
        provider: 'two-step',
        externalOperationRef: `uncertain-${uncertainty}`,
      });
      await service.tryHandleCallback('two-step', {
        state,
        code: 'authorization-code',
        timezone: '0',
      });
      const pending = await service.read('org-1', created.id);
      const selectionId = pending.metadata!.selection[0].id;
      if (uncertainty === 'provider-read') {
        provider.fetchPageInformation.mockRejectedValueOnce(
          new Error('provider read timeout')
        );
      } else {
        repository.completeSelectionError = new Error('unknown commit outcome');
      }

      const uncertain = await service.finalizeSelection(
        'org-1',
        created.id,
        selectionId
      );
      expect(uncertain.status).toBe('finalizing');
      expect(uncertain).not.toHaveProperty('failureCode');

      repository.completeSelectionError = undefined;
      const recovered = await service.finalizeSelection(
        'org-1',
        created.id,
        selectionId
      );
      expect(recovered.status).toBe('succeeded');
      const providerReads = provider.fetchPageInformation.mock.calls.length;
      const replay = await service.finalizeSelection(
        'org-1',
        created.id,
        selectionId
      );
      expect(replay).toEqual(recovered);
      expect(provider.fetchPageInformation).toHaveBeenCalledTimes(
        providerReads
      );
      await expect(
        service.finalizeSelection('org-1', created.id, 'f'.repeat(32))
      ).rejects.toThrow('selection is invalid');
    }
  });

  it('fails a definitive mismatched selection response', async () => {
    const provider = {
      ...twoStepProvider,
      fetchPageInformation: vi.fn(async () => ({
        id: 'different-page',
        name: 'Wrong page',
        access_token: 'wrong-page-token',
        username: 'wrong-page',
      })),
    };
    const { service } = harness(provider);
    const { created, state } = await createdAttempt(service, {
      ...createBody,
      provider: 'two-step',
      externalOperationRef: 'definitive-selection-failure',
    });
    await service.tryHandleCallback('two-step', {
      state,
      code: 'authorization-code',
      timezone: '0',
    });
    const pending = await service.read('org-1', created.id);
    const result = await service.finalizeSelection(
      'org-1',
      created.id,
      pending.metadata!.selection[0].id
    );
    expect(result).toMatchObject({
      status: 'failed',
      failureCode: 'selection_failed',
    });
  });

  it('projects a committed selection after an unknown commit acknowledgement', async () => {
    const provider = {
      ...twoStepProvider,
      fetchPageInformation: vi.fn(async (_token: string, selection: any) => ({
        id: selection.page,
        name: 'Safe page',
        access_token: 'selected-page-token',
        username: 'safe-page',
      })),
    };
    const { service, repository } = harness(provider);
    const { created, state } = await createdAttempt(service, {
      ...createBody,
      provider: 'two-step',
      externalOperationRef: 'committed-selection',
    });
    await service.tryHandleCallback('two-step', {
      state,
      code: 'authorization-code',
      timezone: '0',
    });
    const pending = await service.read('org-1', created.id);
    repository.completeSelectionErrorAfterCommit = new Error(
      'commit acknowledgement lost'
    );

    const completed = await service.finalizeSelection(
      'org-1',
      created.id,
      pending.metadata!.selection[0].id
    );
    expect(completed).toMatchObject({
      status: 'succeeded',
      finalIntegrationId: 'integration-selected',
    });
  });

  it('records denial without calling a provider', async () => {
    const { service } = harness();
    const { state } = await createdAttempt(service);
    const callback = await service.tryHandleCallback('direct', {
      state,
      error: 'access_denied with unsafe provider details',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt).toMatchObject({
      status: 'failed',
      failureCode: 'access_denied',
    });
    expect(directProvider.authenticate).not.toHaveBeenCalled();
    expect(JSON.stringify(callback)).not.toContain('unsafe provider details');
  });

  it('expires before authentication and never calls a provider', async () => {
    const { service, repository } = harness();
    const { created, state } = await createdAttempt(service);
    repository.attempts.get(created.id).expiresAt = new Date(0);
    const callback = await service.tryHandleCallback('direct', {
      state,
      code: 'authorization-code',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt).toMatchObject({
      status: 'expired',
      failureCode: 'expired',
    });
    expect(directProvider.authenticate).not.toHaveBeenCalled();
  });

  it('ignores missing, malformed, and unknown legacy state', async () => {
    const { service } = harness();
    await expect(
      service.tryHandleCallback('direct', {
        state: '',
        code: 'code',
        timezone: '0',
      })
    ).resolves.toBeNull();
    await expect(
      service.tryHandleCallback('direct', {
        state: 'x'.repeat(513),
        code: 'code',
        timezone: '0',
      })
    ).resolves.toBeNull();
    await expect(
      service.tryHandleCallback('direct', {
        state: 'unknown-state',
        code: 'code',
        timezone: '0',
      })
    ).resolves.toBeNull();
  });

  it('fails a provider-mismatched callback closed', async () => {
    const { service } = harness();
    const { state } = await createdAttempt(service);
    const callback = await service.tryHandleCallback('two-step', {
      state,
      code: 'code',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt.failureCode).toBe(
      'provider_mismatch'
    );
    expect(directProvider.authenticate).not.toHaveBeenCalled();
  });

  it('fails a state whose durable correlation no longer matches identity', async () => {
    const { service, repository } = harness();
    const { created, state } = await createdAttempt(service);
    repository.attempts.get(created.id).stateCorrelation = '0'.repeat(64);
    const callback = await service.tryHandleCallback('direct', {
      state,
      code: 'code',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt).toMatchObject({
      status: 'failed',
      failureCode: 'invalid_state',
    });
    expect(directProvider.authenticate).not.toHaveBeenCalled();
  });

  it('rejects replay and allows only one concurrent callback claim', async () => {
    const { service, repository } = harness();
    const { state } = await createdAttempt(service);
    const [first, duplicate] = await Promise.allSettled([
      service.tryHandleCallback('direct', {
        state,
        code: 'code-1',
        timezone: '0',
      }),
      service.tryHandleCallback('direct', {
        state,
        code: 'code-2',
        timezone: '0',
      }),
    ]);
    expect([first.status, duplicate.status].sort()).toEqual([
      'fulfilled',
      'rejected',
    ]);
    expect(repository.completeAuthenticationCalls).toBe(1);
    await expect(
      service.tryHandleCallback('direct', {
        state,
        code: 'code-3',
        timezone: '0',
      })
    ).rejects.toThrow('already used');
  });

  it('blocks cross-organization customer, reconnect, read, and selection', async () => {
    const { service, repository } = harness();
    await expect(
      service.create({ id: 'org-2' } as never, createBody)
    ).rejects.toThrow('Customer not found');

    repository.reconnects.set('integration-1', {
      ...finalIntegration('integration-1'),
      internalId: 'provider-account-1',
      customerId: 'customer-1',
      providerIdentifier: 'direct',
    });
    repository.customers.add('org-2:customer-1');
    await expect(
      service.create({ id: 'org-2' } as never, {
        ...createBody,
        purpose: 'reauthorize',
        reconnectIntegrationId: 'integration-1',
      })
    ).rejects.toThrow('Reconnect integration not found');

    const { created } = await createdAttempt(service);
    await expect(service.read('org-2', created.id)).rejects.toThrow(
      'not found'
    );
    await expect(
      service.finalizeSelection('org-2', created.id, '0'.repeat(32))
    ).rejects.toThrow('not found');
  });

  it('fails wrong-account reauthorization without replacing identity', async () => {
    const provider = {
      ...directProvider,
      authenticate: vi.fn(async () => ({
        id: 'wrong-provider-account',
        name: 'Wrong',
        accessToken: 'wrong-token',
        username: 'wrong',
      })),
    };
    const { service, repository } = harness(provider);
    repository.reconnects.set('integration-1', {
      ...finalIntegration('integration-1'),
      internalId: 'provider-account-1',
      customerId: 'customer-1',
      providerIdentifier: 'direct',
    });
    const { state } = await createdAttempt(service, {
      ...createBody,
      purpose: 'reauthorize',
      reconnectIntegrationId: 'integration-1',
    });
    const callback = await service.tryHandleCallback('direct', {
      state,
      code: 'code',
      timezone: '0',
    });
    expect(callback?.postifyConnectionAttempt).toMatchObject({
      status: 'failed',
      failureCode: 'account_mismatch',
    });
    expect(repository.completeAuthenticationCalls).toBe(0);
  });

  it('projects only truthful local lifecycle facts', async () => {
    const { service, repository } = harness();
    const { created, state } = await createdAttempt(service);
    await service.tryHandleCallback('direct', {
      state,
      code: 'code',
      timezone: '0',
    });
    const attempt = repository.attempts.get(created.id);
    attempt.finalIntegration.disabled = true;
    attempt.finalIntegration.refreshNeeded = true;
    attempt.finalIntegration.deletedAt = new Date();
    const projection = await service.read('org-1', created.id);
    expect(projection.lifecycle).toEqual({
      disabled: true,
      setupIncomplete: false,
      refreshNeeded: true,
      tokenExpiresAt: '2026-09-01T00:00:00.000Z',
      softDeleted: true,
    });
    expect(projection).not.toHaveProperty('grantRevoked');
  });

  it('accepts only configured exact HTTPS return identities', async () => {
    const { service } = harness();
    await expect(
      service.create({ id: 'org-1' } as never, {
        ...createBody,
        returnTarget: 'https://evil.test',
      })
    ).rejects.toThrow('not allowed');
    process.env.POSTIZ_POSTIFY_RETURN_URLS = JSON.stringify({
      postify: 'https://user:pass@postify.test/callback',
    });
    await expect(
      service.create({ id: 'org-1' } as never, createBody)
    ).rejects.toThrow('invalid');
    process.env.POSTIZ_POSTIFY_RETURN_URLS = JSON.stringify({
      postify: 'https://postify.test/callback#https://evil.test',
    });
    await expect(
      service.create({ id: 'org-1' } as never, createBody)
    ).rejects.toThrow('invalid');
    process.env.POSTIZ_POSTIFY_RETURN_URLS = JSON.stringify({
      postify: 'https://postify.test/callback?next=https://evil.test',
    });
    await expect(
      service.create({ id: 'org-1' } as never, createBody)
    ).rejects.toThrow('invalid');
  });

  it('rejects provider classes outside the clean redirect contract', async () => {
    for (const unsafe of [
      { customFields: () => [] },
      { externalUrl: () => ({}) },
      { isChromeExtension: true },
      { isWeb3: true },
    ]) {
      const { service } = harness({ ...directProvider, ...unsafe });
      await expect(
        service.create({ id: 'org-1' } as never, createBody)
      ).rejects.toThrow('not supported');
    }
  });
});
