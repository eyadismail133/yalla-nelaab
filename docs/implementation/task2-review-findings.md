# Task 2 early independent review findings

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

These were established while implementation was running; re-check against the latest files before fixing. Reviewer used gpt-6.1-sol (never Astra). All emulator probes used an alternate local port 19100 and no live services. No overall verdict yet.

1. P1: database.rules.json cannot compile. Real DB emulator error: `16:7: Cannot have multiple default rules ('$code' and '$other').` Keep one wildcard under codes.
2. P1: `$other: {".validate": false}` in record schemas matches every field when named child fields are not explicitly declared. After removing only the duplicate wildcard in memory, an otherwise valid code write was PERMISSION_DENIED. Define allowed named children and retain deny catchall only for unknown fields.
3. P1: Initial atomic room creation fails if lease permission reads host metadata through `root` (pre-write data). Confirm actual creation sequence with real integration; choose validated bootstrap using prospective data or a safe staged creation before guests see the code. No root permission grants to fix this.
4. P1: Lease fencing must require owner identity AND unexpired bounded lease, including snapshot, views, metadata, responses/membership deletions, heartbeat and all other host effects. Current probes allowed expired-owner snapshot writes. A heartbeat.connected=false exception must not permit the old runtime to overwrite a live successor lease: an isolated probe allowed this takeover. Guard lease duration and successor ownership/epoch. Test stale in-flight effects and reconnect after timeout, including queued Firebase heartbeat writes, not just a fresh read in JS.
5. P2: Code/meta createdAtMs is client supplied without a server-time bound, allowing arbitrarily future expiry. Probe accepted code creation one year in the future, expiry +6h. On creation require server timestamp (or strictly bounded server-time skew) and expiry <= now+6h; preserve immutable creation/expiry afterward.
6. P2: .env.example describes old-room cleanup but commands remove entire /rooms and /codes trees, including active matches. Replace with targeted expired-room console instructions or a properly scoped expired-only cleanup process; do not recommend full reset as old-room cleanup.

Additional review checks for the completed transport:

- Timeouts: Firebase queues offline writes automatically. Include a fixed request expiry based on send-time (not a server timestamp resolved only on reconnect), so a command whose UI already timed out cannot execute later in the same long round. Expired writes/commands must be rejected without mutating the in-memory engine or subsequent published state. No automatic scoring retries.
- Host snapshot, views and responses must commit together, and the host must restore the pre-command state if publication fails. A timed-out join/creation must not leave duplicated hidden seats/rooms on retry.
- Lease recovery after >60s must not be resurrected by an offline-queued heartbeat. Separate new runtime IDs, enforce bounded lease renewal using rules, and stop old runtimes immediately on lease/connection loss.
- React StrictMode must not leave duplicate Firebase apps, connections, engine loops or a disposed transport reused on remount.
- The newly installed @firebase/rules-unit-testing 6.0.0 requires Node >=24.12.0; local runtime is v24.16.0, whereas root engines currently say >=20 and Docker uses22. Align the actual development/test requirements and documentation or use compatible dependency versions. Avoid false compatibility claims.
- New engine readiness test name mentions kick/rematch but its current assertions do not exercise those branches. Ensure test names/coverage are accurate; test actual fixed-host leave/reap as a mere mark-disconnected call already preserves host before grace in baseline behavior.

Run real rules tests with both successful normal room writes and rejected abusive writes. A suite containing only expected-denial cases is not sufficient. Then complete all Task2 integration/gates. Never edit/deploy live rules until independent review approves. No commits/staging/delegation/Astra/payment/billing.
