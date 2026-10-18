# Published reliability release — 18 October 2026

Application commit: `5ee5475b1585b991a032369020f3dcc0b120a005`, pushed to `codex/release-network-performance`. The user explicitly authorized commit, push and live verification after approving direct implementation. No merge into `launch/free-online` was performed.

## Release evidence

- [GitHub Release checks run 39134491547](https://github.com/eyadismail133/yalla-nelaab/actions/runs/39134491547): **success**, both `quality` and `emulator-browser` jobs. Local verification also passed: 697 unit/integration tests, 82 real-rules emulator tests, six production-build browser scenarios, types, both transport builds, bundle/module gates and zero known npm vulnerabilities. [Detailed implementation review and measurements](reliability-performance-2026-10-18.md).
- Fresh production build after the application commit: `npm run build:firebase`, then `npm run bundle:check`. Initial JavaScript: **175,625 gzip bytes**, down from 199,217 (11.8%). Initial budget: 185,000 bytes; every JS chunk: at most 500,000 raw bytes.
- `firebase deploy --only hosting --project yalla-nelaab-20261016 --non-interactive`: **success**, 29 files deployed. No database rules changed or deployed. No billing, payment method, service, hosting provider, database region or authority migration was introduced.
- Live site: [Yalla Nelaab](https://yalla-nelaab-20261016.web.app/). [HTML and entry identity](live-reliability-identity-2026-10-18.json), checked at 14:13 UTC, matches the local production build. [All 27 manifest assets plus HTML (28 files total)](live-reliability-assets-2026-10-18.json) returned matching SHA-256 content. The local Vite manifest itself is build metadata, outside this runtime-asset comparison.
- [Pre-deployment identity](pre-deploy-reliability-2026-10-18.json) preserves the former HTML/entry hashes for release-history comparison. See [rollback procedure](../RELEASE-CHECKLIST.md#rollback).

## Live browser results

Executed on desktop Chromium against the deployed production Firebase service, with test traces, storage exports, screenshots and video disabled. Tests left their rooms through the UI.

1. `SMOKE_BASE_URL=https://yalla-nelaab-20261016.web.app npm run test:smoke`: **1 passed**, 15.3 seconds overall. Create room, join guest, acknowledge ready, host leaves, guest becomes host, guest leaves.
2. Production `deployment.spec.ts`: **passed**, 17.4 seconds. Abort lazy lobby chunk, show recovery boundary, reload into the same host seat, confirm one-seat roster, leave.
3. Production `recovery.spec.ts`: **passed**, 18.0 seconds. Two guest refreshes, closed-tab seat restoration, preserved identity and increasing command counters, two offline/online cycles with immediate readiness taps, leave both seats.

The latter two used the existing Playwright configuration with a temporary test selection for only these safe production scenarios, a 120-second test limit and the production URL. Both passed in 37.8 seconds overall; the temporary config was removed. The gameplay spec requiring emulator-admin access was not run against production. An initial runner attempt placed the temporary config inside Playwright's cleaned output directory; moving it outside that directory resolved the harness error before these two tests ran.

These tests establish production lobby/recovery behavior. They do not establish a full live match across every round, concurrent old/new full releases, physical mobile lifecycle behavior, or improved production ping. Small local acknowledgement samples remain inconclusive.

## Next steps

1. Run [physical Android Chrome and iPhone Safari beta acceptance](../BETA-PLAYTEST.md): Wi-Fi/mobile data, backgrounding/locking, host recovery, Arabic input, QR/sharing, 2/4/8 players and teams. Record devices, browser versions and first failures.
2. Measure production cold/warm load and gameplay acknowledgement on fixed devices/networks, separately from the database REST RTT badge. Compare with the recorded local startup and 180-operation emulator traffic baselines before selecting further optimizations.
3. Review integration into `launch/free-online` and configure required checks if supported by the repository's existing plan. GitHub branch metadata reported `protected: false`; workflow success alone does not enforce a merge gate. No paid upgrade or branch-setting change was made.
4. Continue Level 4 content attribution/review after reliability and performance acceptance. Optional new modes/cards and hosted authority remain deferred.
