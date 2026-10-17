# Remove over-specific replay identity assertions

Resume `07a6c8b1-d842-48fb-a766-827a1fe82fe9` with Gemini 3.8 Flash. Edit only `apps/web/src/net/sequence.test.ts`. No production edits, emulators, commits, staging, push, deployment, delegation, review, permissions or payment changes.

Root independently ran all16 focused tests successfully. Independent review requests two removals: around lines241/260, `toBe(successAck)` and `toBe(failedAck)` require the same JS object, whereas the public contract permits a defensive copy with identical contents. Remove these object-identity assertions; the existing `toEqual({ action: 'replay', ack })` checks already verify the contract. Preserve all other regression coverage. Optional test parameterization is unnecessary for this bounded delta. Run the focused test and report the exact change; do not expand scope.
