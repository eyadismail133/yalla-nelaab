# Correct final-round weighted score acceptance

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

Continue4679fd2d-bcac-4360-912f-b97de91f2508, gemini-3.8-flash-high. ONLY edit firebase-matches.emulator.test.ts, no otherfiles/noemulators/no commit/stage/push/deploy/delegation/review/payment/globalchanges.

Independentread-onlyreview confirms priorprivacy/stale/repeat/rematch/readinessfixes, but CHANGES_REQUESTED: line554 nowassertspoints<=200forALL5rounds. Actualengine667 scoreRound usesentry.weight; finalround5hasweight2, correcthostgets240..400. Derive [120,200] bounds fromactual resultview.round.weight (inspectactualprotocol), preserveweightingtestandnodoublescoreproof. Inspectothernewpoints/rangeassertsforidenticalunweightedassumption, fixonlyactualerrors. Don'tweakenboundtoarbitraryhugevalue or changeengine/scoring. Static typecheck, scopedgitdiffcheck only; emulatorsremainownedmaincorewriter. ReportexactdiffandemulatorUNEXECUTED. Codexindependentlyverifies.
