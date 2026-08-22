import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostsService } from './posts.service';

vi.mock('@sentry/nestjs', () => ({
  metrics: { count: vi.fn() },
}));

const publicationIdempotency = {
  idempotencyKey: 'idempotency-key-1',
  requestHash: 'request-hash-1',
};

const body = {
  type: 'schedule',
  date: '2099-01-01T10:00:00.000Z',
  shortLink: false,
  tags: [],
  posts: [
    {
      integration: { id: 'integration-1' },
      value: [{ content: 'approved caption', image: [] }],
      settings: { __type: 'linkedin' },
    },
  ],
};

const replayedPosts = [
  { postId: 'winner-post-1', integration: 'integration-1' },
];

function prismaError(code: 'P2002' | 'P2034') {
  return Object.assign(new Error(`Prisma ${code}`), { code });
}

function postsServiceDouble() {
  const transactionDatabase = {};
  const postRepository = {
    createOrUpdatePost: vi.fn().mockResolvedValue({
      posts: [{ id: 'created-post-1', state: 'QUEUE' }],
    }),
  };
  const publicationAttemptService = {
    resolvePublicationRequest: vi.fn(),
    createPublicationRequest: vi.fn(),
  };
  const prisma = { $transaction: vi.fn() };
  const service = Object.assign(Object.create(PostsService.prototype), {
    _postRepository: postRepository,
    _integrationManager: {
      getSocialIntegration: vi.fn().mockReturnValue(undefined),
    },
    _shortLinkService: {},
    _prisma: prisma,
    _publicationAttemptService: publicationAttemptService,
  }) as PostsService;
  const startWorkflow = vi
    .spyOn(service, 'startWorkflow')
    .mockResolvedValue(undefined);

  return {
    postRepository,
    prisma,
    publicationAttemptService,
    service,
    startWorkflow,
    transactionDatabase,
  };
}

function createIdempotentPost(service: PostsService) {
  return service.createPost(
    'organization-1',
    body as never,
    'API',
    false,
    publicationIdempotency
  );
}

describe('PostsService publication request transaction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retries P2034 and replays the concurrent winner', async () => {
    const doubles = postsServiceDouble();
    const writeConflict = prismaError('P2034');
    doubles.publicationAttemptService.resolvePublicationRequest
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replayedPosts);
    doubles.prisma.$transaction
      .mockImplementationOnce(async (callback) => {
        await callback(doubles.transactionDatabase);
        throw writeConflict;
      })
      .mockImplementationOnce((callback) =>
        callback(doubles.transactionDatabase)
      );

    await expect(createIdempotentPost(doubles.service)).resolves.toEqual(
      replayedPosts
    );

    expect(doubles.prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(doubles.postRepository.createOrUpdatePost).toHaveBeenCalledTimes(1);
    expect(
      doubles.publicationAttemptService.createPublicationRequest
    ).toHaveBeenCalledTimes(1);
    expect(doubles.startWorkflow).not.toHaveBeenCalled();
  });

  it('starts one workflow when a P2034 retry creates the request', async () => {
    const doubles = postsServiceDouble();
    const writeConflict = prismaError('P2034');
    doubles.publicationAttemptService.resolvePublicationRequest.mockResolvedValue(
      null
    );
    doubles.prisma.$transaction
      .mockImplementationOnce(async (callback) => {
        await callback(doubles.transactionDatabase);
        throw writeConflict;
      })
      .mockImplementationOnce((callback) =>
        callback(doubles.transactionDatabase)
      );

    await expect(createIdempotentPost(doubles.service)).resolves.toEqual([
      { postId: 'created-post-1', integration: 'integration-1' },
    ]);

    expect(doubles.postRepository.createOrUpdatePost).toHaveBeenCalledTimes(2);
    expect(doubles.startWorkflow).toHaveBeenCalledTimes(1);
    expect(doubles.startWorkflow).toHaveBeenCalledWith(
      'linkedin',
      'created-post-1',
      'organization-1',
      'QUEUE'
    );
  });

  it('throws P2034 after the bounded transaction attempts are exhausted', async () => {
    const doubles = postsServiceDouble();
    const writeConflict = prismaError('P2034');
    doubles.publicationAttemptService.resolvePublicationRequest.mockResolvedValue(
      null
    );
    doubles.prisma.$transaction.mockImplementation(async (callback) => {
      await callback(doubles.transactionDatabase);
      throw writeConflict;
    });

    await expect(createIdempotentPost(doubles.service)).rejects.toBe(
      writeConflict
    );

    expect(doubles.prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(doubles.postRepository.createOrUpdatePost).toHaveBeenCalledTimes(3);
    expect(doubles.startWorkflow).not.toHaveBeenCalled();
  });

  it('preserves P2002 replay handling', async () => {
    const doubles = postsServiceDouble();
    doubles.publicationAttemptService.resolvePublicationRequest
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(replayedPosts);
    doubles.prisma.$transaction.mockRejectedValue(prismaError('P2002'));

    await expect(createIdempotentPost(doubles.service)).resolves.toEqual(
      replayedPosts
    );

    expect(doubles.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(doubles.postRepository.createOrUpdatePost).not.toHaveBeenCalled();
    expect(doubles.startWorkflow).not.toHaveBeenCalled();
  });
});
