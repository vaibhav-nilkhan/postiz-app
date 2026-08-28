import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { OrganizationService } from '@gitroom/nestjs-libraries/database/prisma/organizations/organization.service';
import { HttpForbiddenException } from '@gitroom/nestjs-libraries/services/exception.filter';

@Injectable()
export class PostifyApiKeyAuthMiddleware implements NestMiddleware {
  constructor(private readonly _organizationService: OrganizationService) {}

  async use(req: Request, res: Response, next: NextFunction) {
    const apiKey = (req.headers.authorization ||
      req.headers.Authorization) as string;
    if (!apiKey || apiKey.startsWith('pos_')) {
      res
        .status(HttpStatus.UNAUTHORIZED)
        .json({ msg: 'A Postiz organization API key is required' });
      return;
    }
    try {
      const organization = await this._organizationService.getOrgByApiKey(
        apiKey
      );
      if (!organization) {
        res.status(HttpStatus.UNAUTHORIZED).json({ msg: 'Invalid API key' });
        return;
      }
      if (!!process.env.STRIPE_SECRET_KEY && !organization.subscription) {
        res
          .status(HttpStatus.UNAUTHORIZED)
          .json({ msg: 'No subscription found' });
        return;
      }
      // Public controllers derive their authoritative organization from req.org.
      // @ts-ignore
      req.org = {
        ...organization,
        users: [{ users: { role: 'SUPERADMIN' } }],
      };
      next();
    } catch {
      throw new HttpForbiddenException();
    }
  }
}
