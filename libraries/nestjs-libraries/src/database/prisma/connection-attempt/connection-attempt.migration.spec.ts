import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const migration = fs.readFileSync(
  path.resolve(
    process.cwd(),
    'libraries/nestjs-libraries/src/database/prisma/migrations/20260828000000_postify_connection_attempts/migration.sql'
  ),
  'utf8'
);
const custodyMigrationPath = path.resolve(
  process.cwd(),
  'libraries/nestjs-libraries/src/database/prisma/migrations/20260828010000_connection_attempt_idempotency_and_custody/migration.sql'
);
const custodyMigration = fs.existsSync(custodyMigrationPath)
  ? fs.readFileSync(custodyMigrationPath, 'utf8')
  : '';
const initializationMigrationPath = path.resolve(
  process.cwd(),
  'libraries/nestjs-libraries/src/database/prisma/migrations/20260828020000_connection_attempt_initialization_custody/migration.sql'
);
const initializationMigration = fs.existsSync(initializationMigrationPath)
  ? fs.readFileSync(initializationMigrationPath, 'utf8')
  : '';

describe('connection-attempt migration', () => {
  it('is additive and installs ownership, uniqueness, and transition protection', () => {
    expect(migration).toContain('CREATE TABLE "ConnectionAttempt"');
    expect(migration).toContain('ConnectionAttempt_stateHash_key');
    expect(migration).toContain('ConnectionAttempt_interimIntegrationId_key');
    expect(migration).toContain('ConnectionAttempt_customerId_fkey');
    expect(migration).toContain('ConnectionAttempt_transition_guard');
    expect(migration).toContain('ConnectionAttempt_delete_guard');
    expect(migration).toContain('connection attempt identity is immutable');
    expect(migration).toContain(
      'connection attempts are durable and cannot be deleted'
    );
    expect(migration).toContain('invalid connection attempt status transition');
    expect(migration).not.toMatch(
      /\b(DROP|TRUNCATE|DELETE FROM|UPDATE "Integration")\b/
    );
  });

  it('uses closed purpose, status, and safe failure enums', () => {
    expect(migration).toContain(
      `CREATE TYPE "ConnectionAttemptPurpose" AS ENUM ('CONNECT', 'REAUTHORIZE')`
    );
    for (const status of [
      'PENDING',
      'AUTHENTICATING',
      'AWAITING_SELECTION',
      'FINALIZING',
      'SUCCEEDED',
      'FAILED',
      'EXPIRED',
    ]) {
      expect(migration).toContain(`'${status}'`);
    }
    expect(migration).toContain('ConnectionAttempt_terminal_shape');
    expect(migration).toContain('ConnectionAttempt_purpose_shape');
  });

  it('adds immutable organization-scoped external operation recovery', () => {
    expect(custodyMigration).toContain('"externalOperationRef" VARCHAR(128)');
    expect(custodyMigration).toContain(
      'ConnectionAttempt_organizationId_externalOperationRef_key'
    );
    expect(custodyMigration).toContain(
      'NEW."externalOperationRef" IS DISTINCT FROM OLD."externalOperationRef"'
    );
    expect(custodyMigration).toContain(
      'ALTER COLUMN "stateHash" DROP NOT NULL'
    );
    expect(custodyMigration).toContain(
      'ALTER COLUMN "stateCorrelation" DROP NOT NULL'
    );
    expect(custodyMigration).toContain('TYPE VARCHAR(8192)');
  });

  it('installs deferred exact customer and Integration custody controls', () => {
    expect(custodyMigration).toContain('guard_connection_attempt_custody');
    expect(custodyMigration).toContain(
      'guard_connection_attempt_integration_custody'
    );
    expect(custodyMigration).toContain(
      'guard_connection_attempt_customer_custody'
    );
    expect(custodyMigration).toContain('CREATE CONSTRAINT TRIGGER');
    expect(custodyMigration).toContain('DEFERRABLE INITIALLY DEFERRED');
    for (const identity of [
      '"organizationId" = NEW."organizationId"',
      '"customerId" = NEW."customerId"',
      '"providerIdentifier" = NEW."provider"',
    ]) {
      expect(custodyMigration).toContain(identity);
    }
    for (const reference of [
      'reconnect integration custody mismatch',
      'interim integration custody mismatch',
      'final integration custody mismatch',
    ]) {
      expect(custodyMigration).toContain(reference);
    }
  });

  it('adds a finite initialization lease outcome and guarded activation', () => {
    expect(initializationMigration).toContain("ADD VALUE 'INITIALIZING'");
    expect(initializationMigration).toContain(
      "ADD VALUE 'INITIALIZATION_FAILED'"
    );
    expect(initializationMigration).toContain(
      'ALTER COLUMN "status" SET DEFAULT \'INITIALIZING\''
    );
    expect(initializationMigration).toContain(
      'OLD."status" = \'INITIALIZING\''
    );
    expect(initializationMigration).toContain('NEW."status" = \'PENDING\'');
    expect(initializationMigration).toContain(
      "OLD.\"status\" = 'INITIALIZING' AND NEW.\"status\" IN ('PENDING', 'FAILED', 'EXPIRED')"
    );
  });
});
