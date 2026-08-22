import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { canonicalSha256 } from '@gitroom/nestjs-libraries/database/prisma/publication-attempt/publication-attempt.evidence';
import { PublicIntegrationsController } from './public.integrations.controller';

describe('PublicIntegrationsController publication idempotency', () => {
  it('reads Idempotency-Key and forwards its normalized request identity', async () => {
    const routeArguments = Reflect.getMetadata(
      ROUTE_ARGS_METADATA,
      PublicIntegrationsController,
      'createPost'
    );
    expect(Object.values(routeArguments)).toContainEqual(
      expect.objectContaining({ data: 'idempotency-key' })
    );

    const body = { type: 'now', posts: [] };
    const postsService = {
      mapTypeToPost: async () => body,
      validatePosts: async () => [],
      createPost: async (...args: unknown[]) => args,
    };
    const controller = new PublicIntegrationsController(
      {} as never,
      postsService as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never
    );

    await expect(
      controller.createPost(
        { id: 'organization-1' } as never,
        { type: 'now', creationMethod: 'API' },
        ' request-key-1 '
      )
    ).resolves.toEqual([
      'organization-1',
      body,
      'API',
      false,
      {
        idempotencyKey: 'request-key-1',
        requestHash: canonicalSha256({ body, creationMethod: 'API' }),
      },
    ]);
  });
});
