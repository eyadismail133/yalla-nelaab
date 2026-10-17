# Correct recovery test fixtures and finish proof

Resume backend conversation `3519b64f-17fa-45b0-96a7-effce862d12d` with Gemini 3.8 Flash High. Codex interrupted the prior run after its source writes stabilized while it waited on background verification. No finished-run approval was given. The four production corrections are present and independently reviewed; preserve them.

Scope ONLY `apps/web/src/net/firebase-transport.emulator.test.ts`. No production, rules, other tests, config or dependencies. Do not commit, stage, push, deploy, delegate, review, change permissions or use payment/billing. **Do not run terminal verification commands or launch background tasks.** Codex owns execution and will send actual results back. Read/write files, then report FILES_READY_FOR_CODEX with commands explicitly unexecuted.

## Actual independent evidence

`npm test`:621 passed; typecheck passed. `npm run test:emulator` at22:00 Cairo:28 passed,3 failed, exit1. Full diagnostics: `C:/Users/dell/AppData/Local/Temp/yalla-nelaab-launch/codex-recovery-gate.log`.

- Dedup/replay test fails PERMISSION_DENIED because normal host SDK deletes response nodes. Approved rules require response newData.exists.
- Predecessor-wait test fails at720, resumeRes.ok false: disposing the predecessor's whole transport deletes the named SDK app shared with its successor.
- Paused-work test fails at873: it reads a deleted database after disposing the transport.

## Corrections

1. For forced fresh-replay evidence at552/595/733, remove the prior response through an explicitly adversarial `testEnv.withSecurityRulesDisabled` fixture, or replace it with a permitted distinct failure ACK. Do not weaken rules or use admin bypass for actual admission/commands/replay publication. Assert a fresh response and unchanged effects; preserve older-valid-ID and replay-after-restoration coverage.
2. Keep the SDK alive while testing runtime fencing. Dispose only the predecessor/target `getHostRuntime()` when the subject is execution loss; don't delete its app underneath a successor. Use a live authorized observer (a separate rules-test authenticated context matching the host UID is fine for read-only observation) for post-disposal assertions. Never recreate a session through an already-disposed transport. Keep the real production SDK for successful bootstrap, requests and effects.
3. At729 use RoomPlayer.nickname, not nonexistent name. The test must really find the guest and assert its committed ready effect and dedup record survived the wait. Send raw guest commands using the guest-authorized database, not a disposed host database.
4. The action test still sends an MCQ action to a random mixed round and treats version growth as proof. Configure an actual supported focused round and inspect the accepted answer/state effect. Preserve the engine's intentional silent-ignore contract for stale actions.
5. Add the two missing concrete regressions: paused content across actual SDK disconnect/reconnect, and denied publication rollback with no committed host view. For disconnect, keep SDK/observer alive, pause a real ContentSource boundary, goOffline/goOnline, release it, and prove the stopped runtime cannot commit or leak memory into a successor. For denial, a useful adversarial fixture is expiring an already-queued guest command while the runtime is paused before atomic publication; rules must deny ok:true publication, memory/committed snapshot must retain the prior effect/dedup, and a fresh valid command must still work. Use a guest command to avoid conflating the known host optimistic-ACK issue (next lifecycle scope). Do not claim committed host ACK correctness here; verify the committed host VIEW channel. No mock engine, fake multiplayer, swallowed test failures, early returns or toBeDefined assertions.

Keep tests compact, with bounded waits, explicit failure messages, complete cleanup and the exact demo namespace. The independent gates Codex will run are typecheck and the full emulator suite; do not print invented PASS output. Report any production defect discovered rather than editing outside this scope.
