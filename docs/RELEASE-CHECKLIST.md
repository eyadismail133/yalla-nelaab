# Release checks and rollback

Keep Firebase Spark, Anonymous Auth and browser-host authority. No billing, Functions, card or paid service is needed. GitHub workflows use standard hosted runners; confirm repository Actions allowance before enabling runs on a private repository. Nothing here deploys automatically.

## Before publication

1. Start from a clean reviewed commit. Record `git rev-parse HEAD`, Node version, test output and build manifest. Install dependencies with `npm ci`; Node >=24.12 and Java 21 are required. The standalone Firebase CLI is installed separately (`npm install --global firebase-tools@15.30.0`); it is never bundled into the game.
2. Run `npm run typecheck`, `npm test`, `npm run test:emulator`, `npm run test:browser`, `npm run build:web`, `npm audit` and the performance checks documented in the level record. Browser tests rebuild for the **demo emulator**, so do not deploy their output.
3. Rebuild the actual release with `npm run build:firebase`, then run `npm run bundle:check`. Initial gzip JavaScript must be <=185,000 bytes, each JS chunk <=500,000 bytes. Verify there are no emulator endpoints or test modules in the production build.
4. Review the actual diff and resolve blocking findings. Verify legacy rooms, private projection version/lease matching and host transfer through the emulator suite. Physical Android/iPhone beta acceptance stays separate.
5. Only with publication authorization, deploy database rules first if changed: `firebase deploy --only database --project yalla-nelaab-20261016`. Then deploy the verified production output: `firebase deploy --only hosting --project yalla-nelaab-20261016`. Do not use a combined deployment to infer ordering.
6. Run `node scripts/site-identity.mjs https://yalla-nelaab-20261016.web.app --match-local`; compare its script SHA-256 against the built entry, and record the commit, timestamp, manifest and output. An entry hash identifies a deployment; it alone does not verify every lazy asset.
7. Explicitly invoke **Explicit live smoke** in Actions, or set `SMOKE_BASE_URL=https://yalla-nelaab-20261016.web.app` and run `npm run test:smoke`. This creates a temporary two-seat room, acknowledges readiness, hands off the host and leaves both seats. It sends no chat/email messages. No tokens, storage state, network traces or screenshots are uploaded. Failed runs may leave a room until normal six-hour expiry; clean it up through the UI when possible.

## CI scope

For an explicit local action-traffic measurement, run `npm run perf:traffic`. It starts only local demo-project emulators, counts RTDB WebSocket application bytes through port 9001, and outputs numeric samples without packet contents. Ports 9000/9001/9099 must be free. This is a diagnostic baseline, not a production ping or billing estimate. It is separate from the regular release test suite.

`Release checks` validates PRs, supported release-branch pushes and explicit manual runs. Both jobs must pass. Repository branch-protection required checks must be enabled by a repository administrator; committing a workflow alone does not turn that setting on. Emulator tests use a demo project and require no Firebase credentials. The manual smoke workflow is the only workflow that accesses the live game, and never runs on a PR/push automatically.

Browser coverage runs the minified Vite build on Chromium against real local Auth/RTDB security rules. Network interruption is controlled with the browser context. Emulator tests cover duplicate/dropped acknowledgement replay and predecessor/successor fencing. The stale-tab scenario removes a lazy screen response, then reloads the stored seat; it does not claim two different full release versions were concurrently tested.

## Rollback

1. Record the failed deployment identity and stop publication. Keep the last known working commit and its lockfile available.
2. In Firebase Hosting release history, roll back to the known working Hosting release, or build that exact commit in an isolated checkout with `npm ci` and `npm run build:firebase`, check its bundle, and deploy Hosting only.
3. Do not blindly roll database rules backward: active upgraded rooms may require split public/private projections. Check client/rules compatibility first. Keep the prior compatible rules file available and deploy it separately only when safe for active rooms.
4. Re-run deployed identity and two-player smoke; record results. Ask players with an older tab to reload. Stored recovery seats remain available within their 15-minute window.
