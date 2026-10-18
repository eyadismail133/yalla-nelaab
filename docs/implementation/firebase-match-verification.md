# Firebase complete-match acceptance evidence

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

Codex scoped verdict: **APPROVED** for the acceptance test file after independent static review and execution, 16 October 2026, 21:36 Cairo. No Astra used.

Independent command:

`firebase emulators:exec --only auth,database --project demo-yalla-nelaab "npx vitest run --config vitest.emulator.config.ts apps/web/src/net/firebase-matches.emulator.test.ts"`

Result: **5 passed**, exit0, 9.53s total. Real Firebase SDK, Anonymous Auth emulator, Realtime Database emulator and the repository's security rules use the same demo namespace. No live project requests or happy-path admin bypass.

Verified full five-round focused MCQ matches with 2, 4 and 8 players; four-player teams; podium and weighted final-round scoring; same-code rematch preserving every observer's seat/roster; readiness; stale actions without answer/score changes; repeat-answer immutability and exactly one score contribution; private guest views/snapshot denial and trusted host access. Host derives test answers from its own authorized snapshot.

The suite reports repeated permission-denied attempts from stale queued replay acknowledgements after sender cleanup, plus teardown transaction disconnect warnings. These did not fail the assertions, but production queue/response cleanup still needs correction in the transport lifecycle work; do not hide them by weakening rules.

This proves the tested emulator happy paths at the Task2b2 source checkpoint. It does not approve outstanding host recovery races, offline deadlines, committed host ACKs, creation intent, hook lifecycle, physical-device behavior or deployment. Re-run after subsequent production changes. The test file remains uncommitted with its pending production dependencies; only the independent pure snapshot tests have been landed.
