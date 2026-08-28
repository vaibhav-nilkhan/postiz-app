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
  ConnectionAttemptCustodyConflictError,
  ConnectionAttemptRepository,
  ConnectionAttemptWithIntegrations,
  SafeSelectionOption,
} from './connection-attempt.repository';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';

type SelectableProvider = SocialProvider & {
  pages?: (accessToken: string) => Promise<unknown[]>;
  companies?: (accessToken: string) => Promise<unknown[]>;
};

type AuthorizationContext = {
  codeVerifier: string;
  authorizationUrl?: string;
};

const CALLBACK_TTL_MS = 15 * 60 * 1000;
const INITIALIZATION_LEASE_MS = 60 * 1000;
const INITIALIZATION_HEARTBEAT_MS = 10 * 1000;
const OPERATION_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$/;
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

  private encryptAuthorizationContext(context: AuthorizationContext): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv(
      'aes-256-gcm',
      this.encryptionKey(),
      iv
    );
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(context), 'utf8'),
      cipher.final(),
    ]);
    const value = [
      'v1',
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
    if (value.length > 8192) {
      throw new BadRequestException('Provider authorization URL is too long');
    }
    return value;
  }

  private decryptAuthorizationContext(
    value: string | null
  ): AuthorizationContext {
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
      if (
        parsed.authorizationUrl !== undefined &&
        typeof parsed.authorizationUrl !== 'string'
      ) {
        throw new Error('invalid context');
      }
      return {
        codeVerifier: parsed.codeVerifier,
        ...(parsed.authorizationUrl
          ? { authorizationUrl: parsed.authorizationUrl }
          : {}),
      };
    } catch {
      throw new ConflictException('Connection attempt context is invalid');
    }
  }

  private assertOperationReference(externalOperationRef: string) {
    if (!OPERATION_REFERENCE.test(externalOperationRef)) {
      throw new BadRequestException('External operation reference is invalid');
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
    const serialized = authorizationUrl.toString();
    if (serialized.length > 4096) {
      throw new BadRequestException('Provider authorization URL is too long');
    }
    return { authorizationUrl: serialized, state };
  }

  private operationIdentityMatches(
    attempt: ConnectionAttemptWithIntegrations,
    input: CreateConnectionAttemptDto,
    purpose: ConnectionAttemptPurpose
  ) {
    return (
      attempt.customerId === input.customerId &&
      attempt.externalWorkspaceRef === input.externalWorkspaceRef &&
      attempt.externalActorRef === (input.externalActorRef || null) &&
      attempt.provider === input.provider &&
      attempt.purpose === purpose &&
      attempt.reconnectIntegrationId ===
        (input.reconnectIntegrationId || null) &&
      attempt.returnTarget === input.returnTarget
    );
  }

  private operationResponse(attempt: ConnectionAttemptWithIntegrations) {
    const projection = this.project(attempt);
    if (
      attempt.status !== ConnectionAttemptStatus.PENDING ||
      !attempt.stateHash ||
      !attempt.authorizationContext
    ) {
      return projection;
    }
    const { authorizationUrl } = this.decryptAuthorizationContext(
      attempt.authorizationContext
    );
    return authorizationUrl ? { ...projection, authorizationUrl } : projection;
  }

  private async recoverOperation(
    organizationId: string,
    externalOperationRef: string,
    initial: ConnectionAttemptWithIntegrations
  ) {
    let attempt = initial;
    if (attempt.status === ConnectionAttemptStatus.INITIALIZING) {
      await this._repository.failStaleInitialization(
        attempt.id,
        organizationId,
        new Date(Date.now() - INITIALIZATION_LEASE_MS)
      );
      attempt = (await this._repository.findByExternalOperation(
        organizationId,
        externalOperationRef
      ))!;
    }
    if (attempt.expiresAt <= new Date()) {
      await this._repository.expire(attempt.id, organizationId);
      attempt = (await this._repository.findByExternalOperation(
        organizationId,
        externalOperationRef
      ))!;
    }
    return this.operationResponse(attempt);
  }

  private async initializeWithHeartbeat<T>(
    attemptId: string,
    initialize: () => Promise<T>
  ): Promise<T> {
    const heartbeat = setInterval(() => {
      void this._repository
        .heartbeatInitialization(attemptId)
        .catch(() => undefined);
    }, INITIALIZATION_HEARTBEAT_MS);
    heartbeat.unref();
    try {
      return await initialize();
    } finally {
      clearInterval(heartbeat);
    }
  }

  async create(organization: Organization, input: CreateConnectionAttemptDto) {
    this.assertOperationReference(input.externalOperationRef);
    const purpose =
      input.purpose === 'connect'
        ? ConnectionAttemptPurpose.CONNECT
        : ConnectionAttemptPurpose.REAUTHORIZE;
    const existing = await this._repository.findByExternalOperation(
      organization.id,
      input.externalOperationRef
    );
    if (existing) {
      if (!this.operationIdentityMatches(existing, input, purpose)) {
        throw new ConflictException(
          'External operation reference identity conflict'
        );
      }
      return this.recoverOperation(
        organization.id,
        input.externalOperationRef,
        existing
      );
    }

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

    const reservation = await this._repository.reserve({
      id: crypto.randomUUID(),
      organizationId: organization.id,
      customerId: input.customerId,
      externalOperationRef: input.externalOperationRef,
      externalWorkspaceRef: input.externalWorkspaceRef,
      externalActorRef: input.externalActorRef,
      provider: input.provider,
      purpose,
      reconnectIntegrationId: reconnect?.id,
      returnTarget: input.returnTarget,
      expiresAt: new Date(Date.now() + CALLBACK_TTL_MS),
    });
    if (!this.operationIdentityMatches(reservation.attempt, input, purpose)) {
      throw new ConflictException(
        'External operation reference identity conflict'
      );
    }
    if (!reservation.created) {
      return this.recoverOperation(
        organization.id,
        input.externalOperationRef,
        reservation.attempt
      );
    }

    try {
      return await this.initializeWithHeartbeat(
        reservation.attempt.id,
        async () => {
          const generated = await provider.generateAuthUrl();
          const bound = this.bindState(generated);
          const stateHash = sha256(bound.state);
          const identity = {
            id: reservation.attempt.id,
            organizationId: organization.id,
            customerId: input.customerId,
            provider: input.provider,
            purpose,
            stateHash,
          };
          const attempt = await this._repository.activate(
            reservation.attempt.id,
            stateHash,
            this.correlation(identity),
            this.encryptAuthorizationContext({
              codeVerifier: generated.codeVerifier,
              authorizationUrl: bound.authorizationUrl,
            })
          );
          if (!attempt) {
            return this.readByExternalOperation(
              organization.id,
              input.externalOperationRef
            );
          }
          return {
            ...this.project(attempt),
            authorizationUrl: bound.authorizationUrl,
          };
        }
      );
    } catch {
      await this._repository.fail(
        reservation.attempt.id,
        ConnectionAttemptFailureCode.INITIALIZATION_FAILED,
        [ConnectionAttemptStatus.INITIALIZING]
      );
      return this.readByExternalOperation(
        organization.id,
        input.externalOperationRef
      );
    }
  }

  async read(organizationId: string, id: string) {
    await this._repository.failStaleInitialization(
      id,
      organizationId,
      new Date(Date.now() - INITIALIZATION_LEASE_MS)
    );
    await this._repository.expire(id, organizationId);
    const attempt = await this._repository.getOwned(organizationId, id);
    if (!attempt) {
      throw new NotFoundException('Connection attempt not found');
    }
    return this.project(attempt);
  }

  async readByExternalOperation(
    organizationId: string,
    externalOperationRef: string
  ) {
    this.assertOperationReference(externalOperationRef);
    let attempt = await this._repository.findByExternalOperation(
      organizationId,
      externalOperationRef
    );
    if (!attempt) {
      throw new NotFoundException('Connection attempt not found');
    }
    return this.recoverOperation(organizationId, externalOperationRef, attempt);
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

  private async failedCallback(
    attempt: ConnectionAttemptWithIntegrations,
    failureCode: ConnectionAttemptFailureCode,
    allowedStatuses: ConnectionAttemptStatus[]
  ) {
    await this._repository.fail(attempt.id, failureCode, allowedStatuses);
    const failed = (await this._repository.getOwned(
      attempt.organizationId,
      attempt.id
    ))!;
    return this.callbackResponse(failed);
  }

  private async uncertainAuthentication(
    attempt: ConnectionAttemptWithIntegrations
  ) {
    await this._repository.clearAuthorizationContext(attempt.id);
    const current = (await this._repository.getOwned(
      attempt.organizationId,
      attempt.id
    ))!;
    return this.callbackResponse(current);
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
    if (
      !attempt.stateHash ||
      !attempt.stateCorrelation ||
      attempt.stateCorrelation !==
        this.correlation({ ...attempt, stateHash: attempt.stateHash })
    ) {
      return this.failedCallback(
        attempt,
        ConnectionAttemptFailureCode.INVALID_STATE,
        [ConnectionAttemptStatus.PENDING]
      );
    }
    if (attempt.provider !== callbackProvider) {
      return this.failedCallback(
        attempt,
        ConnectionAttemptFailureCode.PROVIDER_MISMATCH,
        [ConnectionAttemptStatus.PENDING]
      );
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

    if (body.error || !body.code) {
      const claimed = await this._repository.claimState(
        attempt.id,
        new Date(),
        null
      );
      if (!claimed) {
        throw new ConflictException(
          'Connection attempt state was already used'
        );
      }
      return this.failedCallback(
        claimed,
        body.error
          ? ConnectionAttemptFailureCode.ACCESS_DENIED
          : ConnectionAttemptFailureCode.AUTHENTICATION_FAILED,
        [ConnectionAttemptStatus.AUTHENTICATING]
      );
    }

    let codeVerifier: string;
    try {
      codeVerifier = this.decryptAuthorizationContext(
        attempt.authorizationContext
      ).codeVerifier;
    } catch {
      return this.failedCallback(
        attempt,
        ConnectionAttemptFailureCode.INVALID_STATE,
        [ConnectionAttemptStatus.PENDING]
      );
    }
    const claimed = await this._repository.claimState(
      attempt.id,
      new Date(),
      this.encryptAuthorizationContext({ codeVerifier })
    );
    if (!claimed) {
      throw new ConflictException('Connection attempt state was already used');
    }

    let provider: SelectableProvider;
    try {
      provider = this.provider(claimed.provider);
    } catch {
      return this.uncertainAuthentication(claimed);
    }

    let authenticated: AuthTokenDetails | string;
    try {
      authenticated = await provider.authenticate({
        code: body.code,
        codeVerifier,
      });
    } catch {
      return this.uncertainAuthentication(claimed);
    }
    if (
      typeof authenticated === 'string' ||
      authenticated.error ||
      !authenticated.id ||
      !authenticated.accessToken
    ) {
      return this.failedCallback(
        claimed,
        ConnectionAttemptFailureCode.AUTHENTICATION_FAILED,
        [ConnectionAttemptStatus.AUTHENTICATING]
      );
    }

    let details: AuthTokenDetails = authenticated;
    if (claimed.purpose === ConnectionAttemptPurpose.REAUTHORIZE) {
      const expected = claimed.reconnectIntegration;
      if (!expected) {
        return this.failedCallback(
          claimed,
          ConnectionAttemptFailureCode.ACCOUNT_MISMATCH,
          [ConnectionAttemptStatus.AUTHENTICATING]
        );
      }
      if (provider.reConnect) {
        try {
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
        } catch {
          return this.uncertainAuthentication(claimed);
        }
      }
      if (String(details.id) !== String(expected.internalId)) {
        return this.failedCallback(
          claimed,
          ConnectionAttemptFailureCode.ACCOUNT_MISMATCH,
          [ConnectionAttemptStatus.AUTHENTICATING]
        );
      }
    }

    const name =
      boundedString(details.name, 200) ||
      boundedString(details.username, 200) ||
      `Channel_${String(details.id).slice(0, 8)}`;
    let selectionOptions: SafeSelectionOption[] | undefined;
    try {
      selectionOptions =
        provider.isBetweenSteps &&
        claimed.purpose === ConnectionAttemptPurpose.CONNECT
          ? await this.providerSelections(
              provider,
              details.accessToken,
              claimed.id
            )
          : undefined;
    } catch {
      return this.uncertainAuthentication(claimed);
    }
    try {
      const completed = await this._repository.completeAuthentication({
        attemptId: claimed.id,
        details: { ...details, id: String(details.id), name: name.trim() },
        oneTimeToken: !!provider.oneTimeToken,
        selectionOptions,
      });
      await this.refreshWorkflow(completed, provider);
      return this.callbackResponse(completed);
    } catch (error) {
      if (error instanceof ConnectionAttemptCustodyConflictError) {
        return this.failedCallback(
          claimed,
          ConnectionAttemptFailureCode.CONFLICT,
          [ConnectionAttemptStatus.AUTHENTICATING]
        );
      }
      return this.uncertainAuthentication(claimed);
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
    if (claimed.completed) {
      return this.project(claimed.attempt);
    }

    let provider: SelectableProvider;
    try {
      provider = this.provider(claimed.attempt.provider);
    } catch {
      return this.read(organizationId, id);
    }
    let information;
    try {
      information = await provider.fetchPageInformation!(
        claimed.attempt.interimIntegration!.token,
        claimed.option.payload
      );
    } catch {
      return this.read(organizationId, id);
    }
    const informationId = boundedString(information?.id, 512);
    const accessToken =
      typeof information?.access_token === 'string' &&
      information.access_token.length > 0
        ? information.access_token
        : undefined;
    const expectedId =
      claimed.option.payload.page ||
      claimed.option.payload.id ||
      claimed.option.payload.pageId;
    if (
      !informationId ||
      !accessToken ||
      String(informationId) !== String(expectedId)
    ) {
      await this._repository.fail(
        id,
        ConnectionAttemptFailureCode.SELECTION_FAILED,
        [ConnectionAttemptStatus.FINALIZING]
      );
      return this.read(organizationId, id);
    }
    try {
      const completed = await this._repository.completeSelection({
        organizationId,
        attemptId: id,
        selectionId,
        information: {
          id: informationId,
          name:
            boundedString(information.name, 200) ||
            `Channel_${informationId.slice(0, 8)}`,
          access_token: accessToken,
          picture: safePicture(information.picture),
          username: boundedString(information.username, 200),
        },
      });
      await this.refreshWorkflow(completed, provider);
      return this.project(completed);
    } catch (error) {
      if (error instanceof ConnectionAttemptCustodyConflictError) {
        await this._repository.fail(id, ConnectionAttemptFailureCode.CONFLICT, [
          ConnectionAttemptStatus.FINALIZING,
        ]);
      }
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
      externalOperationRef: attempt.externalOperationRef,
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
