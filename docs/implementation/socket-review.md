# Socket transport review

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

Codex verdict: **APPROVED** for the scoped Socket client timeout correction, 16 October 2026. No Astra used.

Initial independent reviewer reproduced a custom-timer defect: after10s failure, real Socket.IO retained room:create in sendBuffer plus its ack handler. Antigravity corrected request() to use the installed Socket.IO timeout(ms).emit API without automatic retries. Inspection of installed socket.js confirms timer removes both buffered packet and ack handler. Flat AckResult/error paths, payload/no-payload commands and default production constructor remain compatible. Optional real Socket injection supports the focused integration boundary without replacing transport behavior.

Independent focused run: npx vitest run apps/web/src/net/client.test.ts —3passed, exit0,20:58Cairo. Actual disconnected installed-client tests assert queued packet/ack eviction after deadline and success ack/no-payload paths. Root earlier full npm test elevated passed546tests including18real Socket integration tests (before these3new tests); rerun full gate after all implementation is stable. Sandbox run stalled on restricted local server binding and was interrupted; elevated run passed.

Prior scoped read-only review found no other blocking regression in shared protocol/readiness/server socket handlers. This approval does not approve Firebase transport, overall release or deployment.
