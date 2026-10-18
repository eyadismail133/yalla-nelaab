# Launch status — 18 October 2026

## Current deployed release

- Live site: [Yalla Nelaab](https://yalla-nelaab-20261016.web.app/), Firebase project `yalla-nelaab-20261016`.
- Branch: `launch/free-online`. Application release commits: `44f9c63`, `ac7d830`, `61706a8`.
- Database rules were deployed before Hosting; authenticated rules readback and exact built HTML matched the deployed artifacts.
- Verified: 697 unit/integration tests, 81 full-suite Firebase emulator tests plus one targeted clock regression (82 total), typecheck, build, bundle budget and zero known dependency vulnerabilities.
- Initial JavaScript: 199,217 gzip bytes, about 26% below the prior build; largest chunk about 295 KB with no 500 KB build warning.
- Current features include public/private projections, automatic host transfer, recovery with persistent command counters, real request latency sampling, cards, Derby, reactions, readiness and spectators.
- Live browser checks and their physical-device limits are recorded in [release verification](../verification/release-2026-10-18.md). Real Android/iPhone lifecycle and cross-network group acceptance remain open.
- Future updates are ordered by levels in [upgrade_plan.md](../../upgrade_plan.md). Hosted authority, Yellow Card and new football mode/content remain deferred by user choice.

## Historical launch record — 17 October 2026

The following records the previous release's evidence and architecture. Its test counts and fixed-host descriptions are historical, superseded by the current release above.

## Final Launch Verification & Live Deployment — 17 October 2026 (Complete)

### Summary
- **All verification gates passed (100% green):**
  - `npm run typecheck`: **PASS** (0 errors across `packages/shared`, `packages/rounds`, `packages/engine`, `apps/server`, `apps/web`).
  - `npm test`: **PASS** — **21/21 test files, 667/667 tests passed** (engine, all 18 round reducers, snapshot round-trips across all 18 rounds, content validation across all 8,901 seeded Arabic questions in 14 categories, sequence/dedup, tab seats, session error classification, Socket.IO integration, and UI screen/experience tests).
  - `npm run test:emulator`: **PASS** — **5/5 emulator test suites, 76/76 tests passed** against real Firebase Auth (`127.0.0.1:9099`) and Realtime Database (`127.0.0.1:9000`) emulators on `demo-yalla-nelaab`:
    - `apps/web/src/net/firebase-rules.emulator.test.ts` (9/9 passed)
    - `apps/web/src/net/firebase-creation.emulator.test.ts` (19/19 passed)
    - `apps/web/src/net/firebase-creation-runtime.emulator.test.ts` (6/6 passed)
    - `apps/web/src/net/firebase-matches.emulator.test.ts` (5/5 full 2/4/8-player & team matches + rematch passed)
    - `apps/web/src/net/firebase-transport.emulator.test.ts` (37/37 transport, recovery, cancellation, expiry, and rollback tests passed)
  - `npm run build:web` & `npm run build:firebase`: **PASS** (clean production bundles in `apps/web/dist`).
  - `git diff --check`: **PASS** (no whitespace or conflict markers).
- **Live Firebase Spark Deployment (`yalla-nelaab-20261016`):**
  - **Strict Free-Tier (Spark) Compliance:** `billingEnabled: false`, zero payment methods or paid services used. Deployed **only** `hosting` and `database` (`npm run deploy:firebase`).
  - **Live URL:** `https://yalla-nelaab-20261016.web.app` (HTTP 200 verified with `Content-Security-Policy`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`, and `Cache-Control: no-cache, no-store, must-revalidate`).
  - **Live RTDB Rules:** Released to `yalla-nelaab-20261016-default-rtdb` (`europe-west1`). Unauthenticated read to `/rooms.json` verified rejected (`401 Unauthorized`).
  - **Live End-to-End Online Match Verification:** Verified live against `yalla-nelaab-20261016` with real anonymous authentication, room creation (`createRoom`), guest admission (`joinRoom`), player readiness (`setReady`), match start (`start`), round gameplay (`skip` + `act`), and clean room closure/code release (`leave`).

## Completed Work Breakdown
1. **Shared Engine & Round Reducers (`@game/shared`, `@game/rounds`, `@game/engine`):**
   - Browser-compatible `MatchEngine` and `MemoryStore` with fixed-host option (`transferHostOnLeave: false`), readiness clearing on config changes, server-clock view projection, and full JSON snapshot survival across all 18 round types.
2. **Firebase Security Rules (`database.rules.json`):**
   - Strict private `/rooms/$roomId/snapshot` (host-only) and `/rooms/$roomId/views/$uid` (per-UID redacted view).
   - Paired creator intent fences at `/hosts/$uid/activeRoom` and `/rooms/$roomId/meta` preventing unreferenced metadata creation or active-room pointer replacement while an owned room remains open and unexpired.
   - 32 immutable historical member slots (`memberSlots/1..32`) and 8 bounded join request slots (`joinRequests/1..8`), plus lease-fenced writes and command expiry validation.
3. **Firebase Host Runtime & Transport (`apps/web/src/net/`):**
   - Staged creator intent-before-metadata bootstrap with CAS transaction on `hosts/$uid/activeRoom`, prior-room reconciliation/closure, bounded lease waiting vs. active-host detection, 5-attempt code collision handling, and targeted `codes/$code` cleanup that preserves reassigned codes.
   - Full lifecycle ownership in `FirebaseTransport` and `FirebaseSessionManager`: 10s API-entry deadlines, immediate command cancellation on room transitions/leave/dispose, same-key resume coalescing and different-key supersession, 15s host-unresponsive banner, 60s host-disconnect closure, and 6-hour room expiry enforcement for both host and guest.
4. **Arabic RTL UI & Player Experience (`apps/web/src/`):**
   - Complete Arabic RTL screens (`HomeScreen`, `LobbyScreen`, `RoundScreen`, `ResultScreen`, `PodiumScreen`), 18 round components with submission guards, invitation panel with QR code & WhatsApp/copy links, sound/haptics experience layer, and downloadable victory card on the podium screen.
