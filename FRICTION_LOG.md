# CarePulse MCP — Developer Experience & Friction Log

This document outlines the key technical friction points encountered while integrating the Model Context Protocol (MCP), AWS Bedrock, the Bee Wearable CLI, and the Alexa ASK SDK during the Build, Ship, Shape: Amazon Developer Hackathon.

---

## Entry 1: An LLM-Driven Reasoning Loop Could Not Meet the Alexa+ 500 ms Round-Trip Budget

* **Task Attempted:** Our first design had an LLM drive the conversation, reasoning over sequential MCP tool calls (`get_care_context` -> `compare_with_baseline` -> `request_consent`) inside an active Alexa+ voice session.
* **Steps Taken:**
  1. Prototyped an LLM-driven loop in the Alexa Lambda handler that let AWS Bedrock plan and chain MCP tool calls.
  2. The model received user speech input and ran a multi-turn reasoning loop, calling MCP tools between turns.
  3. The model evaluated the baseline comparison and attempted to drive the consent confirmation in real time.
* **Expected Result:** Voice interaction would remain fluid, staying within the Alexa+ MCP round-trip limit of 500 ms per call for natural voice conversations.
* **Actual Result:** The multi-step LLM loop (model reasoning + MCP JSON-RPC tool roundtrips) introduced a latency of 3.2 to 4.5 seconds, causing Alexa audio timeouts (far exceeding the 500 ms Alexa+ round-trip budget and the standard ASK SDK response window). The loop also made outcomes non-deterministic, which is unacceptable for a consent and alerting decision.
* **Severity Rating:** **High (Blocker for Voice UX)**
* **Resolution (approach we shipped):** We rejected the LLM-driven loop. CarePulse now uses deterministic ASK SDK handlers for the conversation, consent, and alerting policy; nothing agentic sits on the request path. AWS Bedrock is reduced to a single, bounded `Converse` call in `lambda/voice_agent.js` that only selects an approved voice template (`standard` or `neutral`) and never decides facts, consent, or delivery; on any timeout or invalid output it falls back to deterministic copy. The MCP Lambda also uses provisioned concurrency (`mcpProvisionedConcurrency`) and CloudWatch alarms (`McpLatencyAlarm` at p95 400 ms) to keep cold starts off the request path, and `scripts/measure_mcp_latency.js` enforces the 500 ms budget in CI.
* **Actionable Suggestion:** For voice assistants with a hard round-trip budget, a lightweight asynchronous streaming interface (partial audio / progressive SSML prompts while background work resolves) in the ASK SDK / MCP connector would let teams keep some model-in-the-loop flexibility without blowing the latency budget.

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
