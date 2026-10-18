# Private beta playtest

These are pending real-device checks, not completed results. Responsive browser checks do not establish Android/iOS background behavior. See [the release verification record](verification/release-2026-10-18.md) for completed checks. Start with five invited friend groups; record problems before expanding promotion.

Updated 18 October 2026. This is Level 1 of [the future upgrade plan](../upgrade_plan.md). Desktop-browser checks passed for 320×568, 390×844, 412×915 and a 390×420 keyboard-space approximation; leave the physical-device boxes below unchecked until tested on phones.

Record device model, OS/browser version, network, player count, room configuration, observed failure and reproduction steps. Include cards, private hints, Arabic-number input, all-ready results, late spectators and rematch in each group session. Keep room tokens and Firebase credentials out of reports.

## Joining and setup

- [ ] Android Chrome and iPhone Safari can open the same invitation on separate networks (for example Wi-Fi and mobile data).
- [ ] QR scanning opens the exact room; the room code is prefilled. A typed code, copied link and WhatsApp-composed invitation also work. Send invitations yourself only to the intended group.
- [ ] Two new tabs become different seats; refreshing a tab restores its existing seat without another player appearing.
- [ ] Duplicate nicknames, an invalid/expired code and a ninth player produce clear errors without losing the nickname draft.
- [ ] Every player sees the selected topics, format, teams and approximate match length.
- [ ] Readiness updates for everyone. The creator can start with two connected players even if not everyone marked ready.
- [ ] Focused choices explain three-player and four-player/team requirements. Each preset replaces the previous focused setup correctly.

## Playing and finishing

- [ ] Complete a match with 2 players, another with 4, and another with 8. Include a team match.
- [ ] Across the groups, try all 18 games. Check intro explanations, countdowns, accepted submissions, scoring and results against the displayed rules.
- [ ] Test Arabic typing, Arabic-Indic numbers, Enter/submit, and opening/closing the mobile keyboard. Controls remain reachable in portrait mode.
- [ ] Rapid taps do not submit twice. A failed/timed-out typed submission preserves the answer draft and releases the pending button.
- [ ] Refresh a guest during a round. It restores the right player, score and private view; an old answer never affects the next round.
- [ ] The creator's brief refresh/network interruption recovers using the same tab identity. Guests see waiting feedback when the host is unavailable. Keeping the host tab active is part of the beta instructions.
- [ ] A disconnected host transfers execution to the oldest eligible connected member after the lease grace period. The original host returns to the same seat as a guest; scores and private views survive.
- [ ] Close a mobile tab, reopen the site, and recover the named seat within 15 minutes. Trying to recover a seat still open in another tab is rejected.
- [ ] Screen wake lock is requested during play where supported; reject/unsupported cases remain playable. Background/foreground and Wi-Fi/mobile-data handoffs recover without duplicate submissions.
- [ ] Solo, team, tie and abandoned results tell a consistent story. A rematch works with the same group.
- [ ] Download the result PNG and inspect Arabic text, names, scores and cropping. Try native image sharing where supported. The card contains the website origin, not the private room code or token.

## Feedback to collect

For each group, record device/browser, player count, match configuration, whether the match finished, and the first point of confusion. Avoid recording reconnect tokens or private Firebase credentials. Ask:

1. How long did it take everyone to join?
2. Which game's explanation needed another person to explain it?
3. Was it always clear whether an answer was accepted?
4. Did anyone get stuck after leaving, refreshing or losing a connection?
5. Would the group play again, and which preset would they choose?

Fix repeated joining, comprehension and recovery problems before adding new games. Check Firebase's free-plan usage after the pilot and remove only specifically verified closed or expired records.
