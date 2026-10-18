# Content Review Note: Cinema Seed Bank (`cn-mcq-52` & `cn-open-20`)

> Updated 18 October 2026: the corrections below remain bounded historical evidence. Current release results are in [release verification](verification/release-2026-10-18.md); future content work is Level 4 of [the upgrade plan](../upgrade_plan.md).

## Current review queue and telemetry policy

- MCQ/numeric telemetry records anonymous aggregate plays, answers, correctness and solve time. `npm run telemetry:report --silent` reads an exported `/telemetry` JSON tree from stdin and emits review suggestions.
- After at least 50 exposures, a skip rate above 80% flags a question for review. Difficulty suggestions additionally require at least 20 answers and retain the existing 1–5 scale. Neither flagging nor reporting retires questions or applies ratings automatically.
- Level 4 adds per-question instrumentation for quickfire, odd-one-out, bidding, land grab, ladder and relay alongside MCQ/numeric. Statistics stay separated by mode; other modes remain excluded until their measurement contract is defined. See [authenticated review and retention workflow](CONTENT-REVIEW-WORKFLOW.md).
- `fb-mcq-153` is now source-verified: FIFA records Netherlands 1-1 Morocco, penalties 2-3, in the round of 32. Its answer is retained, with an explanation added. [Official tournament results](https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/knockout-stage-match-schedule-bracket).
- Functional content/schema tests and a successful playthrough do not prove every fact in the 8,901-item bank. New football Hot Takes and career-path content are deferred.

## Scope & Purpose
This document records a bounded factual correction in `content/seed/cinema.json`. This is a single verified factual fix identified during playthrough, **not** a comprehensive factual audit of all 8,901 items in the question bank. Codex owns final review.

---

## Level 4 bounded football review — 18 October 2026

- `fb-mcq-158`: corrected the prompt from France reaching the quarter-finals after beating Morocco to reaching the **semi-finals** after that quarter-final win. Kept the answer, options, ID and difficulty. [Official FIFA quarter-final highlights](https://www.youtube.com/watch?v=Lfo49ZbV4WU).
- `fb-bool-75`: corrected `isTrue` to `false`. Its claim that only Gerd Müller had previously exceeded eight goals in one World Cup was false: Fontaine, Kocsis, Ademir and Eusébio also did so. Added an explanation while preserving the ID and difficulty. [FIFA's historical single-edition scoring record](https://www.fifa.com/en/articles/just-fontaine-thirteen-goals-1958).
- `fb-mcq-153`, `fb-mcq-154`, `fb-num-36`, `fb-num-37` and `fb-num-38`: verified existing answers against FIFA match results and format/schedule; retained answers and difficulties. The last three concern 104 total matches, 72 group-stage matches and 12 groups. [FIFA format](https://gpcustomersupportfwc2026.tickets.fifa.com/hc/en-gb/articles/28784798873117-10-What-is-the-format-for-the-FIFA-World-Cup-2026-tournament), [FIFA Canada–Morocco report](https://www.fifa.com/en/tournaments/mens/worldcup/canadamexicousa2026/articles/canada-morocco-match-report-highlights).
- [Machine-readable decisions](../content/review-decisions.json) contain 91 dated football claims: five verified, two corrected and **84 awaiting primary-source review**. Queued records remain playable. This release is a bounded review, not verification of every claim or a full-bank audit.

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
