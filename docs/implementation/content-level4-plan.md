# Level 4 content and telemetry implementation

Scope selected on 18 October 2026: verify the previous local/live artifact, implement the content-quality level directly, test it, and publish to the existing Firebase project. Keep `main` as the sole branch, Spark/no-card operation, current scoring, 1–5 difficulty and playable authored IDs.

- Add private, snapshot-persisted per-question exposure/response clocks around authority reducers. Instrument quickfire, odd-one-out, bidding, land grab, ladder and relay; retain MCQ/numeric telemetry. Do not infer per-question outcomes from a multi-question round's final score.
- Exclude unseen sequential questions, non-bidders and cancelled contested cells; count relay turns as individual answering opportunities. Preserve snapshots and first accepted outcomes through retries/host transfer. Legacy in-progress rounds without clocks remain uninstrumented.
- Export only aggregate counts, mode and server timestamp after committed result publication. Suppress repeated result-phase transaction batches, while preserving immutable room/round deduplication and retry after failure. Extend rules compatibly before deploying the client.
- Provide an authenticated operator export workflow and offline source-linked report: mode cohorts, 50-exposure review threshold, 20-answer minimum for difficulty suggestions, 90-day reporting window with explicit undated legacy cohorts, 10 MiB export cap. No automatic rating changes, removals or public review dashboard.
- Verify the queued tournament claim and a bounded adjacent set against primary sources. Record two corrections, five verified decisions and an explicit needs-source queue; preserve every question ID, difficulty and corpus coverage.
- Run unit/content/attribution, typecheck, real-rules emulator, production-browser, both builds, bundle/module and dependency checks. Review code and test diffs before committing; deploy rules first, Hosting second, verify every live asset and a real room.

Paired comparisons, retry-based recall and social/cooperative scoring without a distinct question-response contract remain explicitly unsupported in per-question difficulty telemetry. Extending their measurement semantics is separate from fabricating a difficulty signal. No new modes/cards, paid service, provider, public repository or phone acceptance is included.
