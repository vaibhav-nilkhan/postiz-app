import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import {
  CreateConnectionAttemptDto,
  FinalizeConnectionAttemptDto,
} from '@gitroom/nestjs-libraries/dtos/integrations/connection-attempt.dto';
import { ConnectionAttemptService } from '@gitroom/nestjs-libraries/database/prisma/connection-attempt/connection-attempt.service';

@ApiTags('Postify transport')
@Controller('/public/v1/postify/connection-attempts')
export class PostifyConnectionAttemptsController {
  constructor(private readonly _attempts: ConnectionAttemptService) {}

  @Post('/')
  create(
    @GetOrgFromRequest() organization: Organization,
    @Body() body: CreateConnectionAttemptDto
  ) {
    return this._attempts.create(organization, body);
  }

  @Get('/:id')
  read(
    @GetOrgFromRequest() organization: Organization,
    @Param('id') id: string
  ) {
    return this._attempts.read(organization.id, id);
  }

  @Post('/:id/selection')
  select(
    @GetOrgFromRequest() organization: Organization,
    @Param('id') id: string,
    @Body() body: FinalizeConnectionAttemptDto
  ) {
    return this._attempts.finalizeSelection(
      organization.id,
      id,
      body.selectionId
    );
  }
}
