---
"anyagent-js": patch
---

Fix native structured output being dropped when the model streams prose before answering through the schema channel. Claude Code ≥ 2.1.220 freely emits preamble text (and injects a `[structured-output-enforce]` nudge) before the StructuredOutput call, which made schema runs nondeterministically throw `Parse: no JSON value found in reply`. The CLI's payload now rides `RunResult.structuredOutput`, schema evaluation prefers it over text extraction (which stays the emulated-tier path), and a payload that fails validation is what the correction retry and `Parse` error quote back.
