# ADR-0009: Auto-save classifier — deferred

- Status: deferred (2026-10-20, maintainer decision)
- Research: docs/research/platform.md §k

## Decision

No classifier in this round. Capture comes from the native memory bridge
(Claude Code's own auto memory already decides what is worth keeping) and the
`remember` tool (ADR-0006). Etap 5 is dropped from this round.

A `Classifier` interface stays in `core` so it can be added later if bridged
native memory proves insufficient. Options already researched, for that day:

| provider | data leaves to | cost / 1000 calls | note |
| --- | --- | --- | --- |
| `claude` | Anthropic (already sees the session) | user's plan | mod `$.model.complete`, no extra key |
| `jev` | TypeSafe AI | ~$0.025 | the "Jev" from the video; BYOK |
| `openrouter` / OpenAI-compatible | chosen provider | ~$0.02–0.13 | json_schema or 1-token label + logprobs |
| `heuristic` | — | 0 | offline rules |

Any external provider would be an explicit opt-in that sends redacted
snippets off the machine (THREAT-MODEL.md).

## Consequences

- No inbox, worker, provider adapters, cost limits or evaluation set now.
- No conversation text ever leaves the machine except to the model the user
  is already talking to.
