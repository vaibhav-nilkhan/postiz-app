import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ConnectionAttemptFailureCode,
  ConnectionAttemptPurpose,
  ConnectionAttemptStatus,
  Organization,
} from '@prisma/client';
import crypto from 'crypto';
import { CreateConnectionAttemptDto } from '@gitroom/nestjs-libraries/dtos/integrations/connection-attempt.dto';
import { ConnectIntegrationDto } from '@gitroom/nestjs-libraries/dtos/integrations/connect.integration.dto';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  AuthTokenDetails,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import {
  ConnectionAttemptRepository,
  ConnectionAttemptWithIntegrations,
  SafeSelectionOption,
} from './connection-attempt.repository';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';

type SelectableProvider = SocialProvider & {
  pages?: (accessToken: string) => Promise<unknown[]>;
  companies?: (accessToken: string) => Promise<unknown[]>;
};

const CALLBACK_TTL_MS = 15 * 60 * 1000;
const TERMINAL_STATUSES = new Set<ConnectionAttemptStatus>([
  ConnectionAttemptStatus.SUCCEEDED,
  ConnectionAttemptStatus.FAILED,
  ConnectionAttemptStatus.EXPIRED,
]);
const SAFE_SELECTION_FIELDS = new Set([
  'id',
  'page',
  'pageId',
  'accountName',
  'locationName',
]);

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function boundedString(value: unknown, maximum: number): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maximum) : undefined;
}

function safePicture(value: unknown): string | undefined {
  const candidate =
    typeof value === 'string'
      ? value
      : (value as { data?: { url?: unknown } })?.data?.url;
  if (typeof candidate !== 'string' || candidate.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:') {
      return undefined;
    }
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

@Injectable()
export class ConnectionAttemptService {
  constructor(
    private readonly _repository: ConnectionAttemptRepository,
    private readonly _integrationManager: IntegrationManager,
    private readonly _refreshIntegrationService: RefreshIntegrationService
  ) {}

  private encryptionKey(): Buffer {
    const secret = process.env.POSTIZ_CONNECTION_ATTEMPT_SECRET || '';
    if (Buffer.byteLength(secret) < 32) {
      throw new ServiceUnavailableException(
        'Connection attempt encryption is not configured'
      );
    }
    return crypto.createHash('sha256').update(secret).digest();
  }

  private encryptAuthorizationContext(codeVerifier: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      iv
    );
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify({ codeVerifier }), 'utf8'),
      cipher.final(),
    ]);
    return [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  private decryptAuthorizationContext(value: string | null): {
    codeVerifier: string;
  } {
    try {
      const [version, iv, tag, encrypted] = (value || '').split('.');
      if (version !== 'v1' || !iv || !tag || !encrypted) {
        throw new Error('invalid context');
      }
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey(),
        Buffer.from(iv, 'base64url')
      );
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const parsed = JSON.parse(
        Buffer.concat([
          decipher.update(Buffer.from(encrypted, 'base64url')),
          decipher.final(),
        ]).toString('utf8')
      );
      if (typeof parsed.codeVerifier !== 'string') {
        throw new Error('invalid context');
      }
      return { codeVerifier: parsed.codeVerifier };
    } catch {
      throw new ConflictException('Connection attempt context is invalid');
    }
  }

  private configuredReturnUrl(returnTarget: string): string {
    let targets: unknown;
    try {
      targets = JSON.parse(process.env.POSTIZ_POSTIFY_RETURN_URLS || '{}');
    } catch {
      throw new ServiceUnavailableException(
        'Connection attempt return targets are not configured'
      );
    }
    if (
      !targets ||
      Array.isArray(targets) ||
      typeof targets !== 'object' ||
      !Object.prototype.hasOwnProperty.call(targets, returnTarget)
    ) {
      throw new BadRequestException('Return target is not allowed');
    }
    const configured = (targets as Record<string, unknown>)[returnTarget];
    if (typeof configured !== 'string' || configured.length > 2048) {
      throw new ServiceUnavailableException('Return target is invalid');
    }
    try {
      const url = new URL(configured);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      ) {
        throw new Error('unsafe URL');
      }
      return url.toString();
    } catch {
      throw new ServiceUnavailableException('Return target is invalid');
    }
  }

  private provider(providerName: string): SelectableProvider {
    const configured = new Set(
      (process.env.POSTIZ_POSTIFY_OAUTH_PROVIDERS || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean)
    );
    if (
      !configured.has(providerName) ||
      !this._integrationManager
        .getAllowedSocialsIntegrations()
        .includes(providerName)
    ) {
      throw new BadRequestException('Provider is not enabled for this API');
    }
    const provider = this._integrationManager.getSocialIntegration(
      providerName
    ) as SelectableProvider;
    if (
      !provider ||
      provider.customFields ||
      provider.externalUrl ||
      provider.isChromeExtension ||
      provider.isWeb3 ||
      (provider.isBetweenSteps &&
        (!provider.fetchPageInformation ||
          (!provider.pages && !provider.companies)))
    ) {
      throw new BadRequestException('Provider is not supported by this API');
    }
    return provider;
  }

  private correlation(attempt: {
    id: string;
    organizationId: string;
    customerId: string;
    provider: string;
    purpose: ConnectionAttemptPurpose;
    stateHash: string;
  }): string {
    return sha256(
      [
        attempt.id,
        attempt.organizationId,
        attempt.customerId,
        attempt.provider,
        attempt.purpose,
        attempt.stateHash,
      ].join('\0')
    );
  }

  private bindState(generated: {
    url: string;
    state: string;
    codeVerifier: string;
  }): { authorizationUrl: string; state: string } {
    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(generated.url);
    } catch {
      throw new BadRequestException('Provider authorization URL is invalid');
    }
    if (authorizationUrl.protocol !== 'https:') {
      throw new BadRequestException('Provider authorization URL is invalid');
    }
    let state = generated.state;
    if (authorizationUrl.searchParams.has('state')) {
      state = crypto.randomBytes(32).toString('base64url');
      authorizationUrl.searchParams.set('state', state);
    } else if (typeof state !== 'string' || state.length < 20) {
      throw new BadRequestException(
        'Provider does not expose a safe OAuth state contract'
      );
    }
    return { authorizationUrl: authorizationUrl.toString(), state };
  }

  async create(organization: Organization, input: CreateConnectionAttemptDto) {
    const returnUrl = this.configuredReturnUrl(input.returnTarget);
    void returnUrl;
    const provider = this.provider(input.provider);
    const customer = await this._repository.findCustomer(
      organization.id,
      input.customerId
    );
    if (!customer) {
      throw new NotFoundException('Customer not found');
    }

    let reconnect:
      | Awaited<
          ReturnType<ConnectionAttemptRepository['findReconnectIntegration']>
        >
      | undefined;
    if (input.purpose === 'reauthorize') {
      if (!input.reconnectIntegrationId) {
        throw new BadRequestException(
          'Reconnect integration is required for reauthorization'
        );
      }
      reconnect =
        (await this._repository.findReconnectIntegration(
          organization.id,
          input.reconnectIntegrationId
        )) || undefined;
      if (
        !reconnect ||
        reconnect.providerIdentifier !== input.provider ||
        reconnect.customerId !== input.customerId
      ) {
        throw new NotFoundException('Reconnect integration not found');
      }
    } else if (input.reconnectIntegrationId) {
      throw new BadRequestException(
        'Reconnect integration is only valid for reauthorization'
      );
    }

    const generated = await provider.generateAuthUrl();
    const bound = this.bindState(generated);
    const id = crypto.randomUUID();
    const stateHash = sha256(bound.state);
    const purpose =
      input.purpose === 'connect'
        ? ConnectionAttemptPurpose.CONNECT
        : ConnectionAttemptPurpose.REAUTHORIZE;
    const identity = {
      id,
      organizationId: organization.id,
      customerId: input.customerId,
      provider: input.provider,
      purpose,
      stateHash,
    };
    const attempt = await this._repository.create({
      ...identity,
      externalWorkspaceRef: input.externalWorkspaceRef,
      externalActorRef: input.externalActorRef,
      reconnectIntegrationId: reconnect?.id,
      returnTarget: input.returnTarget,
      stateCorrelation: this.correlation(identity),
      authorizationContext: this.encryptAuthorizationContext(
        generated.codeVerifier
      ),
      expiresAt: new Date(Date.now() + CALLBACK_TTL_MS),
    });
    return {
      ...this.project(attempt),
      authorizationUrl: bound.authorizationUrl,
    };
  }

  async read(organizationId: string, id: string) {
    await this._repository.expire(id, organizationId);
    const attempt = await this._repository.getOwned(organizationId, id);
    if (!attempt) {
      throw new NotFoundException('Connection attempt not found');
    }
    return this.project(attempt);
  }

  private selectionOptions(
    attemptId: string,
    rawOptions: unknown[]
  ): SafeSelectionOption[] {
    return rawOptions.slice(0, 100).flatMap((value, index) => {
      if (!value || Array.isArray(value) || typeof value !== 'object') {
        return [];
      }
      const source = value as Record<string, unknown>;
      const payload: Record<string, string | number | boolean> = {};
      for (const [key, raw] of Object.entries(source)) {
        if (
          SAFE_SELECTION_FIELDS.has(key) &&
          (typeof raw === 'string' ||
            typeof raw === 'number' ||
            typeof raw === 'boolean')
        ) {
          payload[key] = typeof raw === 'string' ? raw.slice(0, 512) : raw;
        }
      }
      if (!payload.page && payload.id) {
        payload.page = payload.id;
      }
      if (!payload.id) {
        return [];
      }
      const name = boundedString(source.name, 200) || String(payload.id);
      return [
        {
          id: sha256(
            `${attemptId}\0${index}\0${JSON.stringify(payload)}`
          ).slice(0, 32),
          name,
          username: boundedString(source.username, 200),
          picture: safePicture(source.picture),
          payload,
        },
      ];
    });
  }

  private async providerSelections(
    provider: SelectableProvider,
    accessToken: string,
    attemptId: string
  ) {
    const values = provider.pages
      ? await provider.pages(accessToken)
      : await provider.companies!(accessToken);
    return this.selectionOptions(attemptId, values);
  }

  private callbackResponse(attempt: ConnectionAttemptWithIntegrations) {
    return {
      id: attempt.id,
      providerIdentifier: attempt.provider,
      inBetweenSteps: false,
      onboarding: false,
      pages: [],
      returnURL: this.configuredReturnUrl(attempt.returnTarget),
      postifyConnectionAttempt: this.project(attempt),
    };
  }

  private async refreshWorkflow(
    attempt: ConnectionAttemptWithIntegrations,
    provider: SocialProvider
  ) {
    if (!attempt.finalIntegrationId) {
      return;
    }
    this._refreshIntegrationService
      .startRefreshWorkflow(
        attempt.organizationId,
        attempt.finalIntegrationId,
        provider
      )
      .catch(() => undefined);
  }

  async tryHandleCallback(
    callbackProvider: string,
    body: ConnectIntegrationDto
  ) {
    if (!body.state || body.state.length > 512) {
      return null;
    }
    const stateHash = sha256(body.state);
    let attempt = await this._repository.findByStateHash(stateHash);
    if (!attempt) {
      return null;
    }
    if (attempt.stateCorrelation !== this.correlation(attempt)) {
      await this._repository.fail(
        attempt.id,
        ConnectionAttemptFailureCode.INVALID_STATE,
        [ConnectionAttemptStatus.PENDING]
      );
      attempt = (await this._repository.getOwned(
        attempt.organizationId,
        attempt.id
      ))!;
      return this.callbackResponse(attempt);
    }
    if (attempt.provider !== callbackProvider) {
      await this._repository.fail(
        attempt.id,
        ConnectionAttemptFailureCode.PROVIDER_MISMATCH,
        [ConnectionAttemptStatus.PENDING]
      );
      attempt = (await this._repository.getOwned(
        attempt.organizationId,
        attempt.id
      ))!;
      return this.callbackResponse(attempt);
    }
    if (attempt.expiresAt <= new Date()) {
      await this._repository.expire(attempt.id);
      attempt = (await this._repository.getOwned(
        attempt.organizationId,
        attempt.id
      ))!;
      return this.callbackResponse(attempt);
    }
    if (attempt.status !== ConnectionAttemptStatus.PENDING) {
      throw new ConflictException('Connection attempt state was already used');
    }

    const claimed = await this._repository.claimState(attempt.id, new Date());
    if (!claimed) {
      throw new ConflictException('Connection attempt state was already used');
    }
    if (body.error || !body.code) {
      await this._repository.fail(
        claimed.id,
        body.error
          ? ConnectionAttemptFailureCode.ACCESS_DENIED
          : ConnectionAttemptFailureCode.AUTHENTICATION_FAILED,
        [ConnectionAttemptStatus.AUTHENTICATING]
      );
      const failed = (await this._repository.getOwned(
        claimed.organizationId,
        claimed.id
      ))!;
      return this.callbackResponse(failed);
    }

    const provider = this.provider(claimed.provider);
    let callbackFailureCode: ConnectionAttemptFailureCode =
      ConnectionAttemptFailureCode.AUTHENTICATION_FAILED;
    try {
      const { codeVerifier } = this.decryptAuthorizationContext(
        claimed.authorizationContext
      );
      const authenticated = await provider.authenticate({
        code: body.code,
        codeVerifier,
      });
      if (
        typeof authenticated === 'string' ||
        authenticated.error ||
        !authenticated.id ||
        !authenticated.accessToken
      ) {
        throw new Error('authentication failed');
      }

      let details: AuthTokenDetails = authenticated;
      if (claimed.purpose === ConnectionAttemptPurpose.REAUTHORIZE) {
        callbackFailureCode = ConnectionAttemptFailureCode.ACCOUNT_MISMATCH;
        const expected = claimed.reconnectIntegration;
        if (!expected) {
          throw new Error('account mismatch');
        }
        if (provider.reConnect) {
          const reconnected = await provider.reConnect(
            authenticated.id,
            expected.internalId,
            authenticated.accessToken
          );
          details = {
            ...authenticated,
            ...reconnected,
            refreshToken: authenticated.refreshToken,
            expiresIn: authenticated.expiresIn,
          };
        }
        if (String(details.id) !== String(expected.internalId)) {
          await this._repository.fail(
            claimed.id,
            ConnectionAttemptFailureCode.ACCOUNT_MISMATCH,
            [ConnectionAttemptStatus.AUTHENTICATING]
          );
          const failed = (await this._repository.getOwned(
            claimed.organizationId,
            claimed.id
          ))!;
          return this.callbackResponse(failed);
        }
        callbackFailureCode =
          ConnectionAttemptFailureCode.AUTHENTICATION_FAILED;
      }

      const name =
        boundedString(details.name, 200) ||
        boundedString(details.username, 200) ||
        `Channel_${String(details.id).slice(0, 8)}`;
      const selectionOptions =
        provider.isBetweenSteps &&
        claimed.purpose === ConnectionAttemptPurpose.CONNECT
          ? await this.providerSelections(
              provider,
              details.accessToken,
              claimed.id
            )
          : undefined;
      const completed = await this._repository.completeAuthentication({
        attemptId: claimed.id,
        details: { ...details, id: String(details.id), name: name.trim() },
        oneTimeToken: !!provider.oneTimeToken,
        selectionOptions,
      });
      await this.refreshWorkflow(completed, provider);
      return this.callbackResponse(completed);
    } catch {
      await this._repository.fail(claimed.id, callbackFailureCode, [
        ConnectionAttemptStatus.AUTHENTICATING,
      ]);
      const failed = (await this._repository.getOwned(
        claimed.organizationId,
        claimed.id
      ))!;
      return this.callbackResponse(failed);
    }
  }

  async finalizeSelection(
    organizationId: string,
    id: string,
    selectionId: string
  ) {
    let claimed;
    try {
      claimed = await this._repository.claimSelection(
        organizationId,
        id,
        selectionId
      );
    } catch {
      throw new ConflictException('Connection attempt selection is invalid');
    }
    if (!claimed) {
      throw new NotFoundException('Connection attempt not found');
    }
    if (claimed.expired) {
      await this._repository.expire(id, organizationId);
      return this.read(organizationId, id);
    }

    const provider = this.provider(claimed.attempt.provider);
    try {
      const information = await provider.fetchPageInformation!(
        claimed.attempt.interimIntegration!.token,
        claimed.option.payload
      );
      const completed = await this._repository.completeSelection({
        organizationId,
        attemptId: id,
        selectionId,
        information: {
          id: String(information.id),
          name:
            boundedString(information.name, 200) ||
            `Channel_${String(information.id).slice(0, 8)}`,
          access_token: information.access_token,
          picture: safePicture(information.picture),
          username: boundedString(information.username, 200),
        },
      });
      await this.refreshWorkflow(completed, provider);
      return this.project(completed);
    } catch {
      await this._repository.fail(
        id,
        ConnectionAttemptFailureCode.SELECTION_FAILED,
        [ConnectionAttemptStatus.FINALIZING]
      );
      return this.read(organizationId, id);
    }
  }

  private project(attempt: ConnectionAttemptWithIntegrations) {
    const selection = (
      (attempt.selectionMetadata || []) as SafeSelectionOption[]
    ).map(({ payload: _payload, ...option }) => option);
    const final = attempt.finalIntegration;
    return {
      schemaVersion: 1 as const,
      id: attempt.id,
      status: attempt.status.toLowerCase(),
      provider: attempt.provider,
      purpose: attempt.purpose.toLowerCase(),
      customerId: attempt.customerId,
      externalWorkspaceRef: attempt.externalWorkspaceRef,
      ...(attempt.externalActorRef
        ? { externalActorRef: attempt.externalActorRef }
        : {}),
      expiresAt: attempt.expiresAt.toISOString(),
      ...(selection.length ? { metadata: { selection } } : {}),
      ...(TERMINAL_STATUSES.has(attempt.status) && attempt.failureCode
        ? { failureCode: attempt.failureCode.toLowerCase() }
        : {}),
      ...(attempt.status === ConnectionAttemptStatus.SUCCEEDED && final
        ? {
            finalIntegrationId: final.id,
            lifecycle: {
              disabled: final.disabled,
              setupIncomplete: final.inBetweenSteps,
              refreshNeeded: final.refreshNeeded,
              tokenExpiresAt: final.tokenExpiration?.toISOString() || null,
              softDeleted: !!final.deletedAt,
            },
          }
        : {}),
    };
  }
}
