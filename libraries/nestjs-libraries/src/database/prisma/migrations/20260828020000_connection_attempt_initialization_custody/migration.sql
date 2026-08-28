ALTER TYPE "ConnectionAttemptStatus" ADD VALUE 'INITIALIZING' BEFORE 'PENDING';
ALTER TYPE "ConnectionAttemptFailureCode" ADD VALUE 'INITIALIZATION_FAILED';

-- Rows left behind by a process interruption before this migration have no
-- durable authorization URL and cannot be safely regenerated.
UPDATE "ConnectionAttempt"
SET "status" = 'FAILED',
    "failureCode" = 'INITIALIZATION_FAILED',
    "failedAt" = CURRENT_TIMESTAMP,
    "stateConsumedAt" = CURRENT_TIMESTAMP,
    "authorizationContext" = NULL
WHERE "status" = 'PENDING'
  AND "stateHash" IS NULL
  AND "stateCorrelation" IS NULL;

ALTER TABLE "ConnectionAttempt"
  ALTER COLUMN "status" SET DEFAULT 'INITIALIZING',
  DROP CONSTRAINT "ConnectionAttempt_state_initialization_shape",
  DROP CONSTRAINT "ConnectionAttempt_pending_authorization_shape",
  DROP CONSTRAINT "ConnectionAttempt_state_consumption_shape",
  ADD CONSTRAINT "ConnectionAttempt_state_initialization_shape" CHECK (
    (
      "stateHash" IS NULL
      AND "stateCorrelation" IS NULL
      AND "status" IN ('INITIALIZING', 'FAILED', 'EXPIRED')
    )
    OR (
      "stateHash" IS NOT NULL
      AND "stateCorrelation" IS NOT NULL
      AND "status" <> 'INITIALIZING'
    )
  ),
  ADD CONSTRAINT "ConnectionAttempt_initializing_shape" CHECK (
    "status" <> 'INITIALIZING'
    OR (
      "stateHash" IS NULL
      AND "stateCorrelation" IS NULL
      AND "authorizationContext" IS NULL
      AND "stateConsumedAt" IS NULL
    )
  ),
  ADD CONSTRAINT "ConnectionAttempt_pending_authorization_shape" CHECK (
    "status" <> 'PENDING' OR "authorizationContext" IS NOT NULL
  ),
  ADD CONSTRAINT "ConnectionAttempt_state_consumption_shape" CHECK (
    ("status" IN ('INITIALIZING', 'PENDING') AND "stateConsumedAt" IS NULL)
    OR ("status" NOT IN ('INITIALIZING', 'PENDING') AND "stateConsumedAt" IS NOT NULL)
  );

CREATE OR REPLACE FUNCTION "guard_connection_attempt_transition"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."organizationId" IS DISTINCT FROM OLD."organizationId"
    OR NEW."customerId" IS DISTINCT FROM OLD."customerId"
    OR NEW."externalOperationRef" IS DISTINCT FROM OLD."externalOperationRef"
    OR NEW."externalWorkspaceRef" IS DISTINCT FROM OLD."externalWorkspaceRef"
    OR NEW."externalActorRef" IS DISTINCT FROM OLD."externalActorRef"
    OR NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
    OR NEW."reconnectIntegrationId" IS DISTINCT FROM OLD."reconnectIntegrationId"
    OR NEW."returnTarget" IS DISTINCT FROM OLD."returnTarget"
    OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'connection attempt identity is immutable';
  END IF;

  IF OLD."stateHash" IS NOT NULL
    AND NEW."stateHash" IS DISTINCT FROM OLD."stateHash" THEN
    RAISE EXCEPTION 'connection attempt state hash is immutable';
  END IF;
  IF OLD."stateCorrelation" IS NOT NULL
    AND NEW."stateCorrelation" IS DISTINCT FROM OLD."stateCorrelation" THEN
    RAISE EXCEPTION 'connection attempt state correlation is immutable';
  END IF;
  IF OLD."stateHash" IS NULL AND NEW."stateHash" IS NOT NULL
    AND NOT (OLD."status" = 'INITIALIZING' AND NEW."status" = 'PENDING') THEN
    RAISE EXCEPTION 'connection attempt state can only be initialized by activation';
  END IF;
  IF OLD."stateCorrelation" IS NULL AND NEW."stateCorrelation" IS NOT NULL
    AND NOT (OLD."status" = 'INITIALIZING' AND NEW."status" = 'PENDING') THEN
    RAISE EXCEPTION 'connection attempt correlation can only be initialized by activation';
  END IF;
  IF OLD."authorizationContext" IS DISTINCT FROM NEW."authorizationContext"
    AND NOT (
      (
        OLD."authorizationContext" IS NULL
        AND NEW."authorizationContext" IS NOT NULL
        AND OLD."status" = 'INITIALIZING'
        AND NEW."status" = 'PENDING'
        AND OLD."stateHash" IS NULL
        AND NEW."stateHash" IS NOT NULL
      )
      OR (
        OLD."authorizationContext" IS NOT NULL
        AND NEW."authorizationContext" IS NOT NULL
        AND OLD."status" = 'PENDING'
        AND NEW."status" = 'AUTHENTICATING'
        AND OLD."stateConsumedAt" IS NULL
        AND NEW."stateConsumedAt" IS NOT NULL
      )
      OR (
        OLD."authorizationContext" IS NOT NULL
        AND NEW."authorizationContext" IS NULL
        AND NEW."status" NOT IN ('INITIALIZING', 'PENDING')
        AND NEW."stateConsumedAt" IS NOT NULL
      )
    ) THEN
    RAISE EXCEPTION 'invalid connection attempt authorization context transition';
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
    (OLD."status" = 'INITIALIZING' AND NEW."status" IN ('PENDING', 'FAILED', 'EXPIRED'))
    OR (OLD."status" = 'PENDING' AND NEW."status" IN ('AUTHENTICATING', 'FAILED', 'EXPIRED'))
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
