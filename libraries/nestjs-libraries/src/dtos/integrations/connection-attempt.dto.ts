import {
  IsDefined,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const BOUNDED_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

export class CreateConnectionAttemptDto {
  @IsString()
  @IsDefined()
  @MinLength(1)
  @MaxLength(128)
  customerId: string;

  @IsString()
  @IsDefined()
  @Matches(/^[a-z0-9][a-z0-9-]*$/)
  @MaxLength(64)
  provider: string;

  @IsIn(['connect', 'reauthorize'])
  purpose: 'connect' | 'reauthorize';

  @ValidateIf((value) => value.purpose === 'reauthorize')
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  reconnectIntegrationId?: string;

  @IsString()
  @IsDefined()
  @Matches(BOUNDED_REFERENCE)
  @MaxLength(64)
  returnTarget: string;

  @IsString()
  @IsDefined()
  @Matches(BOUNDED_REFERENCE)
  @MaxLength(128)
  externalWorkspaceRef: string;

  @IsString()
  @IsOptional()
  @Matches(BOUNDED_REFERENCE)
  @MaxLength(128)
  externalActorRef?: string;
}

export class FinalizeConnectionAttemptDto {
  @IsString()
  @IsDefined()
  @Matches(/^[a-f0-9]{32}$/)
  selectionId: string;
}
