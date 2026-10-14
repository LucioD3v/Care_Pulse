# Publishing CarePulse as an Alexa+ MCP add-on

Alexa+ connects to MCP servers through an **Alexa+ MCP add-on** created with the `alexa-ai` CLI. The add-on requires OAuth 2.1 authorization code flow with PKCE (S256), discovered from a Protected Resource Metadata document. The shared `x-carepulse-mcp-key` header is not supported by Alexa+, so this setup adds an OAuth path next to it.

## How the pieces fit

```
Alexa+ ──GET /.well-known/oauth-protected-resource──► CarePulse (resource, authorization server, scopes)
Alexa+ ──GET /.well-known/oauth-authorization-server─► CarePulse (endpoints, code_challenge_methods_supported: S256)
Alexa+ ──/oauth/authorize (PKCE)──► CarePulse ──302──► Cognito managed login (user signs in)
Alexa+ ──POST /oauth/token────────► CarePulse ──────► Cognito /oauth2/token (access + refresh token)
Alexa+ ──POST /mcp, Authorization: Bearer <token>──► CarePulse verifies the Cognito token and runs tools
```

CarePulse serves its own authorization-server metadata because Cognito's discovery document omits `code_challenge_methods_supported`, and Alexa+ blocks deployment without `S256` there. The `/oauth/*` endpoints forward to Cognito and drop the RFC 8707 `resource` parameter, which Cognito would otherwise turn into a token audience. Cognito still performs sign-in, PKCE verification, and token issuance. CarePulse accepts the resulting access tokens by issuer, `client_id`, `token_use: access`, and the `carepulse/access` scope.

In demo mode (`CARE_MODE=demo`), only the Cognito user whose `sub` equals `DEMO_TOKEN_SUBJECT` can use a token, and that user acts for `DEMO_OWNER_ID`. Any other account, or any token when `DEMO_TOKEN_SUBJECT` is empty, gets 401, so a second Cognito user can never read or change the demo records. Tools then hide `ownerId`, and a call naming another owner is rejected. Caregiver-sharing consent can only be granted by the person's spoken "yes" in the CarePulse skill: token callers do not see `request_consent`, and calling it is rejected, as in production. In demo mode token callers also cannot call `send_caregiver_alert`, because demo alerts go to the shared demo topic without destination verification; the voice skill still sends the alert after the check-in. Production token callers can use `send_caregiver_alert`, which keeps its consent and verified-destination checks. Production mode keeps the existing identity binding (`IDENTITY#…` records) and requires a provisioned profile.

## Steps

1. **Deploy** this branch with `DEMO_OWNER_ID` set. Note the outputs `McpEndpoint`, `McpProtectedResourceMetadataUrl`, `McpOAuthClientId`, and `McpUserPoolId`.
2. **Check discovery:** open `McpProtectedResourceMetadataUrl` in a browser. `resource` must equal `McpEndpoint` exactly. If you use a custom domain, set the `mcpResourceUrl` and `oauthIssuerUrl` parameters.
3. **Create the demo sign-in user** (self sign-up is disabled):
   ```
   aws cognito-idp admin-create-user --user-pool-id <McpUserPoolId> --username <email> --user-attributes Name=email,Value=<email> Name=email_verified,Value=true --desired-delivery-mediums EMAIL
   ```
   Cognito emails a temporary password, and the first sign-in asks for a new one. Then read the user's `sub` and redeploy with it, so only this account can use the demo through Alexa+:
   ```
   aws cognito-idp admin-get-user --user-pool-id <McpUserPoolId> --username <email> --query "UserAttributes[?Name=='sub'].Value" --output text
   serverless deploy --param="demoTokenSubject=<sub>" ...
   ```
4. **Read the client secret** in the Cognito console (App clients → `carepulse-<stage>-alexa-plus`). Never paste it into a command line.
5. **Create the add-on** (requires a US Alexa developer account):
   ```
   alexa-ai configure
   alexa-ai new mcp --name CarePulse --mcp-server-url <McpEndpoint>
   ```
   Answer **Y** to account linking.
6. **Configure account linking.** Provide the secret through the environment variable, not a flag:
   ```
   # PowerShell: $env:ALEXA_CLIENT_SECRET="<secret>"
   alexa-ai configure-account-linking --addon-id <id> --stage development --client-id <McpOAuthClientId>
   ```
   The CLI prints Alexa's redirect URIs.
7. **Register those redirect URIs in Cognito:** redeploy with `alexaRedirectUris` set to the comma-separated list. Alexa caches auth metadata at deploy time, so redeploy the add-on afterwards too.
8. **Deploy and test:** run `alexa-ai deploy`, then test in the Alexa+ web simulator. The first tool call returns 401, Alexa+ starts account linking, you sign in with the user from step 3, and later calls carry the token.
9. **Privacy policy:** use the public URL of [`docs/privacy-policy.md`](privacy-policy.md) on GitHub.

## Example phrases for the add-on manifest

Alexa+ asks for 3–4 examples of 200 characters or fewer:

- "Ask CarePulse to log that I feel more tired than usual."
- "Ask CarePulse for my wellness summary this week."
- "Ask CarePulse to check in with me again at six."
- "Ask CarePulse whether my sleep is below my usual routine."

## Known gaps

- **Latency:** Alexa+ requires round trips under 500 ms. Lambda cold starts, plus the first JWKS download, can exceed that. Enable provisioned concurrency on `mcpGateway` before recording the demo.
- **Production identity:** linking a Cognito user to an existing Alexa owner outside demo mode still needs an onboarding flow that creates the `IDENTITY#` binding.
- **Not verified on Alexa+:** the add-on flow has not been tested yet. A competitor's README reports that organizers said Alexa+ cannot be called during the contest; confirm on the hackathon forum.
