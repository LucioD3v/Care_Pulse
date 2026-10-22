# CarePulse MCP — Developer Experience & Friction Log

This document outlines the key technical friction points encountered while integrating the Model Context Protocol (MCP), AWS Bedrock, Bee Agent Framework, and Alexa ASK SDK during the Build, Ship, Shape: Amazon Developer Hackathon.

---

## Entry 1: High Response Latency during Conversational Multi-Step MCP Tool Execution with Alexa

* **Task Attempted:** Executing sequential MCP tool calls (`get_care_context` -> `compare_with_baseline` -> `request_consent`) inside an active Alexa+ voice session.
* **Steps Taken:**
  1. Configured the Alexa Lambda Handler to invoke the Bee Agent framework.
  2. The agent received user speech input and initiated a multi-turn reasoning loop via AWS Bedrock.
  3. The agent evaluated baseline vitals and requested consent confirmation in real time.
* **Expected Result:** Voice interaction would remain fluid, staying within the Alexa+ MCP round-trip limit of 500 ms per call for natural voice conversations.
* **Actual Result:** The multi-step agentic loop (LLM reasoning + MCP JSON-RPC tool roundtrips) introduced a latency of 3.2 to 4.5 seconds, causing Alexa audio timeouts (far exceeding the 500 ms Alexa+ round-trip budget and the standard ASK SDK response window).
* **Severity Rating:** **High (Blocker for Voice UX)**
* **Workaround Used:** Implemented an early-exit execution strategy and parallelized non-dependent MCP tool calls. For routine check-ins, local deterministic logic resolves simple responses ("Better") in single-digit milliseconds, reserving full AWS Bedrock LLM execution strictly for complex symptom triage ("Same or Worse"). The MCP Lambda also uses provisioned concurrency (`mcpProvisionedConcurrency`) and CloudWatch alarms (`McpLatencyAlarm` at p95 400 ms) to keep cold starts off the request path, and `scripts/measure_mcp_latency.js` enforces the 500 ms budget in CI.
* **Actionable Suggestion:** Provide a lightweight, asynchronous streaming interface or pre-warmed agent execution context within the ASK SDK / MCP connector to allow partial audio streaming or progressive SSML prompts while the background LLM agent resolves tool calls.

---

## Entry 2: Normalizing Non-Standard Telemetry Schemas from Bee Wearable CLI to MCP Tool Inputs

* **Task Attempted:** Mapping passive biometric telemetry (sleep quality score, heart rate variability, and fatigue index) collected via the Bee Wearable device/CLI into the standardized `ingest_bee_context` MCP tool JSON schema.
* **Steps Taken:**
  1. Extracted raw telemetry output via Bee CLI scripts (`scripts/bee_bridge.js`, `scripts/bee_schema_report.js`).
  2. Passed raw JSON payloads directly into the LLM context prompt for AWS Bedrock reasoning.
* **Expected Result:** The LLM would natively parse heterogeneous biometric fields and automatically map them to the MCP tool parameters.
* **Actual Result:** Variances in timestamps, missing optional metrics (e.g., HRV missing during low battery state), and unformatted float arrays degraded Bedrock's schema validation, leading to occasional tool call failures.
* **Severity Rating:** **Medium**
* **Workaround Used:** Built a lightweight normalization and validation layer within the MCP server tool (`lambda/tools/ingestBeeContext.js`) that validates nested input, applies shared verified-baseline rules and fallback defaults for missing fields, normalizes timestamps, sanitizes partial-write errors, and surfaces partial failures as MCP tool errors before context reaches AWS Bedrock.
* **Actionable Suggestion:** Publish official type-safe schema adapters (Pydantic / TypeScript) in the Bee SDK/CLI documentation specifically optimized for Model Context Protocol (MCP) tool registrations.
