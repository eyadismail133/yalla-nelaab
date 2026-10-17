# Independent review findings for Task3a

CHANGES_REQUESTED. Do not apply until the Task3b integration run in this same Antigravity conversation finishes. Scope experience/** only, no commit/stage/push/deploy/delegation/Astra.

1. ResultShare summarizes tied teams as a solo winner when winnerId is populated. Independent reviewer reproduced real MatchEngine.concludeMatch + toView: team averages500/500, winningTeamId=null, individual winner present => summaryOutcome=solo_winner/headline أحمد. Teams-mode outcome must use team result and preserve team ties, ignoring individual winner when teams apply. Add a meaningful regression using real engine projection or realistic fixture consistent with it.
2. Relay illustrative copy contradicts canonical reducer: claims only active player sees question (view exposes current question to whole team) and first team reaching4 wins200 (both independently get rung-based score; four-for-four gives200 to both). Correct preview/example text against packages/rounds/src/relay implementation. Ladder example says no explicit lock loses everything despite auto-bank on fifth correct; correct to explain auto-bank at top rung.

Read actual canonical reducers and compare all18 examples for factual accuracy. Existing focused12 tests passed but missed these. Run npx vitest run apps/web/src/experience/experience.test.ts after focused regression additions. Independent Codex review required before approval. Report actual paths/results.
