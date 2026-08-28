import { Injectable } from '@nestjs/common';
import {
  ConnectionAttemptFailureCode,
  ConnectionAttemptPurpose,
  ConnectionAttemptStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IntegrationRepository } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.repository';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';

const activeStatuses: ConnectionAttemptStatus[] = [
  ConnectionAttemptStatus.PENDING,
  ConnectionAttemptStatus.AUTHENTICATING,
  ConnectionAttemptStatus.AWAITING_SELECTION,
  ConnectionAttemptStatus.FINALIZING,
];

const attemptInclude = {
  reconnectIntegration: true,
  interimIntegration: true,
  finalIntegration: {
    select: {
      id: true,
      organizationId: true,
      customerId: true,
      providerIdentifier: true,
      disabled: true,
      inBetweenSteps: true,
      refreshNeeded: true,
      tokenExpiration: true,
      deletedAt: true,
    },
  },
} satisfies Prisma.ConnectionAttemptInclude;

export type ConnectionAttemptWithIntegrations =
  Prisma.ConnectionAttemptGetPayload<{ include: typeof attemptInclude }>;

export type SafeSelectionOption = {
  id: string;
  name: string;
  username?: string;
  picture?: string;
  payload: Record<string, string | number | boolean>;
};

type AuthenticatedConnection = {
  id: string;
  name: string;
  accessToken: string;
  refreshToken?: string;
  expiresIn?: number;
  username?: string;
  additionalSettings?: Array<{
    title: string;
    description: string;
    type: 'checkbox' | 'text' | 'textarea';
    value: unknown;
    regex?: string;
  }>;
};

@Injectable()
export class ConnectionAttemptRepository {
  constructor(
    private readonly _prisma: PrismaService,
    private readonly _integrations: IntegrationRepository
  ) {}

  findCustomer(organizationId: string, customerId: string) {
    return this._prisma.customer.findFirst({
      where: { id: customerId, orgId: organizationId, deletedAt: null },
      select: { id: true },
    });
  }

  findReconnectIntegration(organizationId: string, integrationId: string) {
    return this._prisma.integration.findFirst({
      where: { id: integrationId, organizationId, deletedAt: null },
      select: {
        id: true,
        internalId: true,
        organizationId: true,
        customerId: true,
        providerIdentifier: true,
      },
    });
  }

  create(input: {
    id: string;
    organizationId: string;
    customerId: string;
    externalWorkspaceRef: string;
    externalActorRef?: string;
    provider: string;
    purpose: ConnectionAttemptPurpose;
    reconnectIntegrationId?: string;
    returnTarget: string;
    stateHash: string;
    stateCorrelation: string;
    authorizationContext: string;
    expiresAt: Date;
  }) {
    return this._prisma.connectionAttempt.create({
      data: input,
      include: attemptInclude,
    });
  }

  findByStateHash(stateHash: string) {
    return this._prisma.connectionAttempt.findUnique({
      where: { stateHash },
      include: attemptInclude,
    });
  }

  async claimState(id: string, now: Date) {
    const claimed = await this._prisma.connectionAttempt.updateMany({
      where: {
        id,
        status: ConnectionAttemptStatus.PENDING,
        stateConsumedAt: null,
        expiresAt: { gt: now },
      },
      data: {
        status: ConnectionAttemptStatus.AUTHENTICATING,
        stateConsumedAt: now,
      },
    });
    if (claimed.count !== 1) {
      return null;
    }
    return this._prisma.connectionAttempt.findUniqueOrThrow({
      where: { id },
      include: attemptInclude,
    });
  }

  async fail(
    id: string,
    failureCode: ConnectionAttemptFailureCode,
    allowedStatuses: ConnectionAttemptStatus[] = activeStatuses
  ) {
    const attempt = await this._prisma.connectionAttempt.findUnique({
      where: { id },
      select: { status: true, stateConsumedAt: true },
    });
    if (!attempt || !allowedStatuses.includes(attempt.status)) {
      return;
    }
    const now = new Date();
    await this._prisma.connectionAttempt.updateMany({
      where: { id, status: attempt.status },
      data: {
        status: ConnectionAttemptStatus.FAILED,
        failureCode,
        failedAt: now,
        stateConsumedAt: attempt.stateConsumedAt || now,
        authorizationContext: null,
      },
    });
  }

  async expire(id: string, organizationId?: string) {
    const attempt = await this._prisma.connectionAttempt.findFirst({
      where: {
        id,
        ...(organizationId ? { organizationId } : {}),
        status: { in: activeStatuses },
        expiresAt: { lte: new Date() },
      },
      select: { status: true, stateConsumedAt: true },
    });
    if (!attempt) {
      return;
    }
    const now = new Date();
    await this._prisma.connectionAttempt.updateMany({
      where: { id, status: attempt.status, expiresAt: { lte: now } },
      data: {
        status: ConnectionAttemptStatus.EXPIRED,
        failureCode: ConnectionAttemptFailureCode.EXPIRED,
        failedAt: now,
        stateConsumedAt: attempt.stateConsumedAt || now,
        authorizationContext: null,
      },
    });
  }

  getOwned(organizationId: string, id: string) {
    return this._prisma.connectionAttempt.findFirst({
      where: { id, organizationId },
      include: attemptInclude,
    });
  }

  async completeAuthentication(input: {
    attemptId: string;
    details: AuthenticatedConnection;
    oneTimeToken: boolean;
    selectionOptions?: SafeSelectionOption[];
  }) {
    return this._prisma.$transaction(
      async (database) => {
        const attempt = await database.connectionAttempt.findUniqueOrThrow({
          where: { id: input.attemptId },
          include: { reconnectIntegration: true },
        });
        if (
          attempt.status !== ConnectionAttemptStatus.AUTHENTICATING ||
          attempt.expiresAt <= new Date()
        ) {
          throw new Error('Connection attempt is not authenticating');
        }
        const customer = await database.customer.findFirst({
          where: {
            id: attempt.customerId,
            orgId: attempt.organizationId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!customer) {
          throw new Error('Connection attempt customer mismatch');
        }
        if (
          attempt.purpose === ConnectionAttemptPurpose.REAUTHORIZE &&
          (!attempt.reconnectIntegration ||
            attempt.reconnectIntegration.organizationId !==
              attempt.organizationId ||
            attempt.reconnectIntegration.customerId !== attempt.customerId ||
            attempt.reconnectIntegration.providerIdentifier !==
              attempt.provider ||
            attempt.reconnectIntegration.internalId !== input.details.id ||
            attempt.reconnectIntegration.deletedAt)
        ) {
          throw new Error('Reconnect identity mismatch');
        }

        const betweenSteps = !!input.selectionOptions;
        const internalId = betweenSteps
          ? `postify-attempt:${attempt.id}`
          : input.details.id;
        const integration = await this._integrations.createOrUpdateIntegration(
          input.details.additionalSettings,
          input.oneTimeToken,
          attempt.organizationId,
          input.details.name,
          undefined,
          'social',
          internalId,
          attempt.provider,
          input.details.accessToken,
          input.details.refreshToken ||
            attempt.reconnectIntegration?.refreshToken ||
            '',
          input.details.expiresIn,
          input.details.username,
          betweenSteps,
          attempt.reconnectIntegrationId || undefined,
          undefined,
          undefined,
          {
            customerId: attempt.customerId,
            rootInternalId: input.details.id,
            database,
          }
        );

        if (
          attempt.reconnectIntegrationId &&
          integration.id !== attempt.reconnectIntegrationId
        ) {
          throw new Error('Reconnect integration changed identity');
        }

        const now = new Date();
        const updated = await database.connectionAttempt.updateMany({
          where: {
            id: attempt.id,
            status: ConnectionAttemptStatus.AUTHENTICATING,
          },
          data: betweenSteps
            ? {
                status: ConnectionAttemptStatus.AWAITING_SELECTION,
                interimIntegrationId: integration.id,
                selectionMetadata:
                  input.selectionOptions as unknown as Prisma.InputJsonValue,
                authorizationContext: null,
              }
            : {
                status: ConnectionAttemptStatus.SUCCEEDED,
                finalIntegrationId: integration.id,
                completedAt: now,
                authorizationContext: null,
              },
        });
        if (updated.count !== 1) {
          throw new Error('Connection attempt completion conflict');
        }

        return database.connectionAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
          include: attemptInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async claimSelection(
    organizationId: string,
    id: string,
    selectionId: string
  ) {
    return this._prisma.$transaction(
      async (database) => {
        const attempt = await database.connectionAttempt.findFirst({
          where: { id, organizationId },
          include: { interimIntegration: true },
        });
        if (!attempt) {
          return null;
        }
        if (attempt.expiresAt <= new Date()) {
          return { expired: true as const };
        }
        const options = (attempt.selectionMetadata ||
          []) as SafeSelectionOption[];
        const option = options.find((item) => item.id === selectionId);
        if (!option || !attempt.interimIntegration) {
          throw new Error('Invalid connection attempt selection');
        }
        if (
          attempt.status === ConnectionAttemptStatus.FINALIZING &&
          attempt.selectedOptionId === selectionId
        ) {
          return { expired: false as const, attempt, option };
        }
        if (attempt.status !== ConnectionAttemptStatus.AWAITING_SELECTION) {
          throw new Error('Connection attempt is not awaiting selection');
        }
        const claimed = await database.connectionAttempt.updateMany({
          where: {
            id,
            organizationId,
            status: ConnectionAttemptStatus.AWAITING_SELECTION,
          },
          data: {
            status: ConnectionAttemptStatus.FINALIZING,
            selectedOptionId: selectionId,
          },
        });
        if (claimed.count !== 1) {
          throw new Error('Connection attempt selection conflict');
        }
        return { expired: false as const, attempt, option };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }

  async completeSelection(input: {
    organizationId: string;
    attemptId: string;
    selectionId: string;
    information: {
      id: string;
      name: string;
      access_token: string;
      picture?: string;
      username?: string;
    };
  }) {
    return this._prisma.$transaction(
      async (database) => {
        const attempt = await database.connectionAttempt.findFirstOrThrow({
          where: {
            id: input.attemptId,
            organizationId: input.organizationId,
            status: ConnectionAttemptStatus.FINALIZING,
            selectedOptionId: input.selectionId,
          },
          include: { interimIntegration: true },
        });
        const interim = attempt.interimIntegration;
        if (
          !interim ||
          interim.organizationId !== attempt.organizationId ||
          interim.customerId !== attempt.customerId ||
          interim.providerIdentifier !== attempt.provider ||
          !interim.inBetweenSteps ||
          interim.deletedAt
        ) {
          throw new Error('Interim integration ownership mismatch');
        }
        const customer = await database.customer.findFirst({
          where: {
            id: attempt.customerId,
            orgId: attempt.organizationId,
            deletedAt: null,
          },
          select: { id: true },
        });
        if (!customer) {
          throw new Error('Connection attempt customer mismatch');
        }

        const existing = await database.integration.findUnique({
          where: {
            organizationId_internalId: {
              organizationId: attempt.organizationId,
              internalId: input.information.id,
            },
          },
        });
        if (existing && existing.providerIdentifier !== attempt.provider) {
          throw new Error('Final integration provider mismatch');
        }

        let finalIntegrationId = interim.id;
        if (existing && existing.id !== interim.id) {
          await database.integration.update({
            where: { id: interim.id, organizationId: attempt.organizationId },
            data: {
              internalId: `deleted_${input.information.id}_${makeId(10)}`,
              deletedAt: new Date(),
            },
          });
          const revived = await database.integration.update({
            where: { id: existing.id, organizationId: attempt.organizationId },
            data: {
              name: input.information.name,
              profile: input.information.username,
              picture: input.information.picture,
              token: input.information.access_token,
              refreshToken: interim.refreshToken,
              tokenExpiration: interim.tokenExpiration,
              customer: { connect: { id: attempt.customerId } },
              disabled: false,
              deletedAt: null,
              inBetweenSteps: false,
              refreshNeeded: false,
              rootInternalId: interim.rootInternalId,
            },
          });
          finalIntegrationId = revived.id;
        } else {
          await database.integration.update({
            where: { id: interim.id, organizationId: attempt.organizationId },
            data: {
              internalId: input.information.id,
              name: input.information.name,
              profile: input.information.username,
              picture: input.information.picture,
              token: input.information.access_token,
              customer: { connect: { id: attempt.customerId } },
              disabled: false,
              deletedAt: null,
              inBetweenSteps: false,
              refreshNeeded: false,
            },
          });
        }

        const completed = await database.connectionAttempt.updateMany({
          where: {
            id: attempt.id,
            organizationId: attempt.organizationId,
            status: ConnectionAttemptStatus.FINALIZING,
            selectedOptionId: input.selectionId,
          },
          data: {
            status: ConnectionAttemptStatus.SUCCEEDED,
            finalIntegrationId,
            completedAt: new Date(),
          },
        });
        if (completed.count !== 1) {
          throw new Error('Connection attempt selection completion conflict');
        }
        return database.connectionAttempt.findUniqueOrThrow({
          where: { id: attempt.id },
          include: attemptInclude,
        });
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }
    );
  }
}
