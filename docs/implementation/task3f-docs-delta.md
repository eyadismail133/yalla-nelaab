# Documentation review delta

Continue exact conversation4679fd2d-bcac-4360-912f-b97de91f2508 with gemini-3.8-flash-high. Scope README.md ONLY. No commit/stage/push/deploy/delegation/review/payment/globalchanges. Preserve other ongoing work. Independent verdict CHANGES_REQUESTED:

- README98 incorrectly says security rules grant60s recovery and automatically mutate status:closed. Describe intended client recovery/wait/end behavior pending transport verification. Security rules constrain access; they cannot schedule mutations. No migration. 15s waiting/60s end remain intended requirements, not verified release claims.
- README108 claims browsercleanup implemented, while .env.example accurately says partial/underdevelopment. Qualify consistently until verified. Manual cleanup safety already independentlyapproved; preserve.
- README113/114 machine-specific file:///D:/ links must be repository-relative docs/WEBSITE-BRIEF.md and docs/BETA-PLAYTEST.md, portable onGitHub/clones.
- README69 actual configfile apps/web/.env.firebase, not root.env.firebase.
- README198 regressed existing documented content-test guarantee: restore exception allowing3passes for topic 'مين فينا', othereligibletopics4passes; inspect original HEADREADME and actual contenttest before wording. Don'tpromiseallgamesforeverytopic ifeligibilityfiltersapply.

Inspect scoped diff, run git diff --check -- README.md, report. No other code/testchanges needed for this prosefix. Codex independentreview afterward.
