# Correct creation security test fixtures

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

Resume SAME4679fd2d-bcac-4360-912f-b97de91f2508 with user Flash3.8High. Scope ONLY firebase-creation.emulator.test.ts. Same constraints: NO existing other files/rules/production/docs/dependencies/commands/gates/commits/push/deploy/delegate/review/permissions/Astra. Codex runs tests. Report FILES_READY_FOR_CODEX and intentional remaining RED.

Independent reviewer CHANGES_REQUESTED; root19actualtests7PASS/12FAIL, mostly expected missing rule fences. Correct test defects without implementing rules or weakening requirements:

1. ~451 initially creating metadata status closed is invalid: unchanged meta.validate requires initial open. Create valid open metadata, acquire valid matching live initial lease using authorized SDK, then authorized close. Reverse-order race close~584 also needs valid matching lease first, or close will be denied even after missing-meta read rule fixed. Use valid existing lease schema/initial owner; preserve actual SDK happy paths.
2. Closed/expired deletion assertions~463/~483 currently run AFTER pointer replaced to missing roomTarget. They only prove deleting missing intent, not deleting pointer referencing closed/expired room. Test deletion directly while pointing to closed/expired record, then re-establish and prove replacement separately (or independent cases). Don't merely rename assertions.
3. withSecurityRulesDisabled returns Promise<void>; returning get from callback~547/~632 yields undefined and .exists runtime error. Assert snapshot inside callback, or prefer authorized read where own matching absent pointer permits (atomic case). Don't use admin to bypass a positive missing-meta read assertion.
4. Missing-meta read revocation should use fresh authenticated context/server-authorized read after pointer transition to make no-retained-cache requirement explicit.
5. Tests first still RED until actual rules implemented: initial pointer enforcement, missing/expired owner read exception, active-room pointer replacement/deletion fence, atomic resulting-state fence. Keep all those requirements and valid controls. Do not widen source scope to get green.

No terminal/gates, no background tasks. Read fixture/rules with supported file tools. Codex will run the actual focused file again and review.
