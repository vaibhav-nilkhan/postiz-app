import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';

const enabled = process.env.POSTIZ_CONNECTION_ATTEMPT_POSTGRES_TEST === '1';
const migrations = [
  '20260828000000_postify_connection_attempts',
  '20260828010000_connection_attempt_idempotency_and_custody',
].map((name) =>
  path.resolve(
    process.cwd(),
    'libraries/nestjs-libraries/src/database/prisma/migrations',
    name,
    'migration.sql'
  )
);

function psql(sql: string) {
  return execFileSync('psql', ['-X', '-qAt', '-v', 'ON_ERROR_STOP=1'], {
    input: sql,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function expectRejected(sql: string, message: string) {
  try {
    psql(sql);
    throw new Error('SQL unexpectedly succeeded');
  } catch (error) {
    const stderr = String((error as { stderr?: string }).stderr || '');
    expect(stderr).toContain(message);
  }
}

function attempt(values: {
  id: string;
  operation: string;
  organization?: string;
  customer?: string;
  provider?: string;
  purpose?: 'CONNECT' | 'REAUTHORIZE';
  reconnect?: string;
}) {
  const purpose = values.purpose || 'CONNECT';
  const reconnect = values.reconnect ? `'${values.reconnect}'` : 'NULL';
  const stateHash = values.id.replaceAll('-', '').repeat(2);
  return `
    INSERT INTO "ConnectionAttempt" (
      "id", "organizationId", "customerId", "externalOperationRef",
      "externalWorkspaceRef", "provider", "purpose",
      "reconnectIntegrationId", "returnTarget", "stateHash",
      "stateCorrelation", "authorizationContext", "expiresAt"
    ) VALUES (
      '${values.id}', '${values.organization || 'org-1'}',
      '${values.customer || 'customer-1'}', '${values.operation}',
      'workspace-1', '${values.provider || 'direct'}', '${purpose}',
      ${reconnect}, 'postify', '${stateHash}', repeat('b', 64),
      'encrypted-authorization-context', NOW() + INTERVAL '15 minutes'
    );
  `;
}

function authenticate(id: string) {
  return `
    UPDATE "ConnectionAttempt"
    SET "status" = 'AUTHENTICATING', "stateConsumedAt" = NOW(),
        "authorizationContext" = 'encrypted-verifier-only'
    WHERE "id" = '${id}';
  `;
}

function succeed(id: string, integrationId: string) {
  return `
    UPDATE "ConnectionAttempt"
    SET "status" = 'SUCCEEDED', "finalIntegrationId" = '${integrationId}',
        "completedAt" = NOW(), "authorizationContext" = NULL
    WHERE "id" = '${id}';
  `;
}

describe.runIf(enabled)(
  'connection-attempt PostgreSQL custody controls',
  () => {
    beforeEach(() => {
      psql(`
      DROP SCHEMA public CASCADE;
      CREATE SCHEMA public;
      CREATE TABLE "Organization" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "Customer" (
        "id" TEXT PRIMARY KEY,
        "orgId" TEXT NOT NULL,
        "deletedAt" TIMESTAMP(3)
      );
      CREATE TABLE "Integration" (
        "id" TEXT PRIMARY KEY,
        "organizationId" TEXT NOT NULL,
        "customerId" TEXT,
        "providerIdentifier" TEXT NOT NULL
      );
      INSERT INTO "Organization" ("id") VALUES ('org-1'), ('org-2');
      INSERT INTO "Customer" ("id", "orgId") VALUES
        ('customer-1', 'org-1'),
        ('customer-2', 'org-2'),
        ('customer-3', 'org-1');
    `);
      for (const migration of migrations) {
        expect(fs.existsSync(migration)).toBe(true);
        execFileSync(
          'psql',
          ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', migration],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          }
        );
      }
    });

    it('enforces organization-scoped immutable operation reservations', () => {
      psql(`
      INSERT INTO "ConnectionAttempt" (
        "id", "organizationId", "customerId", "externalOperationRef",
        "externalWorkspaceRef", "provider", "purpose", "returnTarget",
        "expiresAt"
      ) VALUES (
        '00000000-0000-0000-0000-000000000001', 'org-1', 'customer-1',
        'operation-1', 'workspace-1', 'direct', 'CONNECT', 'postify',
        NOW() + INTERVAL '15 minutes'
      );
    `);
      expectRejected(
        `
        INSERT INTO "ConnectionAttempt" (
          "id", "organizationId", "customerId", "externalOperationRef",
          "externalWorkspaceRef", "provider", "purpose", "returnTarget",
          "expiresAt"
        ) VALUES (
          '00000000-0000-0000-0000-000000000002', 'org-1', 'customer-1',
          'operation-1', 'workspace-1', 'direct', 'CONNECT', 'postify',
          NOW() + INTERVAL '15 minutes'
        );
      `,
        'ConnectionAttempt_organizationId_externalOperationRef_key'
      );
      expect(() =>
        psql(`
        INSERT INTO "ConnectionAttempt" (
          "id", "organizationId", "customerId", "externalOperationRef",
          "externalWorkspaceRef", "provider", "purpose", "returnTarget",
          "expiresAt"
        ) VALUES (
          '00000000-0000-0000-0000-000000000003', 'org-2', 'customer-2',
          'operation-1', 'workspace-2', 'direct', 'CONNECT', 'postify',
          NOW() + INTERVAL '15 minutes'
        );
      `)
      ).not.toThrow();
      expect(() =>
        psql(`
          UPDATE "ConnectionAttempt"
          SET "stateHash" = repeat('d', 64),
              "stateCorrelation" = repeat('e', 64),
              "authorizationContext" = 'encrypted-url-and-verifier'
          WHERE "id" = '00000000-0000-0000-0000-000000000001';
        `)
      ).not.toThrow();
      expectRejected(
        `
          UPDATE "ConnectionAttempt"
          SET "authorizationContext" = 'substituted-context'
          WHERE "id" = '00000000-0000-0000-0000-000000000001';
        `,
        'invalid connection attempt authorization context transition'
      );
      expect(() =>
        psql(`
          UPDATE "ConnectionAttempt"
          SET "status" = 'AUTHENTICATING', "stateConsumedAt" = NOW(),
              "authorizationContext" = 'encrypted-verifier-only'
          WHERE "id" = '00000000-0000-0000-0000-000000000001';
          UPDATE "ConnectionAttempt" SET "authorizationContext" = NULL
          WHERE "id" = '00000000-0000-0000-0000-000000000001';
        `)
      ).not.toThrow();
      expectRejected(
        `
          UPDATE "ConnectionAttempt"
          SET "authorizationContext" = 'restored-context'
          WHERE "id" = '00000000-0000-0000-0000-000000000001';
        `,
        'invalid connection attempt authorization context transition'
      );
      expectRejected(
        `
        UPDATE "ConnectionAttempt" SET "externalOperationRef" = 'changed'
        WHERE "id" = '00000000-0000-0000-0000-000000000001';
      `,
        'connection attempt identity is immutable'
      );
    });

    it('accepts normal direct, reauthorization, and two-step custody transitions', () => {
      expect(() =>
        psql(`
        BEGIN;
        INSERT INTO "Integration" VALUES
          ('direct-final', 'org-1', 'customer-1', 'direct'),
          ('reauthorize-final', 'org-1', 'customer-1', 'direct'),
          ('two-step-final', 'org-1', 'customer-1', 'two-step');

        ${attempt({
          id: '10000000-0000-0000-0000-000000000001',
          operation: 'direct-op',
        })}
        ${authenticate('10000000-0000-0000-0000-000000000001')}
        ${succeed('10000000-0000-0000-0000-000000000001', 'direct-final')}

        ${attempt({
          id: '10000000-0000-0000-0000-000000000002',
          operation: 'reauthorize-op',
          purpose: 'REAUTHORIZE',
          reconnect: 'reauthorize-final',
        })}
        ${authenticate('10000000-0000-0000-0000-000000000002')}
        ${succeed('10000000-0000-0000-0000-000000000002', 'reauthorize-final')}

        ${attempt({
          id: '10000000-0000-0000-0000-000000000003',
          operation: 'two-step-op',
          provider: 'two-step',
        })}
        ${authenticate('10000000-0000-0000-0000-000000000003')}
        UPDATE "ConnectionAttempt"
        SET "status" = 'AWAITING_SELECTION',
            "interimIntegrationId" = 'two-step-final',
            "selectionMetadata" = '[]', "authorizationContext" = NULL
        WHERE "id" = '10000000-0000-0000-0000-000000000003';
        UPDATE "ConnectionAttempt"
        SET "status" = 'FINALIZING', "selectedOptionId" = repeat('c', 32)
        WHERE "id" = '10000000-0000-0000-0000-000000000003';
        ${succeed('10000000-0000-0000-0000-000000000003', 'two-step-final')}
        COMMIT;
      `)
      ).not.toThrow();
    });

    it('rejects cross-organization, cross-customer, and wrong-provider final substitution', () => {
      const mismatches = [
        ['wrong-org', 'org-2', 'customer-1', 'direct'],
        ['wrong-customer', 'org-1', 'customer-3', 'direct'],
        ['wrong-provider', 'org-1', 'customer-1', 'other'],
      ];
      mismatches.forEach(([id, organization, customer, provider], index) => {
        expectRejected(
          `
          BEGIN;
          INSERT INTO "Integration" VALUES
            ('${id}', '${organization}', '${customer}', '${provider}');
          ${attempt({
            id: `20000000-0000-0000-0000-00000000000${index + 1}`,
            operation: `final-mismatch-${index}`,
          })}
          ${authenticate(`20000000-0000-0000-0000-00000000000${index + 1}`)}
          ${succeed(`20000000-0000-0000-0000-00000000000${index + 1}`, id)}
          COMMIT;
        `,
          'connection attempt final integration custody mismatch'
        );
      });
    });

    it('rejects reconnect and interim Integration substitution', () => {
      expectRejected(
        `
          BEGIN;
          ${attempt({
            id: '30000000-0000-0000-0000-000000000000',
            operation: 'wrong-customer-op',
            customer: 'customer-2',
          })}
          COMMIT;
        `,
        'connection attempt customer custody mismatch'
      );

      expectRejected(
        `
        BEGIN;
        INSERT INTO "Integration" VALUES
          ('wrong-reconnect', 'org-2', 'customer-2', 'direct');
        ${attempt({
          id: '30000000-0000-0000-0000-000000000001',
          operation: 'wrong-reconnect-op',
          purpose: 'REAUTHORIZE',
          reconnect: 'wrong-reconnect',
        })}
        COMMIT;
      `,
        'connection attempt reconnect integration custody mismatch'
      );

      expectRejected(
        `
        BEGIN;
        INSERT INTO "Integration" VALUES
          ('wrong-interim', 'org-1', 'customer-1', 'other');
        ${attempt({
          id: '30000000-0000-0000-0000-000000000002',
          operation: 'wrong-interim-op',
          provider: 'two-step',
        })}
        ${authenticate('30000000-0000-0000-0000-000000000002')}
        UPDATE "ConnectionAttempt"
        SET "status" = 'AWAITING_SELECTION',
            "interimIntegrationId" = 'wrong-interim',
            "selectionMetadata" = '[]', "authorizationContext" = NULL
        WHERE "id" = '30000000-0000-0000-0000-000000000002';
        COMMIT;
      `,
        'connection attempt interim integration custody mismatch'
      );
    });

    it('rejects later Integration identity changes that break durable custody', () => {
      psql(`
      BEGIN;
      INSERT INTO "Integration" VALUES
        ('durable-final', 'org-1', 'customer-1', 'direct');
      ${attempt({
        id: '40000000-0000-0000-0000-000000000001',
        operation: 'durable-op',
      })}
      ${authenticate('40000000-0000-0000-0000-000000000001')}
      ${succeed('40000000-0000-0000-0000-000000000001', 'durable-final')}
      COMMIT;
    `);
      expectRejected(
        `
        BEGIN;
        UPDATE "Integration" SET "customerId" = 'customer-3'
        WHERE "id" = 'durable-final';
        COMMIT;
      `,
        'integration change violates connection attempt custody'
      );
      expectRejected(
        `
          BEGIN;
          UPDATE "Customer" SET "orgId" = 'org-2'
          WHERE "id" = 'customer-1';
          COMMIT;
        `,
        'customer change violates connection attempt custody'
      );
    });
  }
);
