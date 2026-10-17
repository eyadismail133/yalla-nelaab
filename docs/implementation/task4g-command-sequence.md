# Command identity and dedup regression tests

Resume conversation `07a6c8b1-d842-48fb-a766-827a1fe82fe9` with Gemini 3.8 Flash High. Scope only a NEW `apps/web/src/net/sequence.test.ts`. Do not edit production, existing tests, config, dependencies or docs. Do not start emulators, commit, stage, push, deploy, delegate, review, change permissions, enable billing or use paid resources. Another conversation owns Firebase runtime/transport recovery.

Inspect `sequence.ts`, the existing transport tests and project test conventions. Add compact, meaningful tests of the public command-identity/dedup contract. Earlier reviewed bugs accepted malformed legacy IDs and parsed underscores/digits ambiguously, so protect against those regressions.

- Generated IDs round-trip their intended sequence even when a seat contains underscores/digits. Multiple generated nonces remain distinguishable. Malformed IDs, ambiguous old format, zero/negative/fractional sequences and invalid suffixes are rejected; don't create an unreachable huge-counter project.
- ClientSequencer increments before send and resumes from persisted storage after a new instance, without reusing prior sequence numbers. Use a small real Storage implementation, not a mocked sequencer.
- HostDedupTracker executes a first command, replays the exact latest cached ack without executing, rejects a different ID with the same sequence, rejects an older valid ID after a newer accepted command, and rejects malformed IDs. Persist and restore the real tracker through JSON, then verify those same observable replay/rejection guarantees. Cover successful and failed cached acknowledgements without copying the tracker implementation into assertions.

No artificial test bypasses, mock multiplayer, skip/only, dependencies or test-only production helpers. These are focused pure contract regressions; they do not prove atomic Firebase persistence or host restoration. If a real defect is found, report it with the failing example rather than changing production. Run `npx vitest run apps/web/src/net/sequence.test.ts`, report actual results and scope. Codex independently reviews and verifies.
