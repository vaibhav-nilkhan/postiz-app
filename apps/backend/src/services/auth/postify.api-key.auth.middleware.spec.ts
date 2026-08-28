import { describe, expect, it, vi } from 'vitest';
import { PostifyApiKeyAuthMiddleware } from './postify.api-key.auth.middleware';

function response() {
  const result: any = {
    status: vi.fn(),
    json: vi.fn(),
  };
  result.status.mockReturnValue(result);
  result.json.mockReturnValue(result);
  return result;
}

describe('PostifyApiKeyAuthMiddleware', () => {
  it('rejects public OAuth bearer tokens without looking them up', async () => {
    const organizations = { getOrgByApiKey: vi.fn() };
    const middleware = new PostifyApiKeyAuthMiddleware(organizations as never);
    const res = response();
    const next = vi.fn();

    await middleware.use(
      { headers: { authorization: 'pos_oauth-token' } } as never,
      res,
      next
    );

    expect(res.status).toHaveBeenCalledWith(401);
    expect(organizations.getOrgByApiKey).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('derives the authoritative organization from an exact API key', async () => {
    const organizations = {
      getOrgByApiKey: vi.fn(async () => ({
        id: 'org-from-api-key',
        subscription: { subscriptionTier: 'ULTIMATE' },
      })),
    };
    const middleware = new PostifyApiKeyAuthMiddleware(organizations as never);
    const req: any = { headers: { authorization: 'instance-api-key' } };
    const next = vi.fn();

    await middleware.use(req, response(), next);

    expect(organizations.getOrgByApiKey).toHaveBeenCalledWith(
      'instance-api-key'
    );
    expect(req.org.id).toBe('org-from-api-key');
    expect(next).toHaveBeenCalledOnce();
  });
});
