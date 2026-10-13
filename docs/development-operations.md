# Development changes and operations

The moderate development changes implement DEV-M01 through DEV-M06 in code. Cloud deployment, real Alexa/Bedrock latency measurements, alarm subscriptions, and existing-data migration require separate verification.

## Voice response budget and factual wording

Alexa requests have a 6.5-second application budget, additionally capped by the remaining Lambda time. AWS calls receive abort signals and bounded timeouts. DynamoDB makes at most two attempts; Bedrock and SNS make one attempt to avoid extended voice waits or automatic duplicate notifications.

Bedrock is optional. It has a default 1.2-second timeout and selects between approved templates. Generated free-form speech never enters a response. Failure, invalid output, or exhausted budget uses deterministic copy. A downstream failure after a confirmed write says the report was saved. A failed write with an uncertain outcome does not ask the member to repeat it immediately.

VOICE_TIMEOUT_MS can adjust the model timeout between 50 and 2000 milliseconds. The model receives no member name, report details, or history for this template selection.

## Descriptive comparison rules

Rule version 2026-10-09.v1 defines:

- **today:** the member's current local calendar day, through the current instant.
- **this week:** the current local day and the preceding six local days.
- **this month:** the current local day and the preceding 29 local days.
- **Repetition:** the same signal reported as more-than-usual, same, or worse on at least two distinct local days. Positive states and different signals do not establish repetition.
- **Sleep comparison:** the latest numeric sleep report on each local day, at least two days of data, and a baseline with known provenance. The existing 0.75-hour comparison threshold is descriptive, not a clinical rule.

New non-demo profiles have no assumed sleep baseline. Existing baselines without a baselineSource are treated as unverified and excluded from comparisons. Confirmed records may use member or caregiver; the seed uses demo. The environment baseline applies only to the explicitly selected demo owner. A summary reports coverage and counts without inferring wellness from missing reports.

## Persistence and existing records

Base-table queries and exact reads use strong consistency. Queries follow continuation keys. Context and consent use exact composite keys. Follow-up creation atomically writes its record and a lookup reference; older follow-ups remain accessible through a paginated fallback. Pending follow-ups are searched in ascending due order.

The Serverless table adds the sparse PendingFollowups GSI for a five-minute operational monitor. It counts overdue records and rechecks each candidate against the base table because GSIs are eventually consistent. Completion removes the pending index attribute. This monitor sends no caregiver alerts or Alexa prompts.

Existing pending records require a backfill after the index is active:

~~~sh
CARE_TABLE_NAME="YOUR_TABLE" AWS_REGION="us-east-1" node lambda/backfill_followup_index.js
CARE_TABLE_NAME="YOUR_TABLE" AWS_REGION="us-east-1" node lambda/backfill_followup_index.js --apply
~~~

The first command is a dry run. The second adds index fields and references using conditional transactions; it does not overwrite a follow-up completed concurrently. Run it with a migration role that can scan, read, update, and put records in the selected table. It reports counts only. Ambiguous or nonexistent local due times stop the migration and require review. Until backfill is complete, overdue metrics cover indexed records only.

The ASK CloudFormation template now adds a separate `CarePulseTable` with the runtime's `pk/sk` schema, `PendingFollowups` index, TTL, encryption, and point-in-time recovery, and binds `CARE_TABLE_NAME` to it. The earlier `HealthMetricsTable` and its adapter permissions remain intact. Existing health records are not automatically migrated. Validate a deployment change set and the new table before closing cloud acceptance for DEV-C03.

## MCP contract

The server negotiates 2025-11-25 or 2025-06-18. Clients initialize, send notifications/initialized, then call tools with the session ID and negotiated version. POST requests require JSON content and an Accept header containing JSON and SSE. GET returns 405 because this server does not offer an SSE stream. Browser origins must be explicitly allowed using MCP_ALLOWED_ORIGINS.

Input and output schemas are validated. Successful structured results are objects and omit storage keys. The get_wellness_history result is now { events, period, nextCursor }; callers must follow nextCursor to retrieve subsequent pages. This replaces its previous array result. Tool errors return a stable public message, never raw dependency exceptions. SNS results distinguish accepted, unconfigured, failed, and unknown.

The API key is still a privileged shared credential. Schema validation does not bind it to a household or solve consent authorization at the tool boundary; DEV-C01 remains open.

Protocol references: [MCP lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle), [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports), and [tool output schemas](https://modelcontextprotocol.io/specification/2025-11-25/server/tools).

## Bee integration review (2026-10-12)

Reviewed team commits `8b3018a` (Bee ingestion and APL), `03b58ac` (consent and wearer-only filtering), and `db2f1dc` (Bee proxy bridge), merged into `ba16678`. The moderate development changes preserve these additions.

| Files | Integration result |
| --- | --- |
| `lambda/apl/aplSupport.js` | Reviewed without changes. Interface detection still gates APL; voice-only devices remain supported. |
| `lambda/apl/wellnessSnapshot.json`, `skill-package/assets/documents/wellnessSnapshot.json` | Both copies preserve the team's signal rows, Bee badge, and footer, with CarePulse branding and neutral missing-data colors. The scrollable content also includes the previous dashboard's latest report, next follow-up, and sharing permission. Tests check that both templates stay identical. |
| `lambda/apl/wellnessSnapshotPayload.js` | Missing data and readings without a verified baseline use a neutral display instead of a low-intensity indication. |
| `lambda/handlers/getWellnessSummaryHandler.js` | Integrates `getCareDashboard` and `addCareDashboard` into the team's handler factory. Voice and APL reuse context, paginated history, pending follow-up, and a time boundary. Screen devices additionally load the exact scoped consent. The latest-report panel retains its 30-day lookup when the selected summary period is empty. |
| `lambda/bee_link.js` | Retains expiring, revocable consent and hashed link codes. A dedicated error type allows actionable invalid-link responses without exposing dependency exceptions. Repository integration retains conditional writes and complete revocation queries. |
| `lambda/tools/ingestBeeContext.js` | Adds the missing MCP output contract, validates nested input, shares verified-baseline rules, removes identifying logs, and sanitizes partial-write errors. Partial failures are surfaced as MCP tool errors. |
| `scripts/bee_bridge.js` | Completes MCP initialization, advertises JSON and SSE, sends the negotiated version, bounds network waits, and rejects partial ingestion results. Dry runs and wearer-only filtering remain intact. |
| `scripts/bee_schema_report.js` | Invalid JSON produces a generic error rather than a parser message that could expose transcript excerpts. Successful reports still include field names and types. |
| `lambda/test/beeBridge.test.js`, `lambda/test/beeIntegration.test.js` | Adapted to the MCP lifecycle and explicit baselines; expanded coverage for pagination, revocation, neutral readings, partial results, and malformed exports. |

Related changes resolve the conflicts in `alexa_handlers.js`, `care_repository.js`, and `package.json`; register the eighth tool's output schema; and package the new `handlers/` and `tools/` directories. Clean-copy validation includes the bridge scripts used by the tests.

The initial conflict resolution left the existing dashboard disconnected and narrowed test discovery to the top-level test directory. This has been corrected: the summary now composes both features, the original dashboard API remains available, and `npm test` again discovers `test/**/*.test.js`. The nested `test/integration/summaryIntegration.test.js` suite verifies the combined experience, consent validity, shared reads, voice-only behavior, and legacy rendering. Bee's historic `sleepHoursBaseline` field is also supported when its provenance is verified.

Bee numeric sleep readings contribute to the same distinct-local-day comparison as voice readings. Keyword-derived low/moderate/high intensity is not converted into a claim that a member feels worse than usual. A single-reading APL intensity describes distance from a verified baseline; it is separate from the multi-day comparison rule.

Existing Bee records are not rewritten by this integration. Previously derived sleep classifications need a separately reviewed migration if they must be recalculated. The keyword extractor still does not resolve negation or third-person references; use reviewed synthetic examples for the demo. New event keys include a hashed Bee source ID (or export fingerprint), timestamp, and signal, so distinct source records at the same timestamp remain distinct. Every ingestion write transaction checks the active consent generation and expiry. Revocation moves consent to `revoking`, invalidates the link atomically, deletes Bee events with generation checks, and then marks it `revoked`. Relinking is blocked during deletion; retry an interrupted unlink to finish it.

**Validation:** Node 22 clean installation passed all 85 tests, including the nested integration suite. Production-only installation and loading all entry points from the extracted Lambda ZIP also passed through `scripts/verify-clean-install.js`. No deployment or real-device validation was performed.

## Installation, CI, and packaging

Use Node 22 from .nvmrc, the committed lambda/package-lock.json, and npm ci --prefix lambda. The command npm test --prefix lambda runs every suite, including the SDK v3 vitals adapter. Run node scripts/verify-clean-install.js in Linux or the Node 22 Docker image to validate a temporary copy without reusing workspace dependencies. This packaging check uses Python 3's standard ZIP library; Python is not a Lambda runtime dependency.

GitHub Actions installs from the lockfile, runs the suites, installs production-only dependencies, builds a ZIP, and loads the entry points from the extracted artifact. The ZIP has index.js at its root; use index.handler for a direct Lambda upload. Serverless builds its own packages using the configured lambda/index.handler path.

## Permissions, metrics, and response to failures

Deployment configuration is documented in the root `.env.example`; the ignored `.env` retains local values and includes the same AWS deployment reference. `serverless.yml` accepts environment fallbacks while retaining all existing parameter names. Use an explicit stage and a complete `.env.<stage>` file for each environment. Required Skill ID and MCP key values were already parameters in the previous YAML; no concrete credentials were removed from that file.

`SNS_TOPIC_ARN` remains a CloudFormation reference on Alexa and MCP. `BEDROCK_MODEL_ID` moved to Alexa only. `REQUIRE_BEDROCK=true` was deliberately retired when deterministic voice fallback became supported; it is recorded as historical reference, not an active setting. The previous `8.0` sleep baseline is also documented and can be explicitly configured for the demo owner. Runtime, architecture, memory, Lambda timeout, log retention, and default names/time zone remain unchanged. The former SNS managed key alias was replaced by the stack's customer-managed `NotificationKey`; it is not an environment secret.

Serverless defines separate roles for Alexa, MCP, and the overdue monitor. Only Alexa can invoke Bedrock, using the explicit comma-separated bedrockResourceArns parameter. Include the exact inference profile and foundation model ARNs needed by the selected model; wildcard model access is not granted. SNS uses a retained customer-managed KMS key, with publisher permissions restricted to that key and the regional SNS service. [SNS key permissions](https://docs.aws.amazon.com/sns/latest/dg/sns-key-management.html).

Set operationsAlarmTopicArn to an existing operations SNS topic with confirmed subscriptions and permission for CloudWatch alarm delivery. Alarms exist without this parameter, but no notification action is attached. These operational subscriptions are separate from caregiver subscriptions.

CloudWatch embedded metrics use namespace CarePulse and dimensions Service/Stage. Logs contain a Lambda correlation ID and numeric metrics; names, symptoms, consent IDs, session IDs, raw exception messages, and report bodies are excluded. Request and dependency durations, cold starts, errors, voice fallbacks, notification outcomes, and overdue counts are emitted. Inspect RequestDuration at p50/p95/p99 for Alexa and MCP separately; the Alexa p95 alarm threshold is 3000 milliseconds. This is a target, not a measured production result.

For a notification alarm:

1. Find the request using the correlation ID and aggregate metrics.
2. Check SNS/KMS permissions, service health, and the provider outcome without copying wellness records into logs or tickets.
3. For unknown outcomes, reconcile provider acceptance before resending; loss of the response can occur after acceptance.
4. Before any operator-approved retry, revalidate the exact consent, follow-up, and recipient. A failed or unknown notification is never represented as a simulated success.

Completion now commits its result, wellness event, and any alert outbox record in one transaction. Requests are deduplicated, and an alert can be claimed by only one publisher. Known rejected or unconfigured attempts can be explicitly retried up to three attempts after revalidating consent. Server errors, timeouts, and lost responses are treated as unknown acceptance. `accepted` is reused without publishing again. `sending` after an interrupted invocation and `unknown` require provider reconciliation and are not automatically resent. No automatic retry worker is installed, so eventual delivery remains open under DEV-C06. Measure deployed latency, verify encrypted SNS acceptance, exercise the alarms, and validate the monitor before closing cloud acceptance.

## Critical changes: hackathon scope

This iteration targets a synthetic-data demo. Public privacy/terms documents, S3 publication, production onboarding, and identity-provider provisioning are deferred at the project owner's request. No cloud resources or external notifications were created during local verification.

Validation: clean Node.js 22 installation, 117 passing tests, production-only dependency installation, ZIP creation, and extracted Lambda entry-point loading. The critical suite adds 32 tests; device/model-build and AWS acceptance are separate.

- Templates explicitly use `CARE_MODE=demo`; the runtime never silently assumes demo mode. Local memory storage also requires `CARE_STORAGE_MODE=memory`, and is rejected inside AWS Lambda. A missing care table is an error in a deployed function.
- `DEMO_OWNER_ID` is a shared synthetic household, used by both ASK and MCP when configured. The demo key is privileged; do not give it to untrusted clients. Missing Alexa identity is rejected. Default Elena/Laura profiles are created only in explicit demo mode.
- Alert authorization is enforced in the domain service. A fabricated boolean, consent ID, other signal, expired/revoked consent, pending result, or changed caregiver binding cannot authorize publication. Consent is tied to one pending follow-up; replacing its caregiver revokes the old binding.
- `stop sharing my reports` revokes sharing for the member's existing follow-ups; `what will you share` explains its scope. A No during the sharing prompt also revokes a previous permission. An alert already claimed for publication cannot be recalled, and the revocation result reports that limitation.
- The MCP catalog adds exact-ID list/complete/cancel/revoke operations. Direct MCP consent creation remains restricted to trusted demo clients; a production tool call cannot claim the person's affirmative confirmation.
- ASK now has a manual dialog model and validates signal/status/time/numeric values. Missing intensity stays `reported`. Follow-up confirmations give the stored date/time and explicitly require reopening the skill; no reminder or proactive conversation is scheduled.

The unused production foundation verifies signed access tokens, issuer, resource audience, expiry, and scope, then loads an approved identity binding and member roles. It also requires a verified caregiver destination, allowed topic, and exactly one matching SNS subscription. Provisioning, IAM for individual destinations, protection against subscription changes, a secure member onboarding flow, and live Alexa+ validation are still required; this foundation does not make the demo production-ready.

For a future AWS implementation, start with **Amazon Cognito User Pools** as the OAuth authorization service, using authorization code with PKCE S256 and refresh tokens. Keep the Alexa+ service-token and user-token flows separate. Cognito supports these OAuth capabilities, but the full Alexa+ metadata, resource binding, redirects, and two-tier integration must be validated before adopting it. This is a future recommendation, not infrastructure added for the hackathon. [Cognito authorization endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/authorization-endpoint.html), [Alexa+ MCP authentication](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-authentication.html).
