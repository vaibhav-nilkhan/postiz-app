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

| Method | Route                                                                     | Purpose                                                                       |
| ------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `POST` | `/public/v1/postify/connection-attempts`                                  | Idempotently reserve an attempt and return its durable authorization outcome. |
| `GET`  | `/public/v1/postify/connection-attempts/:id`                              | Poll a safe lifecycle projection; never recover an authorization URL.         |
| `GET`  | `/public/v1/postify/connection-attempts/external-operation/:operationRef` | Recover a lost pending create response by Postify operation identity.         |
| `POST` | `/public/v1/postify/connection-attempts/:id/selection`                    | Finalize one provider-safe option for a two-step provider.                    |

The create body is schema version 1:

```json
{
  "customerId": "exact-postiz-customer-id",
  "provider": "facebook",
  "purpose": "connect",
  "returnTarget": "postify",
  "externalOperationRef": "postify-social-operation-reference",
  "externalWorkspaceRef": "postify-workspace-reference",
  "externalActorRef": "optional-postify-actor-reference"
}
```

`externalOperationRef` is a bounded opaque Postify operation identity, immutable
and unique within the authenticated Postiz organization. Reusing it with the
exact same customer/workspace/actor/provider/purpose/reconnect/return identity
returns the same attempt. While that attempt is still pending, create and the
external-operation recovery route return the exact original `authorizationUrl`
without calling `generateAuthUrl` again. Identity reuse with any mismatch fails
closed. Concurrent create requests reserve one database row in `initializing`;
other create/recovery requests immediately return that finite state without
calling the provider. Activation moves it to `pending` only after the exact URL
and state are durably stored. A caught generation, binding, or encryption error,
or activation failure that remains uncommitted, moves it to `failed` with
`initialization_failed`; a committed activation wins when reread. A process-
interrupted initializer is given a renewable 60-second lease (heartbeated while
generation is in flight), then the next ID or operation read atomically applies
the same failure after its last heartbeat. Neither path races a live initializer
or regenerates an uncertain OAuth/OAuth1 operation. An expired, failed, or
consumed operation is never recycled into a new attempt.

`purpose: "reauthorize"` also requires `reconnectIntegrationId`. That
integration must be active and match the authenticated organization, exact
customer, and provider. Reauthorization preserves its Postiz integration ID and
fails with `account_mismatch` if the provider result cannot prove the same
provider account/page/channel.

Create returns `schemaVersion: 1`, the safe poll projection, and (only after
durable activation while pending) `authorizationUrl`. A concurrent initializer
may therefore return `initializing` without a URL. The normal ID poll and
finalize return only the finite status, bound attempt identity, expiry, safe
failure code, provider-safe selection display metadata, truthful local
lifecycle, and (only after success) `finalIntegrationId`.
Two-step finalization accepts only the opaque `selectionId` previously returned
by poll; caller-supplied provider payloads are not accepted.

Statuses are `initializing`, `pending`, `authenticating`, `awaiting_selection`,
`finalizing`, `succeeded`, `failed`, and `expired`. Failure codes are a closed
enum. `initialization_failed` means only that no usable authorization URL was
durably established; it does not claim that the provider observed no request or
created no provider-side artifact. A database trigger enforces immutable
identity fields and one-way transitions. State is random (or, for OAuth 1
providers, the provider's high-entropy request token),
necessarily present inside the provider `authorizationUrl` but never returned as
a separate field or stored raw. It is stored as a SHA-256 hash, bound to
attempt/organization/customer/provider/purpose by a correlation hash, consumed
with a compare-and-set, and expires in 15 minutes. The original authorization
URL is persisted only inside AES-256-GCM transient context so a lost create
response is recoverable. State consumption atomically replaces that context with
verifier-only ciphertext; uncertain exchange, terminal, and interim completion
clear it. No poll exposes the URL after authorization begins.

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
  For two-step attempts that callback deliberately returns
  `inBetweenSteps: false` with the configured Postify URL; provider-safe options
  are exposed through the machine projection so Postify, not the Postiz
  frontend, owns final selection.

Provider access/refresh tokens, authorization code, raw state, PKCE/OAuth
verifier, instance API keys, and custom credentials never appear in this API.
Provider selection results are reduced to bounded display fields; query strings
are removed from picture URLs. Interim and final writes transactionally recheck
organization/customer/provider/attempt ownership, assign the exact Customer,
and mark success. Deferred PostgreSQL custody triggers independently reject a
Customer or reconnect/interim/final Integration whose organization, customer,
or provider differs from the immutable attempt, and reject later Customer or
Integration identity changes that would break historical custody.
Before any direct credential/customer upsert or two-step revive, the transaction
also rejects an existing same-organization provider identity assigned to a
different non-null Customer. Existing unassigned or exact-customer integrations
remain recoverable; dashboard/manual integration behavior is unchanged.

A provider exception or unknown transaction acknowledgement after one-time code
exchange remains truthfully `authenticating` until expiry; the consumed code is
never replayed. If the transaction actually committed, the persisted success or
selection state wins when reread. Explicit denial, malformed authenticated data,
and wrong reconnect account are definitive failures. `finalizing` is similarly
resumable: the exact same opaque selection may retry only the provider's
read-only `fetchPageInformation` boundary and local serializable transaction.
Provider-read or unknown commit outcomes remain `finalizing`; malformed or
mismatched selection data fails definitively. A different selection cannot be
substituted.

Lifecycle is local Postiz fact only: `disabled`, `setupIncomplete`,
`refreshNeeded`, known `tokenExpiresAt`, and `softDeleted`. This contract does
**not** claim provider grant revocation, provider-side publication success,
Postify approval, or provider credential custody outside Postiz.

## Migration, upgrades, and modified-source notice

Apply
`libraries/nestjs-libraries/src/database/prisma/migrations/20260828000000_postify_connection_attempts/migration.sql`
and then
`libraries/nestjs-libraries/src/database/prisma/migrations/20260828010000_connection_attempt_idempotency_and_custody/migration.sql`
and then
`libraries/nestjs-libraries/src/database/prisma/migrations/20260828020000_connection_attempt_initialization_custody/migration.sql`
before serving the routes, then run Prisma generation. The migrations add the
aggregate, operation reservation/recovery identity, indexes/FKs/checks,
transition/delete guards, and deferred custody triggers. The second migration
backfills any pre-correction attempt with a non-reusable `legacy:<attempt UUID>`
operation identity. The third migration truthfully fails any pre-existing
uninitialized reservation and adds guarded `initializing` activation. None
rewrites Integration or publication rows.

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

The direct trigger tests require an isolated disposable PostgreSQL database and
are enabled with `POSTIZ_CONNECTION_ATTEMPT_POSTGRES_TEST=1` plus standard `PG*`
connection variables. They apply both migrations to minimal prerequisite tables,
commit valid direct/reauthorization/two-step transitions, and prove that direct
SQL cross-organization/customer/provider substitution is rejected.

For every upstream rebase/upgrade, rerun those checks plus existing publication-
attempt tests and manually re-audit provider `generateAuthUrl`, `authenticate`,
`reConnect`, page/company enumeration, `fetchPageInformation`, public auth
middleware, frontend callback routing, Integration uniqueness/lifecycle fields,
and Temporal refresh workflow signatures. Any changed provider redirect or
selection semantics stays disabled until simulated-provider tests and ownership,
replay, redaction, and atomicity invariants pass again. No live provider call is
part of this test contract.
