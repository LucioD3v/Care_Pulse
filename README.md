# CarePulse MCP

CarePulse is a voice-first family health assistant for Alexa+, built for the Build, Ship, Shape: Amazon Developer Hackathon. The planned backend uses MCP, Amazon Bedrock, and Amazon SNS.

## Alexa voice flows

The current interaction model supports:

- Logging blood pressure, temperature, heart rate, and sleep.
- Asking for health trends by timeframe.
- Requesting a caregiver alert.

Example phrases include “log my blood pressure,” “my temperature is 98.6 Fahrenheit,” “check my health trends this week,” and “alert my caregiver.”

The Lambda currently captures and repeats vital readings but does not persist them. Health history and caregiver alert delivery are not connected yet; the skill explicitly tells the user when a requested action has not been completed.
