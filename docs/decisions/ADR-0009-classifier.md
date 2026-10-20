# ADR-0009: Auto-save classifier (optional, off by default)

- Status: proposed
- Date: 2026-10-20
- Research: docs/research/platform.md §k

## Decision

**Pipeline.** UserPromptSubmit and Stop hooks (`async: true`) append the
prompt / `last_assistant_message` to a local, unsynced inbox
(`~/.rembo/inbox/<session>.jsonl`) and return immediately. A detached worker
(spawned by the Stop hook if none is running, lock-protected) drains the
inbox: secret guard (redact) -> provider -> `{score 0..1, category:
preference|decision|fact|howto|infra|none, scope, summary}` -> if score >=
threshold (0.8) create an L2 entry (+ L1 note) and sync; else log locally
(7-day retention, no content beyond the summary). Nothing runs when the
session is off.

**Providers (pluggable `Classifier` interface):**

| provider | data leaves to | cost / 1000 classifications* | notes |
| --- | --- | --- | --- |
| `none` (default) | — | 0 | |
| `heuristic` | — | 0 | keyword/pattern rules ("remember", "always", "from now on", paths, commands); offline fallback |
| `claude` | Anthropic (already sees the session) | counts against the user's plan | via the mod's `$.model.complete` (session's own client, small model); no extra key, no new third party; needs the mod (early access) |
| `jev` | TypeSafe AI | ~$0.025 | the "Jev" from the video: a hosted yes/no / score model, ~100 ms, $0.042 / M input tokens, outputs free (BYOK) |
| `openrouter` / `openai-compatible` | chosen provider | ~$0.02–0.13 | json_schema output, or a 1-token label with `logprobs` on providers that support it (`provider.require_parameters: true`; non-reasoning models such as mistral-nemo, gemma-3-27b, gpt-4o-mini) |

\* ~600 input + ~60 output tokens per call (research §k, prices 2026-10-20).

Recommended when the user turns it on: `claude` if the mod is active, else
`heuristic`; external providers only with an explicit choice. "Treg" from the
video could not be identified; a similar open-source project (`jevmem`, MIT)
exists and is worth reading before Etap 5.

**Guards.** Daily call and character caps, timeout (5 s), retries with
backoff, cost counter in `rembo status`; enabling prints exactly what is sent
where and requires confirmation (`rembo classifier enable <provider>`);
toast "Remembered: ... (/rembo forget <id>)" through the mod.

**Evaluation.** ~50 labelled examples (PL + EN) in `packages/core/test/
classifier/`; report precision/recall at 0.8 and cost per 1000 turns; tests
use a mock provider until a key is provided.

## Consequences

- Zero added latency in the session (async hooks + detached worker).
- The only path where conversation text can reach a third party is an
  explicit opt-in, and it is listed in THREAT-MODEL.md.
