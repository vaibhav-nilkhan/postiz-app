import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostsService } from './posts.service';

const redisSet = vi.hoisted(() => vi.fn());

vi.mock('@sentry/nestjs', () => ({
  metrics: { count: vi.fn() },
}));

vi.mock('@gitroom/nestjs-libraries/redis/redis.service', () => ({
  ioRedis: { set: redisSet },
}));

const analytics = [
  {
    label: 'Views',
    data: [{ total: '42', date: '2026-08-22' }],
    percentageChange: 0,
  },
  {
    label: 'LinkedIn Impressions',
    data: [{ total: 7, date: '2026-08-21' }],
    percentageChange: 0,
  },
];

const post = {
  id: 'post-1',
  releaseId: 'provider-post-1',
  integration: {
    internalId: 'provider-account-1',
    providerIdentifier: 'supported-provider',
    token: 'provider-token',
    tokenExpiration: new Date('2999-01-01T00:00:00.000Z'),
  },
};

function postsServiceDouble(
  postResult: unknown = post,
  provider: { postAnalytics?: ReturnType<typeof vi.fn> } | undefined = {
    postAnalytics: vi.fn().mockResolvedValue(analytics),
  }
) {
  const postRepository = {
    getPostById: vi.fn().mockResolvedValue(postResult),
  };
  const integrationManager = {
    getSocialIntegration: vi.fn().mockReturnValue(provider),
  };
  const service = Object.assign(Object.create(PostsService.prototype), {
    _postRepository: postRepository,
    _integrationManager: integrationManager,
    _integrationService: { disconnectChannel: vi.fn() },
    _refreshIntegrationService: { refresh: vi.fn() },
  }) as PostsService;

  return { integrationManager, postRepository, service };
}

describe('PostsService post analytics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('passes through provider metric arrays without inventing a normalized schema', async () => {
    const provider = { postAnalytics: vi.fn().mockResolvedValue(analytics) };
    const doubles = postsServiceDouble(post, provider);

    await expect(
      doubles.service.checkPostAnalytics('organization-1', 'post-1', 30)
    ).resolves.toBe(analytics);

    expect(doubles.postRepository.getPostById).toHaveBeenCalledWith(
      'post-1',
      'organization-1'
    );
    expect(
      doubles.integrationManager.getSocialIntegration
    ).toHaveBeenCalledWith('supported-provider');
    expect(provider.postAnalytics).toHaveBeenCalledWith(
      'provider-account-1',
      'provider-token',
      'provider-post-1',
      30
    );
    expect(redisSet).toHaveBeenCalledOnce();
  });

  it('passes through a truthful empty provider response', async () => {
    const provider = { postAnalytics: vi.fn().mockResolvedValue([]) };
    const doubles = postsServiceDouble(post, provider);

    await expect(
      doubles.service.checkPostAnalytics('organization-1', 'post-1', 7)
    ).resolves.toEqual([]);
  });

  it('returns no metrics for an unsupported provider', async () => {
    const doubles = postsServiceDouble();
    doubles.integrationManager.getSocialIntegration.mockReturnValue(undefined);

    await expect(
      doubles.service.checkPostAnalytics('organization-1', 'post-1', 7)
    ).resolves.toEqual([]);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it.each([
    ['a missing post', null],
    ['a post without a release ID', { ...post, releaseId: null }],
    ['a post with an empty release ID', { ...post, releaseId: '' }],
  ])('returns no metrics for %s', async (_label, postResult) => {
    const doubles = postsServiceDouble(postResult);

    await expect(
      doubles.service.checkPostAnalytics('organization-1', 'post-1', 7)
    ).resolves.toEqual([]);
    expect(
      doubles.integrationManager.getSocialIntegration
    ).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('preserves the release lookup sentinel', async () => {
    const doubles = postsServiceDouble({ ...post, releaseId: 'missing' });

    await expect(
      doubles.service.checkPostAnalytics('organization-1', 'post-1', 7)
    ).resolves.toEqual({ missing: true });
    expect(
      doubles.integrationManager.getSocialIntegration
    ).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('rejects a cross-tenant post ID before provider lookup', async () => {
    const doubles = postsServiceDouble();
    doubles.postRepository.getPostById.mockImplementation(
      async (_postId, organizationId) =>
        organizationId === 'owner-organization' ? post : null
    );

    await expect(
      doubles.service.checkPostAnalytics('different-organization', 'post-1', 7)
    ).resolves.toEqual([]);
    expect(doubles.postRepository.getPostById).toHaveBeenCalledWith(
      'post-1',
      'different-organization'
    );
    expect(
      doubles.integrationManager.getSocialIntegration
    ).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('does not turn provider failures into metrics', async () => {
    const providerFailure = new Error('provider unavailable');
    const provider = {
      postAnalytics: vi.fn().mockRejectedValue(providerFailure),
    };
    const doubles = postsServiceDouble(post, provider);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await expect(
      doubles.service.checkPostAnalytics('organization-1', 'post-1', 7)
    ).resolves.toEqual([]);
    expect(log).toHaveBeenCalledWith(providerFailure);
    expect(redisSet).not.toHaveBeenCalled();

    log.mockRestore();
  });

  it.each([null, undefined, {}, 'metrics'])(
    'rejects malformed provider output %#',
    async (providerOutput) => {
      const provider = {
        postAnalytics: vi.fn().mockResolvedValue(providerOutput),
      };
      const doubles = postsServiceDouble(post, provider);

      await expect(
        doubles.service.checkPostAnalytics('organization-1', 'post-1', 7)
      ).resolves.toEqual([]);
      expect(redisSet).not.toHaveBeenCalled();
    }
  );
});
