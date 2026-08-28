CREATE TYPE "ConnectionAttemptPurpose" AS ENUM ('CONNECT', 'REAUTHORIZE');
CREATE TYPE "ConnectionAttemptStatus" AS ENUM (
  'PENDING',
  'AUTHENTICATING',
  'AWAITING_SELECTION',
  'FINALIZING',
  'SUCCEEDED',
  'FAILED',
  'EXPIRED'
);
CREATE TYPE "ConnectionAttemptFailureCode" AS ENUM (
  'ACCESS_DENIED',
  'EXPIRED',
  'INVALID_STATE',
  'PROVIDER_MISMATCH',
  'AUTHENTICATION_FAILED',
  'ACCOUNT_MISMATCH',
  'SELECTION_FAILED',
  'CONFLICT'
);

CREATE TABLE "ConnectionAttempt" (
  "id" UUID NOT NULL,
  "organizationId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "externalWorkspaceRef" VARCHAR(128) NOT NULL,
  "externalActorRef" VARCHAR(128),
  "provider" VARCHAR(64) NOT NULL,
  "purpose" "ConnectionAttemptPurpose" NOT NULL,
  "reconnectIntegrationId" TEXT,
  "returnTarget" VARCHAR(64) NOT NULL,
  "stateHash" CHAR(64) NOT NULL,
  "stateCorrelation" CHAR(64) NOT NULL,
  "authorizationContext" VARCHAR(2048),
  "status" "ConnectionAttemptStatus" NOT NULL DEFAULT 'PENDING',
  "interimIntegrationId" TEXT,
  "finalIntegrationId" TEXT,
  "selectionMetadata" JSONB,
  "selectedOptionId" VARCHAR(64),
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "stateConsumedAt" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "failedAt" TIMESTAMP(3),
  "failureCode" "ConnectionAttemptFailureCode",
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ConnectionAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ConnectionAttempt_stateHash_key" UNIQUE ("stateHash"),
  CONSTRAINT "ConnectionAttempt_interimIntegrationId_key" UNIQUE ("interimIntegrationId"),
  CONSTRAINT "ConnectionAttempt_ref_lengths" CHECK (
    char_length("externalWorkspaceRef") BETWEEN 1 AND 128
    AND ("externalActorRef" IS NULL OR char_length("externalActorRef") BETWEEN 1 AND 128)
    AND char_length("provider") BETWEEN 1 AND 64
    AND char_length("returnTarget") BETWEEN 1 AND 64
  ),
  CONSTRAINT "ConnectionAttempt_terminal_shape" CHECK (
    ("status" = 'SUCCEEDED' AND "finalIntegrationId" IS NOT NULL AND "completedAt" IS NOT NULL AND "failureCode" IS NULL)
    OR ("status" IN ('FAILED', 'EXPIRED') AND "failedAt" IS NOT NULL AND "failureCode" IS NOT NULL AND "completedAt" IS NULL)
    OR ("status" NOT IN ('SUCCEEDED', 'FAILED', 'EXPIRED') AND "completedAt" IS NULL AND "failedAt" IS NULL AND "failureCode" IS NULL)
  ),
  CONSTRAINT "ConnectionAttempt_state_consumption_shape" CHECK (
    ("status" = 'PENDING' AND "stateConsumedAt" IS NULL)
    OR ("status" <> 'PENDING' AND "stateConsumedAt" IS NOT NULL)
  ),
  CONSTRAINT "ConnectionAttempt_selection_shape" CHECK (
    ("status" IN ('AWAITING_SELECTION', 'FINALIZING') AND "interimIntegrationId" IS NOT NULL)
    OR "status" NOT IN ('AWAITING_SELECTION', 'FINALIZING')
  ),
  CONSTRAINT "ConnectionAttempt_purpose_shape" CHECK (
    ("purpose" = 'CONNECT' AND "reconnectIntegrationId" IS NULL)
    OR ("purpose" = 'REAUTHORIZE' AND "reconnectIntegrationId" IS NOT NULL)
  )
);

CREATE INDEX "ConnectionAttempt_organizationId_createdAt_idx"
  ON "ConnectionAttempt"("organizationId", "createdAt");
CREATE INDEX "ConnectionAttempt_organizationId_externalWorkspaceRef_idx"
  ON "ConnectionAttempt"("organizationId", "externalWorkspaceRef");
CREATE INDEX "ConnectionAttempt_customerId_idx" ON "ConnectionAttempt"("customerId");
CREATE INDEX "ConnectionAttempt_reconnectIntegrationId_idx"
  ON "ConnectionAttempt"("reconnectIntegrationId");
CREATE INDEX "ConnectionAttempt_finalIntegrationId_idx"
  ON "ConnectionAttempt"("finalIntegrationId");
CREATE INDEX "ConnectionAttempt_status_expiresAt_idx"
  ON "ConnectionAttempt"("status", "expiresAt");

ALTER TABLE "ConnectionAttempt"
  ADD CONSTRAINT "ConnectionAttempt_organizationId_fkey"
  FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ConnectionAttempt_customerId_fkey"
  FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ConnectionAttempt_reconnectIntegrationId_fkey"
  FOREIGN KEY ("reconnectIntegrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ConnectionAttempt_interimIntegrationId_fkey"
  FOREIGN KEY ("interimIntegrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "ConnectionAttempt_finalIntegrationId_fkey"
  FOREIGN KEY ("finalIntegrationId") REFERENCES "Integration"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "guard_connection_attempt_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW."externalWorkspaceRef" IS DISTINCT FROM OLD."externalWorkspaceRef"
    OR NEW."externalActorRef" IS DISTINCT FROM OLD."externalActorRef"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."reconnectIntegrationId" IS DISTINCT FROM OLD."reconnectIntegrationId"
    OR NEW."returnTarget" IS DISTINCT FROM OLD."returnTarget"
    OR NEW."stateHash" IS DISTINCT FROM OLD."stateHash"
    OR NEW."stateCorrelation" IS DISTINCT FROM OLD."stateCorrelation"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'connection attempt identity is immutable';
  END IF;

  IF OLD."authorizationContext" IS NULL AND NEW."authorizationContext" IS NOT NULL THEN
    RAISE EXCEPTION 'connection attempt authorization context cannot be restored';
  END IF;
  IF OLD."stateConsumedAt" IS NOT NULL AND NEW."stateConsumedAt" IS DISTINCT FROM OLD."stateConsumedAt" THEN
    RAISE EXCEPTION 'connection attempt state consumption is immutable';
  END IF;
  IF OLD."interimIntegrationId" IS NOT NULL AND NEW."interimIntegrationId" IS DISTINCT FROM OLD."interimIntegrationId" THEN
    RAISE EXCEPTION 'connection attempt interim integration is immutable';
  END IF;
  IF OLD."finalIntegrationId" IS NOT NULL AND NEW."finalIntegrationId" IS DISTINCT FROM OLD."finalIntegrationId" THEN
    RAISE EXCEPTION 'connection attempt final integration is immutable';
  END IF;
  IF OLD."selectionMetadata" IS NOT NULL AND NEW."selectionMetadata" IS DISTINCT FROM OLD."selectionMetadata" THEN
    RAISE EXCEPTION 'connection attempt selection metadata is immutable';
  END IF;
  IF OLD."selectedOptionId" IS NOT NULL AND NEW."selectedOptionId" IS DISTINCT FROM OLD."selectedOptionId" THEN
    RAISE EXCEPTION 'connection attempt selected option is immutable';
  END IF;

  IF NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('AUTHENTICATING', 'FAILED', 'EXPIRED'))
    OR (OLD."status" = 'AUTHENTICATING' AND NEW."status" IN ('AWAITING_SELECTION', 'SUCCEEDED', 'FAILED', 'EXPIRED'))
    OR (OLD."status" = 'AWAITING_SELECTION' AND NEW."status" IN ('FINALIZING', 'FAILED', 'EXPIRED'))
    OR (OLD."status" = 'FINALIZING' AND NEW."status" IN ('SUCCEEDED', 'FAILED', 'EXPIRED'))
    OR OLD."status" = NEW."status"
  ) THEN
    RAISE EXCEPTION 'invalid connection attempt status transition: % -> %', OLD."status", NEW."status";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConnectionAttempt_transition_guard"
BEFORE UPDATE ON "ConnectionAttempt"
FOR EACH ROW EXECUTE FUNCTION "guard_connection_attempt_transition"();

CREATE FUNCTION "guard_connection_attempt_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'connection attempts are durable and cannot be deleted';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ConnectionAttempt_delete_guard"
BEFORE DELETE ON "ConnectionAttempt"
FOR EACH ROW EXECUTE FUNCTION "guard_connection_attempt_delete"();
