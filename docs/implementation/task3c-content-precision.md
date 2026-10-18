Bounded content correction in SAME completed UI Antigravity conversation, user-selected Gemini3.8 Flash. Do NOT touch net/App/engine/config/UI (Firebase task active). No commits/stage/push/deploy/delegation/Astra/globalsettings/payment. This is only two verified factual prompt corrections and their source note, not a broad bank rewrite or new games.

> Historical implementation record — current status updated 18 October 2026. This file preserves its original task scope and evidence; it is not an instruction for new work. For the deployed release, current test counts and known limits, see [STATUS](STATUS.md) and [release verification](../verification/release-2026-10-18.md). Future work follows the levels in [upgrade_plan.md](../../upgrade_plan.md).

Local real UI playthrough exposed an inherited inaccurate cinema question in TWO shapes. In content/seed/cinema.json:
- id cn-mcq-52 textAr currently إيه اسم أول فيلم كرتون طويل في التاريخ؟, answer index1 سنو وايت والأقزام السبعة, explanation اتعمل سنة1937.
- id cn-open-20 same textAr, answer سنو وايت, aliases unchanged, explanation من إنتاج ديزني سنة1937.

Verified primary source Disney archive: https://thewaltdisneycompany.com/news/film-archive-walt-disney-studios/ describes SnowWhite1937 as WaltDisney's first featurelength animatedfilm. Guinness officialrecord https://www.guinnessworldrecords.com/world-records/first-full-length-cartoon lists ElApóstol Argentina1917 as firstfeaturelengthcartoon. Therefore both question prompts are overbroad; don't change expectedanswer/options/IDs/scoring or addcontent.

Change BOTH textAr to إيه اسم أول فيلم كرتون طويل من إنتاج ديزني؟ and explanations to accurately say Disney's firstfeature animatedfilm released1937 (naturalEgyptianArabic). Preserve everyotherrecord, IDs, options,correctIndex,answeraliases,count,all14categories/all18games. Use smallest diff, no JSON reformatwholebank.

Add short docs/CONTENT-REVIEW.md noting twoIDs, oldproblem/newqualifiedprompt and the two primarysource links. State this is one verified correction, not a factual audit of all8,901items. Codex owns final review.

No new tests that merely assertcopy. Run existing npx vitest run apps/server/src/content/json-source.test.ts apps/web/src/content/browser-source.test.ts; expected26tests. These check schema/depth/duplication/lazybrowserparity. Report exact diff/results. Do not run emulators (coretaskowns9000/9099). Do not exceedscope.
