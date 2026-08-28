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
});
