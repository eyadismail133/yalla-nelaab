# Content Review Note: Cinema Seed Bank (`cn-mcq-52` & `cn-open-20`)

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
