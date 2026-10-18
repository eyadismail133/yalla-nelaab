# Content Review Note: Cinema Seed Bank (`cn-mcq-52` & `cn-open-20`)

> Updated 18 October 2026: the corrections below remain bounded historical evidence. Current release results are in [release verification](verification/release-2026-10-18.md); future content work is Level 4 of [the upgrade plan](../upgrade_plan.md).

## Current review queue and telemetry policy

- MCQ/numeric telemetry records anonymous aggregate plays, answers, correctness and solve time. `npm run telemetry:report --silent` reads an exported `/telemetry` JSON tree from stdin and emits review suggestions.
- After at least 50 plays, a skip rate above 80% flags a question for review. Difficulty suggestions retain the existing 1–5 scale. Neither flagging nor reporting retires questions or applies ratings automatically.
- Multi-question reducers need per-question instrumentation before their telemetry can be included accurately.
- Live gameplay surfaced `fb-mcq-153`, a claim about a Morocco–Netherlands 2026 World Cup result, for source verification. This record does not establish its factual correctness; retain it as playable until a reviewer checks an authoritative tournament record, as requested.
- Functional content/schema tests and a successful playthrough do not prove every fact in the 8,901-item bank. New football Hot Takes and career-path content are deferred.

## Scope & Purpose
This document records a bounded factual correction in `content/seed/cinema.json`. This is a single verified factual fix identified during playthrough, **not** a comprehensive factual audit of all 8,901 items in the question bank. Codex owns final review.

---

## Items Reviewed & Corrected

### 1. `cn-mcq-52` (`shape: "mcq"`, `category: "cinema"`)
- **Old Prompt (`textAr`)**: `إيه اسم أول فيلم كرتون طويل في التاريخ؟`
- **Old Explanation (`explanationAr`)**: `اتعمل سنة 1937.`
- **New Qualified Prompt (`textAr`)**: `إيه اسم أول فيلم كرتون طويل من إنتاج ديزني؟`
- **New Explanation (`explanationAr`)**: `أول فيلم كرتون طويل من إنتاج ديزني، نزل سنة 1937.`
- **Preserved Properties**:
  - `options`: `["بامبي", "سنو وايت والأقزام السبعة", "بينوكيو", "سندريلا"]`
  - `correctIndex`: `1` ("سنو وايت والأقزام السبعة")
  - `difficulty`: `4`

### 2. `cn-open-20` (`shape: "open_answer"`, `category: "cinema"`)
- **Old Prompt (`textAr`)**: `إيه اسم أول فيلم كرتون طويل في التاريخ؟`
- **Old Explanation (`explanationAr`)**: `من إنتاج ديزني سنة 1937.`
- **New Qualified Prompt (`textAr`)**: `إيه اسم أول فيلم كرتون طويل من إنتاج ديزني؟`
- **New Explanation (`explanationAr`)**: `أول فيلم كرتون طويل من إنتاج ديزني، نزل سنة 1937.`
- **Preserved Properties**:
  - `answerAr`: `"سنو وايت"`
  - `aliases`: `["سنو وايت والأقزام السبعة", "سنووايت"]`
  - `difficulty`: `4`

---

## Factual Rationale & Primary Sources

1. **Overbroad Historical Claim**:
   - The historical record recognizes the Argentine animated film ***El Apóstol*** (directed by Quirino Cristiani, released in **1917**) as the world's first full-length cartoon feature film.
   - Reference: **Guinness World Records**: [First full-length cartoon](https://www.guinnessworldrecords.com/world-records/first-full-length-cartoon).

2. **Accurate Qualified Claim**:
   - ***Snow White and the Seven Dwarfs*** (released in **1937**) is Walt Disney's first feature-length animated film (and the first cel-animated feature).
   - Reference: **The Walt Disney Company Film Archive**: [Film Archive - Walt Disney Studios](https://thewaltdisneycompany.com/news/film-archive-walt-disney-studios/).

3. **Resolution**:
   - Qualifying the question to specify Disney (`من إنتاج ديزني`) aligns the prompt with the expected answer (*Snow White*) without changing the answer, choices, aliases, difficulty, or scoring structure.
