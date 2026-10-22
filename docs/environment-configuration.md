# CarePulse environment configuration

This is the reference for configuration read by the current skill, MCP gateway, and local Bee tooling. Copy `.env.example` to an ignored `.env` only for a new checkout; keep an existing `.env` and its local values. Serverless accepts `--param` overrides before `env:` fallbacks. A variable shown in `.env.example` is not automatically passed to every Lambda function: only values mapped in `serverless.yml` are deployed.

The current project is a **synthetic-data hackathon demo**. `production` selects stricter runtime paths, but member onboarding (binding a Cognito user to an existing owner) and recipient provisioning are not complete. The Alexa+ OAuth path is provisioned; see [alexa-plus-addon.md](alexa-plus-addon.md).

## Mode and storage

| Variable | Values and behavior | Required? |
| :--- | :--- | :--- |
| `CARE_MODE` | Use `demo` for the hackathon or `production` for the non-demo code path. Serverless defaults to `demo` if neither a parameter nor an environment value is supplied. A direct runtime invocation with no value behaves as non-demo; other non-`demo` strings also currently behave as non-demo and should not be used as mode names. `demo` is rejected when `STAGE` is `prod` or `production`. The CloudFormation `CareMode` parameter allows only `demo` and `production`. | Set explicitly in each deployment environment so the selected path is reviewable. |
| `CARE_STORAGE_MODE` | `memory` enables local in-memory storage only when `CARE_MODE=demo`, `CARE_TABLE_NAME` is absent, and the process is **not** AWS Lambda. Other values do not enable memory. Serverless does not forward this variable to Lambda. | Optional for local demo/tests; omit for deployment. |
| `CARE_TABLE_NAME` | DynamoDB care table name. When present, DynamoDB is used even if local `CARE_STORAGE_MODE=memory` is set. Serverless and the CloudFormation skill stack supply it from the table resource. | Required for deployed Lambda; do not set manually in the managed stack. |
| `STAGE` | Deployment stage such as `dev`, `qa`, or `prod`; Serverless supplies it from `--stage` and defaults to `dev`. The literal values `prod` and `production` prohibit demo mode. | Supply `--stage` explicitly when deploying. |
| `WELLNESS_RETENTION_DAYS` | Integer `1` through `365`; default `90`. Invalid values cause a runtime configuration error. Controls expiry on new wellness events and related short-lived records; it does not delete all context or metadata records. | Optional. |

For a local, table-free run, use `CARE_MODE=demo` and `CARE_STORAGE_MODE=memory`, with `CARE_TABLE_NAME` unset. For a Serverless demo deployment, use `CARE_MODE=demo` and let the stack provide `CARE_TABLE_NAME`; local memory mode is unnecessary. Do not deploy `CARE_MODE=demo` to a `prod` or `production` stage.

## Skill and gateway

| Variable | Values and behavior | Required? |
| :--- | :--- | :--- |
| `CAREPULSE_ALEXA_SKILL_ID` | The full Alexa Skill ID (`amzn1.ask.skill...`). Serverless also accepts `alexaSkillId`; it is used for the Alexa trigger and request validation. | A Skill ID is required for deployment; this variable may be omitted when `alexaSkillId` is supplied. |
| `CAREPULSE_COVER_IMAGE_URL` | Public HTTPS URL for the CarePulse welcome cover on APL-capable devices. Serverless also accepts `coverImageUrl`. If the card-specific URLs are omitted, this image is also used by Alexa app cards. | Optional; when omitted, launch responses use a text-only card and no welcome APL directive. |
| `CAREPULSE_CARD_SMALL_IMAGE_URL` | Public HTTPS URL for the 720×480 Alexa app card image. Serverless also accepts `cardSmallImageUrl`; falls back to `CAREPULSE_COVER_IMAGE_URL`. | Optional. |
| `CAREPULSE_CARD_LARGE_IMAGE_URL` | Public HTTPS URL for the 1200×800 Alexa app card image. Serverless also accepts `cardLargeImageUrl`; falls back to `CAREPULSE_COVER_IMAGE_URL` and can also supply the APL cover. | Optional. |
| `CAREPULSE_WELLNESS_BACKGROUND_URL` | Public HTTPS URL for the 1920×1080 wellness-summary APL background. Serverless also accepts `wellnessBackgroundUrl`. The dashboard keeps its solid-color fallback when omitted or invalid. | Optional. |
| `CAREPULSE_REPORT_BACKGROUND_URL` | Public HTTPS URL for the `ReportWellnessIntent` APL background. Serverless also accepts `reportBackgroundUrl`; falls back to `CAREPULSE_WELLNESS_BACKGROUND_URL` when omitted. | Optional. |
| `CAREPULSE_HOME_BACKGROUND_URL` | Public HTTPS URL for the actionable home-menu background shown after the five-second cover. Serverless also accepts `homeBackgroundUrl`; falls back through the report and wellness backgrounds. | Optional. |
| `CAREPULSE_FOLLOWUP_COMPLETE_BACKGROUND_URL` | Public HTTPS URL for the completed follow-up APL background. Serverless also accepts `followupCompleteBackgroundUrl`; falls back to `CAREPULSE_REPORT_BACKGROUND_URL` when omitted. | Optional. |
| `CAREPULSE_PERMISSION_BACKGROUND_URL` | Public HTTPS URL for the permission-confirmation APL background. Serverless also accepts `permissionBackgroundUrl`; falls back to `CAREPULSE_REPORT_BACKGROUND_URL` when omitted. | Optional. |
| `MCP_API_KEY` | Nonempty secret expected in the `x-carepulse-mcp-key` request header in demo mode. Serverless resolves `mcpApiKey`, then `MCP_API_KEY`, then `CAREPULSE_MCP_KEY` **only when the preceding value is undefined**. A blank `MCP_API_KEY=` can therefore prevent alias fallback. | A nonempty key is required for demo requests; this variable may be omitted when a parameter or the alias supplies it. |
| `CAREPULSE_MCP_KEY` | Local Bee bridge secret; use the same value as the deployed demo `MCP_API_KEY`. The bridge reads this name, not `MCP_API_KEY`. It can also be the Serverless fallback if `MCP_API_KEY` is absent rather than blank. | Required only when running `scripts/bee_bridge.js --send` or using it as the gateway-key fallback. |
| `MCP_MEMORY_SIZE` | Memory in MB for the MCP gateway Lambda; default `1024`. Lambda CPU scales with memory, which shortens initialization and request handling. Serverless also accepts `mcpMemorySize`. | Optional. |
| `MCP_PROVISIONED_CONCURRENCY` | Pre-initialized MCP environments; default `0` (off). Set `1` while recording the demo and during judging so cold starts stay off the request path; it is billed while enabled. To turn it off, omit the parameter rather than passing `0`, and confirm the first deploy with it enabled creates the `provisioned` alias. Serverless also accepts `mcpProvisionedConcurrency`. | Recommended `1` for Alexa+ testing. |
| `MCP_ALLOWED_ORIGINS` | Comma-separated browser origins, for example `https://app.example.com`; empty by default. Requests with an `Origin` header are rejected unless the exact origin is listed. Requests without an `Origin` header are not filtered by this setting. | Optional. |
| `ALEXA_REDIRECT_URIS` | Comma-separated Alexa+ redirect URIs, with no spaces after the commas, printed by `alexa-ai configure-account-linking`; registered as Cognito callback URLs. Serverless also accepts `alexaRedirectUris`. Defaults to a placeholder until the URIs are known. | Required before account linking can complete; redeploy after setting it. |
| `MCP_RESOURCE_URL` | Canonical MCP URL published as `resource` in the protected resource metadata. Defaults to `https://<request host>/mcp`. Serverless also accepts `mcpResourceUrl`. | Only with a custom domain; it must match the add-on manifest URL exactly. |
| `OAUTH_ISSUER_URL` | Base URL published as the authorization server. Defaults to `https://<request host>`. Serverless also accepts `oauthIssuerUrl`. | Only with a custom domain. |
| `DEMO_TOKEN_SUBJECT` | Demo mode only: the Cognito `sub` of the single user allowed to act for `DEMO_OWNER_ID` through OAuth (Alexa+). Empty, the default, refuses every token. Serverless also accepts `demoTokenSubject`. | Required for Alexa+ testing in demo mode. |
| `MCP_JWT_ISSUER`, `MCP_JWKS_URI`, `MCP_JWT_CLIENT_IDS`, `COGNITO_DOMAIN_URL`, `MCP_OAUTH_SCOPES` | Set by the stack from the Cognito user pool, domain, and app client. Tokens are accepted by issuer, signature, `token_use: access`, the `carepulse/access` scope, and either an allowed `aud` (`MCP_JWT_AUDIENCE`) or an allowed `client_id`. | Managed by Serverless; do not override. |
| `AWS_REGION` | AWS region name such as `us-east-1`; Serverless and SDK clients default to `us-east-1`. `--region` takes precedence for Serverless. | Optional if the default is correct. |

## Voice, member defaults, and alerts

| Variable | Values and behavior | Required? |
| :--- | :--- | :--- |
| `CAREPULSE_BEDROCK_MODEL_ID` | Exact model or inference-profile ID for optional approved-template selection. Empty disables Bedrock and uses deterministic wording. Serverless also accepts `bedrockModelId`. | Optional. |
| `BEDROCK_RESOURCE_ARNS` | Comma-separated exact Bedrock inference-profile ARN and every destination foundation-model ARN allowed by the Alexa IAM role. Set alongside `CAREPULSE_BEDROCK_MODEL_ID`; blank when Bedrock is disabled. | Required only when enabling Bedrock through Serverless. |
| `VOICE_TIMEOUT_MS` | Milliseconds for optional Bedrock selection; default `1200`. Finite values are clamped to `50`–`2000`; invalid values fall back to `1200`. | Optional. |
| `DEFAULT_MEMBER_NAME` | Synthetic demo member name; default `Elena`. It does not enroll a production member. | Optional for demo. |
| `DEFAULT_CAREGIVER_NAME` | Synthetic demo caregiver name; default `Laura`. It does not verify a production recipient. | Optional for demo. |
| `DEFAULT_TIME_ZONE` | IANA time-zone ID such as `America/Mexico_City`; default `America/Mexico_City`. | Optional if the default is correct. |
| `DEMO_OWNER_ID` | Shared synthetic household ID for the demo and seed. Empty by default. When set outside demo mode, Alexa access is rejected. Use one isolated ID only for trusted demo clients. | Optional for the demo; needed to align the seed, Alexa, and MCP around one fixture household. |
| `DEFAULT_BASELINE_SLEEP_HOURS` | Numeric hours greater than `0` and at most `24`; blank means no configured demo baseline. Applies only when the owner matches `DEMO_OWNER_ID`. | Optional for demo. |
| `BEE_CONSENT_DAYS` | Positive numeric number of days; default `30` when absent or invalid. The current Serverless stack does **not** forward it, so setting it only in `.env` has no deployed effect. | Optional for local use or a separately configured Lambda environment. |
| `SNS_TOPIC_ARN` | SNS caregiver-alert topic. Serverless and the CloudFormation skill stack provide their managed topic ARN. The shared demo topic may notify every subscriber. | Managed by the stack; do not set manually for the managed deployment. |
| `OPERATIONS_ALARM_TOPIC_ARN` | Existing SNS topic ARN for optional CloudWatch alarm actions; blank means alarms have no SNS action. | Optional. |

## Future production-only settings

These runtime settings are **not** currently mapped into the Serverless Lambda environment. Adding them to `.env` alone does not complete production setup.

| Variable | Expected value and use |
| :--- | :--- |
| `MCP_JWT_ISSUER` | HTTPS OIDC issuer for signed MCP access tokens. |
| `MCP_JWT_AUDIENCE` | One or more accepted token audiences, comma-separated. |
| `MCP_JWKS_URI` | HTTPS JWKS endpoint without embedded credentials. |
| `SNS_ALLOWED_TOPIC_ARNS` | Comma-separated allowlist of verified caregiver SNS topic ARNs. |

`REQUIRE_BEDROCK` is retired and is not read. `AWS_LAMBDA_FUNCTION_NAME`, AWS credentials, and resource-output variables are supplied by AWS or local tooling rather than application configuration. LocalStack variables at the top of `.env.example` are for the developer's local tooling; they are not forwarded by `serverless.yml`.

The optional `LOCALSTACK_ENDPOINT` (or fallback `AWS_ENDPOINT_URL`) is read only by the legacy `lambda/aws-services.js` adapter. When either is set, that adapter uses `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY`, with local test defaults of `test`. Do not set an endpoint override in a managed AWS deployment. The `LOCALSTACK_IMAGE`, `LOCALSTACK_AUTH_TOKEN`, `LOCALSTACK_PORT`, `LOCALSTACK_DEBUG`, `LAMBDA_RUNTIME_IMAGE`, and `LAMBDA_RUNTIME_ENVIRONMENT_TIMEOUT` entries in `.env.example` are local tooling settings, not CarePulse Lambda settings.
