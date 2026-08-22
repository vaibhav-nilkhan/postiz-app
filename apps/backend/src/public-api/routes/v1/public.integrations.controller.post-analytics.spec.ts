import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { PublicAuthMiddleware } from '@gitroom/backend/services/auth/public.auth.middleware';
import { PublicIntegrationsController } from './public.integrations.controller';

vi.mock('@sentry/nestjs', () => ({
  metrics: { count: vi.fn() },
}));

describe('PublicIntegrationsController post analytics', () => {
  const analytics = [
    {
      label: 'Views',
      data: [{ total: '42', date: '2026-08-22' }],
      percentageChange: 0,
    },
  ];
  const postsService = {
    checkPostAnalytics: vi.fn(),
  };
  const organizationService = {
    getOrgByApiKey: vi.fn().mockResolvedValue({
      id: 'organization-1',
      subscription: {},
    }),
  };
  const publicAuth = new PublicAuthMiddleware(
    organizationService as never,
    { getOrgByOAuthToken: vi.fn() } as never
  );
  let app: INestApplication;
  let baseUrl: string;

  const request = (path: string) =>
    fetch(`${baseUrl}${path}`, {
      headers: { Authorization: 'test-api-key' },
    });

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PublicIntegrationsController],
      providers: [
        { provide: IntegrationService, useValue: {} },
        { provide: PostsService, useValue: postsService },
        { provide: MediaService, useValue: {} },
        { provide: NotificationService, useValue: {} },
        { provide: IntegrationManager, useValue: {} },
        { provide: RefreshIntegrationService, useValue: {} },
      ],
    }).compile();
    Object.assign(module.get(PublicIntegrationsController), {
      _postsService: postsService,
    });

    app = module.createNestApplication();
    app.use(publicAuth.use.bind(publicAuth));
    app.useGlobalPipes(new ValidationPipe({ transform: true }));
    await app.listen(0, '127.0.0.1');
    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    postsService.checkPostAnalytics.mockResolvedValue(analytics);
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers the supported GET route and forwards the authenticated organization', async () => {
    expect(
      Reflect.getMetadata(PATH_METADATA, PublicIntegrationsController)
    ).toBe('/public/v1');
    expect(
      Reflect.getMetadata(
        PATH_METADATA,
        PublicIntegrationsController.prototype.getPostAnalytics
      )
    ).toBe('/analytics/post/:postId');
    expect(
      Reflect.getMetadata(
        METHOD_METADATA,
        PublicIntegrationsController.prototype.getPostAnalytics
      )
    ).toBe(RequestMethod.GET);

    const response = await request('/public/v1/analytics/post/post-1?date=30');

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(analytics);
    expect(organizationService.getOrgByApiKey).toHaveBeenCalledWith(
      'test-api-key'
    );
    expect(postsService.checkPostAnalytics).toHaveBeenCalledWith(
      'organization-1',
      'post-1',
      30
    );
  });

  it('does not expose the separable account-level analytics route', async () => {
    const response = await request(
      '/public/v1/analytics/integration-1?date=30'
    );

    expect(response.status).toBe(404);
    expect(postsService.checkPostAnalytics).not.toHaveBeenCalled();
  });

  it.each([
    ['/public/v1/analytics/post/post-1', 'missing'],
    ['/public/v1/analytics/post/post-1?date=', 'empty'],
    ['/public/v1/analytics/post/post-1?date=days', 'non-numeric'],
    ['/public/v1/analytics/post/post-1?date=7days', 'partially numeric'],
    ['/public/v1/analytics/post/post-1?date=0', 'zero'],
    ['/public/v1/analytics/post/post-1?date=-1', 'negative'],
    ['/public/v1/analytics/post/post-1?date=1.5', 'fractional'],
    ['/public/v1/analytics/post/post-1?date=91', 'over the supported bound'],
    ['/public/v1/analytics/post/post-1?date=Infinity', 'non-finite'],
  ])('rejects a %s date range (%s)', async (path) => {
    const response = await request(path);

    expect(response.status).toBe(400);
    expect(postsService.checkPostAnalytics).not.toHaveBeenCalled();
  });
});
