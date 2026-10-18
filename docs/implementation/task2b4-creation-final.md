# Durable creation and safe room replacement

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

This readable brief supersedes task2b4-creation-intent.md while retaining its acceptance requirements. Queued for backend conversation3519b64f-17fa-45b0-96a7-effce862d12d, Flash3.8High. Dispatch only after current core work finishes and Codex adds current gate/review evidence. Preserve all lifecycle fixes, UI, scoring,18reducers and content. No commit/stage/push/deploy/delegation/review/Astra, global permission changes, billing or payment. No terminal gates/background tasks; Codex verifies.

Two phases: prepare focused actual-SDK tests only and report TESTS_READY_FOR_CODEX; Codex runs intended red cases; implement on the next delta and report FILES_READY_FOR_CODEX. Never claim unexecuted checks pass.

## Behavior

1. Await durable owner-scoped roomId/code intent BEFORE any room write or public code exposure. Existing private hosts/$uid/activeRoom accepts roomId/code/updatedAtMs and can be written before metadata. Additional local bootstrap metadata may be scoped to the final tab seat and anonymous UID. Never replace an unresolved prior intent.
2. On refresh/retry, finish the SAME interrupted creation or safely close/abort it before another. Cover metadata-only, lease-only, host reservation, committed snapshot before code, and public code before final saved session. Preserve unique execution owners and live lease fencing. A missing initial lease must match metadata's original owner; never execute as an unowned successor. Retain intent on timeout/network/permission failure.
3. Previous-room closure must succeed, or be confirmed already closed/expired/absent, BEFORE replacing the private pointer. Failure returns useful wait/retry feedback and keeps the old pointer; no silent catch then deletion. Host cleanup cannot depend on a host player token still present after leaving the roster. Late old cleanup cannot erase a newer index/session/subscriptions.
4. Never overwrite an active public code. Handle collisions between check/publication by closing the unexposed bootstrap, persisting a new intent and retrying a fresh code. Five occupied candidates return honest failure, never the final known-occupied code. Preserve the other creator's room/lease/players. No code enumeration or whole-database transactions.
5. Client-assisted cleanup targets only explicit known closed/expired rooms. Delete a code only if its CURRENT roomId still matches the target and it still qualifies; use an ID-conditional transaction to preserve reassigned active mappings. No root deletion, paid Functions, scheduled backend or billing TTL.

## Narrow metadata read clarification

Independent non-Astra architecture review approved this specific meta.read change for this task, subject to emulator tests. Keep other read/schema rules unchanged; the paired intent write fences below are also approved and required. No fields added. Current missing/expired metadata both produce PERMISSION_DENIED, which cannot safely establish absence.

Authenticated metadata read is allowed for an existing room owned by this UID, OR unexpired metadata (current behavior), OR ABSENT metadata whose roomId matches this UID's own private activeRoom pointer:

```
auth != null && (
  (data.exists() && data.child('hostUid').val() === auth.uid)
  || data.child('expiresAtMs').val() > now
  || (!data.exists() && root.child('hosts').child(auth.uid)
    .child('activeRoom/roomId').val() === $roomId)
)
```

The absent-data restriction is essential: a client-controlled pointer cannot establish ownership of an existing foreign room. This permits only metadata reads, not parent/private siblings. Gameplay still expires after six hours. Only a SUCCESSFUL authorized existsfalse proves absence; retain intent on actual permission/network/timeout errors.

Tests-first rule cases: unauthenticated denied; own pointer+missing meta returns existsfalse; missing meta with no/different pointer denied; another UID's pointer gives no access; own expired meta allowed with/without pointer; foreign expired meta denied even with forged pointer; foreign unexpired meta preserves existing access; removing/replacing pointer revokes missing-meta read on a fresh authorized-server read. Also prove the new grants still deny root/room-parent/snapshot/lease/members/views and preserve all writes/schema/lease boundaries.

## Paired server-side intent fences (approved architecture)

Initial room metadata creation must require the authenticated creator's private activeRoom pointer to match BOTH this roomId and new metadata code. Preserve existing metadata update authorization. An initial guard alone is insufficient: late metadata can commit while pointer A still matches, just before a stale missing-room check tries replacing it with B.

Guard pointer replacement AND deletion at the actual granting .write level: never abandon an existing pointer referencing an OWNED, OPEN, UNEXPIRED room. Permit unchanged room/code, or replacement/removal after its owned room is absent/closed/expired. Current unconditional hosts/$uid parent .write would bypass a child restriction; move or restrict the granting rule accordingly. A .validate alone cannot protect deletion. Use generation-checked CAS for pointer creation/replacement/cleanup: no unconditional late old set that could replace a newer missing intent.

Prevent atomic multipath bypass: with pre-state pointer A and missing meta A, an update that both creates meta A and changes pointer to B must be DENIED. Both guards using pre-write root would accidentally allow this. Pointer transition must inspect resulting old-room metadata through newData ancestors (or explicitly prevent this combined transition). Test emulator semantics, do not assume them.

Tests-first actual SDK races: (1) read A missing, commit pointer B, release late meta A => A denied/B intact; (2) read A missing, late meta A commits first, replacing with B denied until reconcile/close A; (3) close A then replace/create B allowed; (4) newer B intent then stale A claim/cleanup => CAS aborts/B intact; (5) atomic meta A creation + pointer B replacement denied. Positive matching initial intent; negatives missing/mismatched room/code/foreign UID/hostUid. Update existing successful bootstrap helpers AND negative timestamp fixtures to install valid intent first, with passing controls so timestamp denials still test timestamps rather than missing pointer preconditions. End-of-bootstrap same-identity index updates may remain allowed.

## Actual SDK acceptance

Use demo-yalla-nelaab only and real Auth/RTDB with the rules. Adversarial emulator fixtures may interrupt/seed conditions; normal success/recovery/cleanup must use authorized SDKs, never admin bypass. No mock engine, fake multiplayer, skips or assertion weakening.

- Interrupt after public code but before final saved session; retry reconciles/closes that creation before another, without public orphan.
- Interrupt early bootstrap, including metadata-only without lease; prove same-room completion or clean abort.
- Force check/publication collision; preserve other creator, clean old bootstrap and retry honestly.
- Deny previous-room closure; preserve its pointer and create no new room.
- Clean expired/closed room after code reassignment; preserve another active room's mapping.
- Time out/refresh at deferred creation boundary; late work cannot replace newer pointer/session.

Use a small separate creation emulator test file if clearer. Keep fault injection at actual content/database boundaries, no speculative testing flags. Codex runs focused tests/typecheck/full emulators and final ordinary tests/both builds. Existing manual cleanup docs already require matching room IDs. Physical-device and live release checks remain pending until actually performed.
