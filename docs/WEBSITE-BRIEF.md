# يلا نلعب — website brief and free beta launch

Updated 18 October 2026. See [current release verification](verification/release-2026-10-18.md), [launch status](implementation/STATUS.md), and [future update levels](../upgrade_plan.md).

## What the game offers

An Egyptian Arabic, RTL party game for 2–8 friends using their own phones. A creator shares a private room code/link, chooses the topics and match format, and starts the match. Players see their own game view, countdowns, round explanations, scores and a final podium; the same group can rematch.

The existing question bank contains 8,901 items across 14 topics: football, general knowledge, geography, history, science and technology, nature and animals, film and television, music, food, anime and games, Arabic language and proverbs, Islamic knowledge, unusual facts, and social “who among us” prompts.

The 18 games combine speed, estimation, writing, bluffing, voting, ordering, risk and teamwork:

| Style | Existing games |
| --- | --- |
| Quick answers | سباق الإجابات، صح ولا غلط، الدخيل، أعلى ولا أقل؟ |
| Guessing and recall | خمّن التاريخ، الكلمة الناقصة، مين أنا؟، إيموجي |
| Social and creative | الكذّابين، مين فينا؟، اسم حيوان جماد بلاد |
| Strategy and risk | رتّب صح، السرقة، المزايدة، قطع الأرض، السلّم |
| Cooperative teams | وصّفهالي، التتابع |

Mixed matches vary the games, focused matches repeat one type, and tournaments increase the challenge. Match length is a budget of round slots: longer games can consume two slots. Team scoring, the final-round multiplier and sudden-death resolution remain part of the existing rules. Some games require three players; cooperative games require teams and at least four players.

## Improvements in this launch

- Make the first minute clear: a compact how-to guide, game previews with real rules and illustrative examples, and explanations for unavailable choices.
- Reduce setup time with four editable presets: quick mixed, football night, team party and Derby using existing football-compatible games. Show the selected configuration to guests as well as the creator.
- Make invitations easy on phones: selectable code/link, clipboard fallback, native sharing, WhatsApp composition and a locally generated QR code.
- Build confidence during play: readiness indicators, connected-player counts, pending submission feedback, useful Arabic errors and input preservation after failures.
- Give each group a reason to return: a shareable local result image, an accurate team/tie outcome and an immediate rematch.

The release also adds one VAR and one Double Captain per player/match, visual reactions, result readiness, late spectators, mobile wake lock and 15-minute named-seat recovery. Double Captain doubles positive points in its selected upcoming round. Public matchmaking, Yellow Card and new football mode/content remain outside this release.

## Free online architecture

The preferred Socket.IO deployment was checked first. Render's actual deployment flow required an Add Card step, so the approved fallback is Firebase Spark: Hosting, Anonymous Authentication and Realtime Database. No billing account, payment details, paid trial, Functions or paid server is part of this release.

In the Firebase fallback, the current host's browser runs the engine. New rooms publish shared `publicView`, per-UID `privateViews`, and a host-only full snapshot; restored legacy rooms remain supported. A lost host produces waiting feedback and the oldest eligible connected member can acquire the expired lease and continue execution. The former host returns as a guest. Host recovery is bounded; it cannot revive a room after its recovery deadline. Rooms expire after six hours.

The release uses targeted on-create cleanup for an owner's expired prior room, plus anonymous aggregate MCQ/numeric question telemetry. Reports flag questions for review; they do not remove content. Difficulty remains 1–5. The ping badge times a real database REST request, not the full guest/host gameplay path.

This is a trusted-friends beta: a determined host can inspect downloaded answers or alter scoring. Spark's 100 simultaneous Realtime Database connections make small private groups the appropriate starting audience. Free quotas can stop service when exhausted; they are not a promise of unlimited capacity. [Firebase's current connection limits](https://firebase.google.com/docs/database/usage/limits).

## Rollout and growth plan

1. Finish transport implementation, pass independent code/security review and the automated engine, build, rules and multiplayer gates.
2. Deploy a beta link, then verify full matches and invitations on real Android Chrome and iPhone Safari across separate networks. Check 2-, 4- and 8-player groups, teams, rematches and interrupted connections.
3. Recruit five friend groups through personal invitations. Ask whether everyone joined easily, understood the games, trusted submission feedback and wanted another match. Record confusing screens and unfinished matches without collecting player-identifying analytics.
4. Fix the most frequent joining or rules-comprehension problem before promoting more widely. Let players share invitations and result cards themselves; do not automatically message contacts.
5. Expand gradually through football watch parties, family gatherings and existing friend groups. Review Firebase usage and purge only specific closed/expired room records. Stay on Spark and stop expansion before free limits become a recurring problem.

Publication is gated on working multiplayer and relevant checks. The existence of Hosting configuration or a successful static build alone does not establish that online matches work.
