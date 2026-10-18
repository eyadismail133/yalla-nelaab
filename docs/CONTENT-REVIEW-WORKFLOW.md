# Content review and telemetry operations

This is an operator workflow using an account already authorized for the Firebase project, not a public gameplay screen. No new paid service or payment method is required. Review suggestions never modify seed content, difficulty or playability automatically.

## Authenticated export and report

1. Use `firebase login` with the authorized project account. The operator's Firebase CLI credentials are managed outside this repository. Anonymous game credentials are not operator authorization. Existing game rules allow authenticated per-question aggregate reads; they do not grant a client a bulk `/telemetry` read or content-edit permission.
2. Create an ignored local export folder: `New-Item -ItemType Directory -Force test-results/content-review`. Export with the authenticated CLI: `firebase database:get /telemetry --project yalla-nelaab-20261016 --output test-results/content-review/telemetry.json`. For a large tree, export one `/telemetry/QUESTION_ID` at a time and wrap that object as `{ "QUESTION_ID": { ...samples } }` before reporting. The report requires the question-tree shape and rejects input above 10 MiB.
3. Run `Get-Content -Raw test-results/content-review/telemetry.json | npm run telemetry:report --silent`. Review output includes question ID, seed text/category/shape/current difficulty, source decisions and a cohort for each game mode. It omits room IDs and individual samples. Keep raw exports private and out of Git; never export room snapshots, names, tokens, answers, player identifiers or browser storage for this workflow.
4. At least 50 question exposures are needed for a skip flag (strictly above 80%). Difficulty suggestions need at least 50 exposures **and 20 answers**, use correctness among answers, and stay in 1–5. Separate cohorts prevent a risky ladder or bidding format from silently changing the interpretation of a normal MCQ. Timing is from logical exposure to accepted answer; it includes thinking and network time and is not a pure transport-latency measurement.
5. Match a flag to its authored item and authoritative source. Record a `verified`, `corrected` or `needs-source` decision in `content/review-decisions.json`, with date, source links and rationale. `needs-source` records are queued, not fact-checked. Preserve the existing item ID, supported shape, answer format, 1–5 difficulty and playable status. Apply factual corrections only with evidence and passing content tests; do not turn every statistical suggestion into a factual edit.
6. Run release checks and publish within the authorized task scope. The checked-in ledger is a maintainable audit trail; sources and diffs still require review. All 8,901 authored items remain playable, and the dated-football ledger is not a full-bank factual audit.

## Measurement coverage and interpretation

| Mode | Question opportunity and timing |
| --- | --- |
| MCQ race, numeric guess | Existing one-question participant outcome/round-start timing |
| Quickfire | Only each statement reached by a player; clock starts as it becomes current |
| Odd-one-out | All three puzzles visible from round start; accepted answers may arrive out of order |
| Bidding | Only bidders and reached questions; first clock begins when answering opens, excluding bidding time |
| Land grab | Only opened cells; an unanswered exposure cancelled by another claimant is discarded, not labelled skipped |
| Ladder | Each rung reached, including a wrong answer that busts the round; a visible rung banked without answering is a skip |
| Relay | One opportunity for the active answering player per team turn, not every teammate; timeouts stay unanswered |

Other modes remain excluded from these question samples. In particular, higher/lower tests a pair of facts and cannot assign its correctness to one source item; emoji/free-text retries and social/cooperative outcomes need a separate validated measurement contract. Unsupported modes still play normally. Existing in-progress snapshots without exposure clocks do not receive fabricated multi-question timings; new rounds acquire clocks normally. Spectators do not create question opportunities.

Internal actor/timing metadata stays in the already host-private canonical snapshot and is not emitted by round views/reveals or written to `/telemetry`. Result samples contain only the existing room/round linkage, counts, mode and server-resolved recording time. The immutable per-question `roomId_roundNo` key survives publication retries and host changes; round numbers continue across rematches. Runtime suppression prevents every result-readiness update from repeating the same transaction batch. Telemetry is asynchronous after accepted publication and does not delay gameplay acknowledgements. Browser-host statistics remain advisory and are not independently trusted anti-cheat evidence.

## Bounded retention and export plan

- Reports use the most recent **90 days** of dated samples. Older dated samples are counted as excluded, not silently deleted. Legacy samples lack a timestamp: they stay labelled undated in the legacy cohort and must not be assigned an invented date. Report filtering does not itself bound database storage.
- Review aggregate growth monthly with the authenticated operator account. Export in per-question batches capped at 10 MiB, summarize by question/mode/month without room linkage, and retain only the summary needed for review. Remove raw local exports when the review is complete.
- Before a database prune, identify exact per-question sample paths older than 90 days, confirm the export/summary and current room status, and review the proposed path list. Apply only that reviewed deletion set through authorized operator tooling. Never delete `/rooms`, `/codes` or the whole `/telemetry` tree as a retention shortcut. Undated legacy data needs a separate reviewed migration/export decision.
- No scheduled cleanup function, automatic deletion, broad Firebase permission or paid storage system is introduced. Pruning production records is not part of this release; the manual retention operation remains necessary as data grows.

## Publication compatibility

Deploy telemetry rule additions before Hosting. New optional `roundTypeId` and server `recordedAtMs` fields are validated; old samples and old clients without these fields remain compatible. Existing name/player/token fields remain rejected, samples remain immutable, and guests/stale hosts cannot write. Roll back Hosting separately if needed; compatible additive rules can remain while older clients finish their rooms.
