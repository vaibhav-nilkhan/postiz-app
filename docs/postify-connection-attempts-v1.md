# Postify group-bound connection attempts (v1)

This additive contract is based on Postiz commit
`639f0684fe3a9263cb85216ad1a68cab29b22d89` (upstream v2.23.0 ancestor
`1e4c8dd5c4f70c4d0abd01e23cc42d5b533d1ab9`). It lets Postify operate a
fully self-hosted, shared Postiz organization without making Postiz the content,
approval, or customer source of truth. Postiz remains a hidden, replaceable
publishing transport and is the sole owner of provider credentials and tokens.

## Contract

All machine routes use a dedicated `Authorization` API-key middleware that
rejects Postiz public OAuth bearer tokens. The API-key-derived organization is
authoritative; no request field can select an organization.

| Method | Route                                                  | Purpose                                                               |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------- |
| `POST` | `/public/v1/postify/connection-attempts`               | Create an expiring attempt and return its provider authorization URL. |
| `GET`  | `/public/v1/postify/connection-attempts/:id`           | Poll a safe lifecycle projection.                                     |
| `POST` | `/public/v1/postify/connection-attempts/:id/selection` | Finalize one provider-safe option for a two-step provider.            |

The create body is schema version 1:

```json
{
  "customerId": "exact-postiz-customer-id",
  "provider": "facebook",
  "purpose": "connect",
  "returnTarget": "postify",
  "externalWorkspaceRef": "postify-workspace-reference",
  "externalActorRef": "optional-postify-actor-reference"
}
```

`purpose: "reauthorize"` also requires `reconnectIntegrationId`. That
integration must be active and match the authenticated organization, exact
customer, and provider. Reauthorization preserves its Postiz integration ID and
fails with `account_mismatch` if the provider result cannot prove the same
provider account/page/channel.

Create returns `schemaVersion: 1`, the safe poll projection, and
`authorizationUrl`. Poll/finalize return only the finite status, bound attempt
identity, expiry, safe failure code, provider-safe selection display metadata,
truthful local lifecycle, and (only after success) `finalIntegrationId`.
Two-step finalization accepts only the opaque `selectionId` previously returned
by poll; caller-supplied provider payloads are not accepted.

Statuses are `pending`, `authenticating`, `awaiting_selection`, `finalizing`,
`succeeded`, `failed`, and `expired`. Failure codes are a closed enum. A database
trigger enforces immutable identity fields and one-way transitions. State is
random (or, for OAuth 1 providers, the provider's high-entropy request token),
necessarily present inside the provider `authorizationUrl` but never returned as
a separate field or stored raw. It is stored as a SHA-256 hash, bound to
attempt/organization/customer/provider/purpose by a correlation hash, consumed
with a compare-and-set, and expires in 15 minutes. Encrypted transient
authorization context uses AES-256-GCM and is cleared on terminal/interim
completion.

## Server configuration and security assumptions

- `POSTIZ_CONNECTION_ATTEMPT_SECRET` is a separately managed secret of at least
  32 bytes and must be stable for the 15-minute callback window.
- `POSTIZ_POSTIFY_OAUTH_PROVIDERS` is an explicit comma-separated allowlist.
  Even allowlisted providers are rejected when they use custom fields, external
  instance discovery, browser-extension cookies, Web3, or do not expose a clean
  supported redirect/two-step contract.
- `POSTIZ_POSTIFY_RETURN_URLS` is a JSON identity-to-exact-HTTPS-URL map. The API
  accepts only the identity. It has no caller redirect URL and no webhook/SSRF
  contract.
- Postify uses one dedicated Postiz organization API key, protects that key as a
  server secret, and creates every referenced Customer in the same organization.
- Provider callbacks continue through the existing Postiz frontend callback
  page. A matching durable state is dispatched to this contract before the
  legacy Redis flow; unmatched dashboard/public states retain legacy behavior.

Provider access/refresh tokens, authorization code, raw state, PKCE/OAuth
verifier, instance API keys, and custom credentials never appear in this API.
Provider selection results are reduced to bounded display fields; query strings
are removed from picture URLs. Interim and final writes transactionally recheck
organization/customer/provider/attempt ownership, assign the exact Customer,
and mark success. A durable `awaiting_selection` or `finalizing` attempt can be
resumed after process interruption. An interruption during one-time provider
code exchange remains truthfully `authenticating` until expiry; it is never
guessed successful or retried with a consumed code.

Lifecycle is local Postiz fact only: `disabled`, `setupIncomplete`,
`refreshNeeded`, known `tokenExpiresAt`, and `softDeleted`. This contract does
**not** claim provider grant revocation, provider-side publication success,
Postify approval, or provider credential custody outside Postiz.

## Migration, upgrades, and modified-source notice

Apply
`libraries/nestjs-libraries/src/database/prisma/migrations/20260828000000_postify_connection_attempts/migration.sql`
before serving the routes, then run Prisma generation. The migration is additive:
three enums, one table, indexes/FKs/checks, and transition/delete guards; it
does not rewrite existing integration or publication rows.

This is modified AGPL-3.0 Postiz source. Operators who provide network access to
the modified service must provide the corresponding source under the repository
license. Reproducibility evidence is the exact base above, this branch's commits,
the lockfile, the migration, and these checks:

```bash
pnpm install --frozen-lockfile
pnpm run prisma-generate
pnpm exec prisma validate --schema libraries/nestjs-libraries/src/database/prisma/schema.prisma
pnpm exec vitest run --config vitest.connection-attempt.config.ts
pnpm run build:backend
```

For every upstream rebase/upgrade, rerun those checks plus existing publication-
attempt tests and manually re-audit provider `generateAuthUrl`, `authenticate`,
`reConnect`, page/company enumeration, `fetchPageInformation`, public auth
middleware, frontend callback routing, Integration uniqueness/lifecycle fields,
and Temporal refresh workflow signatures. Any changed provider redirect or
selection semantics stays disabled until simulated-provider tests and ownership,
replay, redaction, and atomicity invariants pass again. No live provider call is
part of this test contract.
