# Reliability and performance candidate — 18 October 2026

Local candidate on `codex/release-network-performance`. Implemented and reviewed directly by Codex at the user's request. Nothing was pushed or deployed. The currently deployed release remains the Level 0 release recorded separately.

## Changes and review verdict

**APPROVED for this local candidate.** The actual production diff and new test/tooling files were reviewed against the selected Level 2 → Level 3 scope, Clean Code Guard and Test Guard. No blocking findings remain. Approval does not authorize publication or establish physical-phone acceptance.

- Firebase builds select their transport at build time. Session storage and public transport configuration are independent of the Socket.IO client; the explicit runtime factory remains available for existing tests/callers. Local Socket.IO builds still work.
- QR generation loads on demand. Initial gameplay transport construction remains synchronous, and selected-bank warming and lazy host runtime loading retain their existing behavior.
- Fixed a reproduced host-refresh failure: the 12-second predecessor lease outlasted the former 10-second restoration budget. Restoration now allows the configured lease plus the normal command budget; explicit caller deadlines still apply. Gameplay command timeouts and lease fencing are unchanged.
- Fixed a reproduced immediate-reconnect tap failure: non-resume commands await an in-flight resume, propagate its failure, and cancel if its operation generation or room/player identity changes. Resume commands bypass that wait to avoid self-deadlock. Concurrent ordinary commands keep the existing busy guard.
- Added production browser scenarios, local emulator build configuration, CI gates and an explicit live smoke workflow. Security rules, scoring, projection protocol, server region, billing and host authority were not changed.

## Fresh verification

Environment: Windows, Node 24.16.0, npm 11.13.0, Java 21, Firebase CLI 15.30.0, Playwright 1.64.1, Chromium 156.0.8078.4.

| Gate | Result |
| --- | --- |
| `npm run typecheck` including new browser/tooling sources | Pass |
| `npm test -- --reporter=dot` | 697/697, 33 files |
| Full Auth/RTDB emulator suite after production changes | 82/82, 6 files |
| Production browser suite against real demo-project rules | 6/6 |
| `npm run build:web` | Pass, Socket.IO mode |
| `npm run build:firebase` | Pass; this is the final local `dist` |
| `npm run bundle:check` | Pass; initial limit tightened to 185,000 gzip bytes |
| `npm run bundle:firebase` | Pass; no Socket.IO client modules or test code in Firebase graph |
| `npm audit --json` | Zero known vulnerabilities in application/development dependency tree |
| `git diff --check`, new `.mjs` syntax checks | Pass |
| Projection benchmark | Every generated public/private pair merges back to its exact original redacted view |
| `npm run perf:traffic` equivalent emulator invocation | 180 accepted measured operations, 18 round types, 48 supported type/size cases; 6 invalid size cases reported |

The full emulator and browser commands were also run sequentially inside one emulator invocation: `npx vitest run --config vitest.emulator.config.ts --reporter=dot && npx playwright test`. The browser suite serves the minified emulator-mode Vite build, not the development server. Expected denied-write/disconnect warnings in negative emulator tests are not skipped failures. The standalone Firebase CLI is outside the application's npm dependency tree; this audit result does not claim that external CLI's dependencies are vulnerability-free.

The six browser scenarios cover:

1. Missing lazy-screen chunk after a release → reload into the existing host seat, without duplicate admission.
2. Five-round MCQ match, private VAR hints, captain activation, late spectator, all-active-player readiness, and spectator promotion on rematch.
3. Guest readiness acknowledgement through actual RTDB WebSocket frames delayed by 75 ms in each direction.
4. Repeated refresh/cached clock, closed-tab recovery, monotonic counters, repeated offline/online cycles, and a tap immediately after reconnection.
5. Create/join, readiness acknowledgement, explicit host departure and successor host controls, then both seats leave.
6. Three cold/warm startup pairs under the same network/CPU profile.

Duplicate/dropped acknowledgement replay, version/lease fences, predecessor/successor races, legacy projections, 2/4/8-player and team matches remain covered by the real-rules emulator suite. The stale-tab test simulates a missing chunk; it does not claim two distinct deployed versions were tested together.

## Bundle and startup measurements

| Measurement | Before | After |
| --- | ---: | ---: |
| Released Firebase initial gzip JS | 199,217 B | 175,625 B |
| Same-session emulator build initial gzip JS, including reconnect fixes | 199,385 B | 175,716 B |
| Largest release JS chunk, raw | 294,708 B | 225,625 B |
| Median cold startup to enabled create button | 3,456 ms | 3,152 ms |
| Median cold first contentful paint | 2,388 ms | 2,144 ms |
| Median warm startup to enabled create button | 1,634 ms | 1,634 ms |

The release starts with **11.8% less gzip JavaScript**. The module-graph regression check failed before the change with 26 Socket.IO modules, and passes after their removal. QR code contributes a separate ~10.1 KB gzip chunk that is loaded for invitations. All JS chunks remain below 500,000 raw bytes.

Startup conditions: same desktop Chromium version, 390×844 viewport, 150 ms HTTP latency, 1.6 Mbps download, 750 Kbps upload, 4× CPU slowdown, three fresh contexts, cold followed by same-context warm navigation. Resource byte totals include modulepreload. These are browser-emulation observations with a small sample, not physical-phone or production-network guarantees. Raw samples: [before](startup-before.json), [after](startup-after.json); bundle reports: [before](bundle-before.json), [after](bundle-after.json).

[Initial module profile](module-profile.txt) confirms that catalog imports still bring in the reducers (102,820 bytes of rendered module code before final minification). That figure is not gzip size. Firebase SDKs and vendors remain substantial. The candidate removes the demonstrated unnecessary Socket.IO and eager QR costs; further catalog metadata or SDK initialization restructuring is deferred until mobile measurements justify its compatibility risk. No animation/font/scoring changes were used to manufacture the loading result.

## Acknowledgement and projection observations

The delayed-frame readiness samples were **270/289/371 ms before** and **323/267/365 ms after**. Their ranges overlap, and three samples are insufficient to establish a latency improvement or a small regression. No reduced-production-ping claim is made. This metric includes browser/Playwright scheduling and command acknowledgement; the in-game REST RTT badge is a different measurement. Raw samples: [before](action-latency-before.json), [after](action-latency-after.json).

`npm run perf:projections` measures UTF-8 serialized public/private projection update payloads through the real reducer/view/split/merge code for all 18 types at requested sizes 2/4/8. Unsupported room sizes are explicitly identified rather than simulated as valid. Samples include initial views, first reducer action, captain, MCQ/numeric VAR and spectator views where capacity permits. It uses deterministic synthetic content and preserves private fields and matching-version/lease reconstruction. [Raw results](projection-bytes.json).

The synthetic benchmark excludes canonical snapshots, ACKs, commands, protocol overhead and live network billing. It demonstrates existing split-projection savings; no new bandwidth savings are claimed. Publication suppression/version rules were deliberately preserved.

The separate **actual SDK traffic benchmark**, `npm run perf:traffic`, runs through the local Auth/RTDB emulators with authored questions and real rules. A proxy bound only to `127.0.0.1:9001` counts both directions of RTDB WebSocket payloads across every room client. All **180 operations** were accepted and observed bidirectional frames: start, captain, first progress action, MCQ/numeric VAR and late spectator admission where capacity permits. All 18 round types are covered at supported 2/4/8-player sizes; six unsupported size combinations are reported. [Actual application traffic samples](emulator-traffic.json).

These counts include snapshots, commands, projections, acknowledgements, cleanup and incidental heartbeats inside the operation plus a fixed 100 ms settling window. HTTP/Auth requests, WebSocket/TCP/TLS headers and compression are excluded. They are an actual emulator traffic baseline, not Firebase billed bytes, production network measurements or proof of a before/after bandwidth improvement. Packet contents and credentials are never written to the report. The counting CLI checks for traffic bypass and bounds operations through the existing transport deadlines; it flushes output and closes its proxy before exiting because Firebase's Node SDK retains housekeeping timers.

## Remaining acceptance

- Level 2 code and local checks are implemented. GitHub workflow execution, repository required-check settings, publication and exact-live-artifact smoke have not occurred. The explicit smoke first builds this checkout and compares deployed HTML/entry SHA-256 against it before creating a test room. See [release checklist](../RELEASE-CHECKLIST.md).
- Level 3's bundle/startup work and all-type emulator traffic baseline are verified locally. Actual Android/iPhone cold/warm/action timing and production-network/billing comparisons remain open; Level 3 is not declared fully accepted.
- Level 1 remains open: desktop Chromium and viewport dimensions do not prove Android/iOS backgrounding, wake lock, screen lock, sharing or cross-network reliability.
- The Firebase Spark/no-card architecture is preserved. No hosting provider, paid feature, billing setting, region or payment method was added or enabled.
