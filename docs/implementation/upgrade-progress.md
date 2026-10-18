# Upgrade execution — 2026-10-18

Work is performed directly by Codex, without delegation. The existing `upgrade_plan.md` supplies the requested scope.

## Baseline audit

- Local and remote HEAD: `8f078e74639710b800735c0680f27d61fa85015e`.
- Live Firebase Hosting HTML references the same JS/CSS assets as the baseline Firebase build.
- Authenticated read of deployed RTDB rules matches local `database.rules.json`.
- Baseline: 668 unit/integration tests, 77 Firebase emulator tests, typecheck, and Firebase build pass.
- Build warns about the approximately 1 MB entry chunk. No lint script is configured.

## Execution order and acceptance

1. Audit recent lifecycle changes. Reproduce suspected regressions before fixing them; retain security fencing and rollback behavior.
2. Phase 1A: optimistic selections/submission locks with rollback on failure; ignore obsolete acknowledgements after round changes; omit unchanged per-player projections only after successful publication; warm selected content during lobby/intro and retry failed chunk loads. Verify with React interaction tests, content tests, and real Firebase emulator tests.
3. Phase 1B: assess dedicated authority against the documented free Spark deployment requirement before selecting hosting. The current roadmap specifies alternatives, not an agreed provider/region/deployment configuration. Do not promise a measured latency reduction without measurements.
4. Phase 2A–2B: wake lock, measured command RTT (serverTimeOffset is clock skew, not RTT), scoped short replay, then per-seat recovery with matching persistent Firebase identity.
5. Phase 3A–3B: public/private projections with redaction and rules tests, followed by cleanup/telemetry compatible with hosting and privacy constraints.
6. Phase 4A–4B: define card allocation and effects, football preset, bounded reactions, connected-player result readiness, then spectator admission/rematch.

Production deployment, billing changes, and Git pushes are separate from local implementation. Record each phase's actual validation here; never mark an unimplemented phase complete.

## Implemented locally

- **1A:** immediate MCQ/numeric/vote selection feedback, rejected-action rollback, old-round acknowledgement fencing, selected-bank preloading, and suppression of unchanged legacy projections. New rooms use the Phase 3A split instead.
- **1B:** deferred by the user to preserve the free, no-card Firebase setup.
- **2A:** visible-match screen wake locks; measured Firebase request RTT or Socket.IO server RTT, explicitly labelled; the Firebase transport queues one offline answer for at most two seconds, revalidated against the server's current round/stage/question before replay. Two-player matches now retain temporarily disconnected seats during the existing 90-second recovery grace instead of ending immediately.
- **2B:** per-seat 15-minute local recovery entries, a home-screen recovery action, persistent anonymous Firebase identity per named seat app, and a BroadcastChannel check before recovering an already-open seat. Private/restricted storage falls back to normal session play.
- **3A:** new rooms publish shared state once at `publicView` and personal state at `privateViews/$uid`. Clients combine only matching state versions and lease owners. A strict prompt-field allowlist keeps personal choices private even when all players chose the same answer. Restored old rooms retain legacy `views/$uid` publishing. New Firebase rules must be deployed before using the upgraded Firebase client.
- **3B:** on creation, an owner opportunistically removes their previously owned room only if it has been expired for over an hour. Existing closed/expired-room deletion permissions are preserved. This is targeted cleanup, not a global scheduled sweeper. Immutable per-question/per-room/per-round aggregate telemetry is implemented for MCQ and numeric rounds. `telemetry:report` computes skip/correct rates, mean solve time, suggested difficulty on the existing 1–5 scale, and review flags after sufficient samples. Questions remain playable, as requested. Multi-question rounds require per-question reducer instrumentation before they can be included accurately.
- **4A:** each player has one VAR and one Double Captain per match. VAR hides two randomly chosen wrong MCQ options or gives a numeric interval; Double Captain doubles positive points for the intro's upcoming round. Cards survive host restoration and reset on rematch. Yellow Card is deferred by the user. Derby uses the four existing compatible mechanics (`mcq_race`, `numeric_guess`, `who_am_i`, `fibbing`). Emoji reactions are bounded and throttled by both UI and engine.
- **4B:** all connected, non-spectating participants can advance results by marking ready; disconnecting an unready player re-evaluates the ready condition. Late arrivals occupy one of the existing eight seats as spectators, see safe prompts and scores, cannot answer/use cards/mark ready, and become players on rematch.

## Roadmap adaptations and remaining limitations

- The roadmap's `closest_number`, `bluff_box`, and `hot_take` IDs do not exist in this project. Derby uses the existing compatible mechanics listed above. The user explicitly deferred a new football Hot Takes mode and authored career-path content to a follow-up.
- Reactions are visual; no new sound effects were added.
- The Firebase badge measures browser-to-database RTT, not the full guest-to-browser-host-to-guest action path. No sub-40ms or percentage latency guarantee is claimed.
- Public/private splitting reduces duplicated data in the eight-player projection test by more than 50%; private records are not guaranteed to stay below 200 bytes for every round type.
- Screen lock support and mobile tab restoration still need physical Android/iPhone playtesting. Browser API rejection does not block play.
- No CI workflow exists in the checked-out repository. GitHub access through the connector returned 404; authenticated Git transport verified remote HEAD instead.
- The initial review recorded a large entry bundle. The authorized release follow-up now splits screens/runtime/vendor chunks and reduces initial gzip JavaScript to 198,900 bytes, with no large-chunk warning; see [the release record](../verification/release-2026-10-18.md).

## Review and validation

Review is performed directly by Codex with clean-code-guard and test-guard; no delegated implementers or reviewers are used.

- `npm run typecheck`: passed.
- `npm test -- --reporter=dot`: 694 tests passed across 32 files.
- `npm run build:firebase`: passed with the documented chunk-size warning (934.37 KB entry, 270.28 KB gzip).
- `npm audit --json`: zero known vulnerabilities after dependency updates; no Firebase major-version downgrade.
- `git -c core.safecrlf=false diff --check`: passed.
- Final Firebase Auth/RTDB emulator run: 81 tests passed across 5 files in 81.80 seconds. See `docs/verification/upgrade-emulator.log`.

**Review verdict: APPROVED for the agreed local release scope.** Direct code review found no remaining blocking findings after correcting the obsolete action acknowledgement race, host-promotion command routing race, and premature two-player abandonment. Regression tests cover those fixes; the final gates above pass. Deferred roadmap work and physical-device/performance limitations remain as listed, and this verdict does not represent a production deployment.

Deployment sequencing: publish the new database rules before the upgraded Firebase client. Players should refresh existing browser tabs before creating or joining new split-projection rooms. Existing legacy rooms remain supported by the upgraded client. The initial implementation was local; the user subsequently authorized push/deployment, tracked in [the release record](../verification/release-2026-10-18.md).

Browser evidence: `docs/verification/upgrade-lobby.png`, `upgrade-round.png`, and `upgrade-result.png`. Two real local browser tabs verified Derby selection, private numeric VAR hints, Double Captain scoring, instant answer locking, emoji reactions, and all-ready progression. Emulator tests additionally verify the Firebase equivalents, spectator admission/promotion, private-state access controls, offline replay, and host migration.
