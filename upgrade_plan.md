# Upgrade plan — future update levels

Updated 18 October 2026. This is the active roadmap. The October release is deployed at [Yalla Nelaab](https://yalla-nelaab-20261016.web.app/). Implementation and measured results are in [the phase record](docs/implementation/upgrade-progress.md) and [release verification](docs/verification/release-2026-10-18.md).

## Release baseline — Level 0 shipped

| Original phase | Released behavior | Scope/limit |
| --- | --- | --- |
| 1A | Optimistic MCQ/numeric/vote feedback, rejected-action rollback, obsolete-ack fencing, question-bank warming, view publishing optimization | No promised percentage latency reduction |
| 1B | Browser-host Firebase authority retained | Hosted authority deferred to preserve free/no-card operation |
| 2A | Wake lock, measured network badge, two-second Firebase answer replay, disconnect recovery grace | Badge measures database request time, not the full guest/host action path |
| 2B | Named per-seat 15-minute recovery and persistent Firebase identity | Command counters survive tab closure; active-seat recovery is rejected |
| 3A | Shared public state and per-UID private state, matching-version merge, legacy-room compatibility | Rules must deploy before the upgraded client |
| 3B | Targeted expired-room cleanup, immutable aggregate MCQ/numeric telemetry and review reports | Review flags only; questions remain playable; difficulty stays 1–5 |
| 4A | One VAR + one Double Captain per player/match, Derby preset, bounded visual reactions | Existing games/content only; Yellow Card, Hot Takes, career-path content and new reaction sounds deferred |
| 4B | All-connected-player result readiness, late spectators, spectator promotion on rematch | Eight total active seats including spectators |
| Release follow-up | Lazy screens/host runtime, cacheable vendor chunks, safe areas and 44px catalog targets | Initial JavaScript 199,217 gzip bytes; 26% lower than the previous 270,280-byte build |

Validation: 697 unit/integration tests, 81 full-suite emulator tests plus one cached-clock regression, typecheck, production build, bundle budgets, zero known dependency vulnerabilities. Live browser testing covered admission, recovery, private VAR, numeric Arabic input, captain scoring, reactions and all-ready progression. Physical phone testing is still open.

## Rules for every future level

- Start one bounded level at a time and record its acceptance evidence before moving on.
- Preserve the free/no-card Firebase setup. Do not enable billing, Functions or a paid host without a new user decision.
- Keep existing gameplay working and test legacy-room/host-transfer behavior when changing synchronization.
- Run `npm run typecheck`, relevant tests, `npm run build:firebase`, `npm run bundle:check`, and `npm audit`. Run `npm run test:emulator` for rules/transport/engine persistence changes.
- Review the actual diff directly, resolve blocking findings, then push/deploy only within the user's authorized scope. Deploy rules before Hosting when both change; verify the exact live artifact and a real room afterward.
- Keep secrets and seat credentials out of screenshots, reports and telemetry. Do not remove questions automatically.
- Keep the manual beta checklist honest: responsive desktop checks are not proof of Android/iOS lifecycle behavior.

## Level 1 — Physical mobile acceptance (next)

Goal: establish actual Android Chrome and iPhone Safari reliability.

1. Run [BETA-PLAYTEST](docs/BETA-PLAYTEST.md) on real phones, including Wi-Fi/mobile-data combinations, portrait/landscape, notches, virtual keyboards, Arabic numerals and rapid taps.
2. Exercise app switching, screen locking, denied/unsupported wake lock, guest/host refresh, tab close/recovery inside 15 minutes, and recovery expiry.
3. Run 2-, 4- and 8-player matches, teams, spectators, rematch, QR entry and result sharing.
4. Record device/OS/browser versions, setup, expected/actual outcome, and first failed step; reproduce and fix failures without recording private credentials.

Exit: physical Android and iPhone evidence exists for lifecycle, input, sharing and networking; no unresolved blocking joining/recovery defects. This level requires access to real devices and cannot be marked complete from viewport screenshots.

## Level 2 — Repeatable release and network coverage

Goal: catch deployment and recovery regressions before publication.

1. Add repository CI for unit/type/build/bundle/audit gates and a Java-enabled Auth/RTDB emulator job.
2. Add production-build browser scenarios for create/join, cached clock sync, closed-tab seat counters, host transfer, private projections, cards, result-ready and spectator rematch.
3. Include controlled latency, short disconnects, dropped acknowledgements, old tabs after a release, and repeated reconnects; keep time-based tests bounded.
4. Keep a release checklist with exact commit/build identity, rules-first deployment, smoke evidence, and rollback instructions.

Exit: failures block release, recovery cases reproduce automatically, and an explicitly invoked smoke workflow can verify a newly deployed test room.

## Level 3 — Measured performance and bandwidth

Goal: improve real mobile loading and action response without changing billing/authority.

1. Capture cold/warm startup and guest-to-host acknowledgement timing under defined networks/devices. Separate database REST RTT from gameplay acknowledgement latency.
2. Keep initial gzip JavaScript below 230,000 bytes and every JavaScript chunk below 500,000 bytes; current baseline is 199,217 gzip bytes.
3. Profile eager catalog/reducer loading, Socket.IO code in Firebase builds, round/result chunks, font loading and selected-bank warming before choosing more splits.
4. Measure public/private writes for all 18 round types at 2/4/8 players, including progress updates, cards and spectators. Optimize only with privacy/version fencing tests.

Exit: recorded before/after cold-load, input-response and bytes-per-action measurements improve under the same conditions; no invented sub-40ms, 80% bandwidth or latency promises.

## Level 4 — Content quality and telemetry coverage

Goal: make question review actionable while preserving authored content.

1. Add per-question attribution to multi-question reducers before including them in telemetry; current samples cover MCQ and numeric rounds only.
2. Define an authenticated review workflow for skip/correct rates, solve time, minimum sample size, suggested difficulty and reviewer decisions.
3. Keep 1–5 difficulty; retain playable questions until reviewed. Protect telemetry deduplication across retries, rematches and host changes.
4. Review dated football/statistics claims against primary sources and record corrections in [CONTENT-REVIEW](docs/CONTENT-REVIEW.md). The observed `fb-mcq-153` tournament claim is queued for factual verification, not declared verified by a functional playtest.
5. Plan bounded aggregate retention/export within Spark constraints; preserve the exclusion of names, answers, tokens and player identifiers from samples.

Exit: supported reducers have attribution tests, reviewers can trace a flag to a question and source, and approved corrections preserve valid item IDs/schema and content coverage.

## Level 5 — Optional new gameplay/content

Goal: add the items explicitly deferred from this release after a separate content/design decision.

1. Specify and author football Hot Takes and career-path questions using real supported game IDs; do not treat a preset as a newly implemented mode.
2. Decide whether Yellow Card replaces a card or changes the two-card allocation; define its exact speed-bonus effect and private/public visibility before implementing it.
3. Consider opt-in reaction sounds with mute preferences and mobile autoplay/accessibility behavior.
4. Extend snapshots, views, rules, scoring tests, spectators and round explanations for each approved addition.

Exit: rules are unambiguous, content is reviewed, all cards reset/restore correctly, and existing formats/rematches remain compatible. These items are future work, not part of the deployed scope.

## Level 6 — Optional hosted authority decision

Goal: revisit server authority only if the user changes or explicitly reconfirms the hosting constraints.

1. Assess available no-card options, regional latency, connection limits, process sleep, operating cost and recovery semantics using current provider terms.
2. Compare existing Firebase browser-host operation with a regional Node/WebSocket or edge authority, including measured device/network results from Level 3.
3. Specify trusted scoring, room persistence, host-independent progress, authentication, rollout and rollback before migration.

Exit: the user approves a concrete provider/region/budget and migration plan. Until then, Phase 1B remains deferred and the deployed browser-host architecture remains the supported release.
