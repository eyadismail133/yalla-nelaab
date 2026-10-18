# Release reliability and performance implementation plan

Approved scope: upgrade_plan.md Levels 2 then 3, as selected on 18 October 2026. Implement directly in this chat. Physical phone acceptance (Level 1) stays open.

Constraints: Firebase Spark, browser host authority, no billing/card. Publication was initially excluded and subsequently authorized by the user on 18 October 2026. Keep gameplay, legacy projections, privacy, sequence fencing and host takeover behavior. Do not infer gameplay ping from REST RTT.

## Level 2: repeatable release

- [x] Pin the standalone Firebase CLI in CI and add lockfile-pinned Playwright development tooling, production emulator build configuration and a Chromium browser suite. Keep test tooling out of shipped assets.
- [x] Exercise create/join, repeated refresh/cached clock, closed-tab recovery and subsequent commands, repeated network interruptions and host handoff through real production UI. Exercise cards/private projections, readiness and spectator/rematch through browser and existing real-rules emulator coverage.
- [x] Add pull-request/push CI for unit tests, types, Firebase build, bundle limits, dependency audit, and Java 21 Auth/RTDB emulator/browser checks. No credentials or deployment permissions.
- [x] Add an explicit manual smoke workflow for the existing deployed site with test-room cleanup and artifact identity. Keep traces/storage/tokens out of uploaded artifacts. Record rollback and rules-first instructions.
- [x] Independently run gates and review evidence before marking this level complete; document any uncovered old-tab/version scenario explicitly.

## Level 3: measured performance

- [x] Capture repeatable before/after initial gzip, module composition and Chromium cold/warm startup under fixed network/CPU conditions; record environment and limitations.
- [x] Remove Socket.IO from Firebase output without delaying gameplay transport construction. Separate shared session persistence from the Socket.IO client; select transport at build time while retaining the explicit transport test factory.
- [x] Profile eager round reducers/catalog and defer only demonstrated unnecessary startup code. Keep host/reconnect paths warm; do not introduce production diagnostic traffic.
- [x] Add a real, loopback-only Firebase SDK WebSocket traffic benchmark (180 measured operations, 18 types, supported 2/4/8-player rooms, cards/progress/spectators), plus a deterministic public/private projection byte benchmark for all 18 round types at 2/4/8 players. Keep matching-version privacy fences unchanged unless measurements and emulator tests justify changes.
- [ ] Complete physical-device input-feedback timing; guest-ack samples are recorded separately from database RTT. Run typecheck, unit tests, emulator tests, browser scenarios, Firebase and Socket.IO builds, bundle budgets and audit; review actual diff with a clear verdict.

Actual gates discovered: npm test; npm run typecheck; npm run build:firebase; npm run build:web; npm run bundle:check; npm audit; npm run test:emulator. No lint script exists. Baseline: 199,217 initial gzip bytes; 697 tests (679 pass in restricted sandbox, 18 socket tests time out there and require localhost-capable execution).

Local execution record: [verification and APPROVED review](../verification/reliability-performance-2026-10-18.md). Both CI jobs passed on GitHub for application commit `5ee5475`; Hosting publication, exact asset checks and three live browser scenarios passed. See [publication evidence](../verification/published-reliability-2026-10-18.md). Required-check enforcement, real-phone acceptance and production-network comparisons remain pending. The eagerly imported round/catalog reducers were profiled and retained; further metadata/authority changes are deferred until mobile evidence justifies them.
