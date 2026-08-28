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

  async create(input: any) {
    const attempt = {
      ...input,
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
    return attempt;
  }

  async findByStateHash(stateHash: string) {
    return (
      [...this.attempts.values()].find(
        (attempt) => attempt.stateHash === stateHash
      ) || null
    );
  }

  async claimState(id: string, now: Date) {
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
    return attempt;
  }

  async fail(id: string, code: ConnectionAttemptFailureCode) {
    const attempt = this.attempts.get(id);
    if (!attempt || attempt.status === ConnectionAttemptStatus.SUCCEEDED)
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
    }
  }

  async getOwned(organizationId: string, id: string) {
    const attempt = this.attempts.get(id);
    return attempt?.organizationId === organizationId ? attempt : null;
  }

  async completeAuthentication(input: any) {
    this.completeAuthenticationCalls++;
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
    return { expired: false, attempt, option };
  }

  async completeSelection(input: any) {
    const attempt = this.attempts.get(input.attemptId);
    attempt.status = ConnectionAttemptStatus.SUCCEEDED;
    attempt.finalIntegrationId = 'integration-selected';
    attempt.finalIntegration = {
      ...finalIntegration('integration-selected'),
      providerIdentifier: attempt.provider,
    };
    attempt.completedAt = new Date();
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
      name === 'two-step' ? twoStepProvider : provider,
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
