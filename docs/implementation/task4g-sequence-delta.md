# Remove over-specific replay identity assertions

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

Resume `07a6c8b1-d842-48fb-a766-827a1fe82fe9` with Gemini 3.8 Flash. Edit only `apps/web/src/net/sequence.test.ts`. No production edits, emulators, commits, staging, push, deployment, delegation, review, permissions or payment changes.

Root independently ran all16 focused tests successfully. Independent review requests two removals: around lines241/260, `toBe(successAck)` and `toBe(failedAck)` require the same JS object, whereas the public contract permits a defensive copy with identical contents. Remove these object-identity assertions; the existing `toEqual({ action: 'replay', ack })` checks already verify the contract. Preserve all other regression coverage. Optional test parameterization is unnecessary for this bounded delta. Run the focused test and report the exact change; do not expand scope.
