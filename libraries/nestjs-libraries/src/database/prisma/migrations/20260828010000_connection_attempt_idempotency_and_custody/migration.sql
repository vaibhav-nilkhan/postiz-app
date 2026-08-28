ALTER TABLE "ConnectionAttempt"
  ADD COLUMN "externalOperationRef" VARCHAR(128);

UPDATE "ConnectionAttempt"
SET "externalOperationRef" = 'legacy:' || "id"::text
WHERE "externalOperationRef" IS NULL;

ALTER TABLE "ConnectionAttempt"
  ALTER COLUMN "externalOperationRef" SET NOT NULL,
  ALTER COLUMN "stateHash" DROP NOT NULL,
  ALTER COLUMN "stateCorrelation" DROP NOT NULL,
  ALTER COLUMN "authorizationContext" TYPE VARCHAR(8192),
  ADD CONSTRAINT "ConnectionAttempt_externalOperationRef_length"
    CHECK (char_length("externalOperationRef") BETWEEN 1 AND 128),
  ADD CONSTRAINT "ConnectionAttempt_state_initialization_shape" CHECK (
    ("stateHash" IS NULL AND "stateCorrelation" IS NULL AND "status" IN ('PENDING', 'FAILED', 'EXPIRED'))
    OR ("stateHash" IS NOT NULL AND "stateCorrelation" IS NOT NULL)
  ),
  ADD CONSTRAINT "ConnectionAttempt_pending_authorization_shape" CHECK (
    "status" <> 'PENDING' OR "stateHash" IS NULL OR "authorizationContext" IS NOT NULL
  );

CREATE UNIQUE INDEX "ConnectionAttempt_organizationId_externalOperationRef_key"
  ON "ConnectionAttempt"("organizationId", "externalOperationRef");

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
    AND (OLD."status" <> 'PENDING' OR NEW."status" <> 'PENDING') THEN
    RAISE EXCEPTION 'connection attempt state can only be initialized while pending';
  END IF;
  IF OLD."stateCorrelation" IS NULL AND NEW."stateCorrelation" IS NOT NULL
    AND (OLD."status" <> 'PENDING' OR NEW."status" <> 'PENDING') THEN
    RAISE EXCEPTION 'connection attempt correlation can only be initialized while pending';
  END IF;
  IF OLD."authorizationContext" IS DISTINCT FROM NEW."authorizationContext"
    AND NOT (
      (
        OLD."authorizationContext" IS NULL
        AND NEW."authorizationContext" IS NOT NULL
        AND OLD."status" = 'PENDING'
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
        AND NEW."status" <> 'PENDING'
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

CREATE FUNCTION "guard_connection_attempt_custody"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Customer"
    WHERE "id" = NEW."customerId"
      AND "orgId" = NEW."organizationId"
  ) THEN
    RAISE EXCEPTION 'connection attempt customer custody mismatch';
  END IF;

  IF NEW."reconnectIntegrationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Integration"
    WHERE "id" = NEW."reconnectIntegrationId"
      AND "organizationId" = NEW."organizationId"
      AND "customerId" = NEW."customerId"
      AND "providerIdentifier" = NEW."provider"
  ) THEN
    RAISE EXCEPTION 'connection attempt reconnect integration custody mismatch';
  END IF;

  IF NEW."interimIntegrationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Integration"
    WHERE "id" = NEW."interimIntegrationId"
      AND "organizationId" = NEW."organizationId"
      AND "customerId" = NEW."customerId"
      AND "providerIdentifier" = NEW."provider"
  ) THEN
    RAISE EXCEPTION 'connection attempt interim integration custody mismatch';
  END IF;

  IF NEW."finalIntegrationId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "Integration"
    WHERE "id" = NEW."finalIntegrationId"
      AND "organizationId" = NEW."organizationId"
      AND "customerId" = NEW."customerId"
      AND "providerIdentifier" = NEW."provider"
  ) THEN
    RAISE EXCEPTION 'connection attempt final integration custody mismatch';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "ConnectionAttempt_custody_guard"
AFTER INSERT OR UPDATE ON "ConnectionAttempt"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_connection_attempt_custody"();

CREATE FUNCTION "guard_connection_attempt_integration_custody"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ConnectionAttempt" AS attempt
    JOIN "Integration" AS integration ON integration."id" = NEW."id"
    WHERE (
      attempt."reconnectIntegrationId" = NEW."id"
      OR attempt."interimIntegrationId" = NEW."id"
      OR attempt."finalIntegrationId" = NEW."id"
    )
    AND (
      attempt."organizationId" IS DISTINCT FROM integration."organizationId"
      OR attempt."customerId" IS DISTINCT FROM integration."customerId"
      OR attempt."provider" IS DISTINCT FROM integration."providerIdentifier"
    )
  ) THEN
    RAISE EXCEPTION 'integration change violates connection attempt custody';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Integration_connection_attempt_custody_guard"
AFTER UPDATE ON "Integration"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_connection_attempt_integration_custody"();

CREATE FUNCTION "guard_connection_attempt_customer_custody"() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "ConnectionAttempt" AS attempt
    JOIN "Customer" AS customer ON customer."id" = NEW."id"
    WHERE attempt."customerId" = NEW."id"
      AND attempt."organizationId" IS DISTINCT FROM customer."orgId"
  ) THEN
    RAISE EXCEPTION 'customer change violates connection attempt custody';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Customer_connection_attempt_custody_guard"
AFTER UPDATE ON "Customer"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "guard_connection_attempt_customer_custody"();

-- Fire the new deferred custody guard for rows created before this migration.
UPDATE "ConnectionAttempt" SET "updatedAt" = "updatedAt";
