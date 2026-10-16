<task>
Task 1: Extract the existing match engine into a browser-compatible workspace package, preserving behavior. Repo D:/projects/football game, branch launch/free-online. User approved implementing Firebase-only fallback because Render demanded a card. This task is ONLY reusable engine and browser content source; Firebase transport, UI and deployment are separate tasks.

Create packages/engine with MatchEngine, MemoryStore, RoomStore/errors, room codes and toView moved from apps/server/src/rooms. Leave compatibility re-exports so existing server imports and tests work. Browser entry must have no node imports, filesystem, network or server dependencies. nanoid has a browser export. Update workspace dependencies, aliases and typecheck command. Keep shared and rounds canonical, all scoring/rules/session semantics/8-player limit unchanged. Node JsonSource remains server-only.

Add browser ContentSource in apps/web/src/content using Vite lazy JSON imports for existing content/seed/*.json (8901 questions/14 categories). Keep lightweight category manifest so categories() does not download question banks. Load selected category files when needed, plus category-agnostic poll/word_race content from friends. Preserve validation, difficulty preference, exclusion/no-repeat and exhaustion semantics. Avoid banks in initial JS entry. Use injected loader for Node tests and a thin Vite entry if needed. Add focused tests for metadata parity, agnostic selection, exclusion, loading and schema validation. Retain existing engine tests. No DOM infrastructure.

No Firebase SDK/config, room protocol/readiness or UI changes here. No question-file edits or unrelated refactors. Never invoke Astra or any reviewer/delegate.
</task>
<verification_loop>
Actual gates: npm test (499 baseline passing with unrestricted localhost), npm run typecheck, npm run build:web. No lint script. Start with focused failing behavioral tests and show red/green evidence where feasible. If shell permissions block a command, report the denied command without bypassing permissions. Orchestrator can run gates. Ensure lazy content chunks and no Node dependencies in browser build. Socket test sandbox timeouts are environmental.
</verification_loop>
<action_safety>
Do not commit, stage, push, deploy, alter global settings, enter payment details or enable billing. Only edit this repo. Use configured default model. Leave changes uncommitted. Do not read or publish firebase-debug.log, credential stores or .env secrets. Ignore firebase-debug*.log and .firebase/ if needed. If npm install is denied, edit manifest and report the required command instead of bypassing permissions.
</action_safety>
<structured_output_contract>
Finish with: 1. Changes and why; 2. Files touched; 3. Gate counts and red/green evidence; 4. Deviations/blockers/limitations. Implementer only; no review, commits or delegation. Actually edit files, not just propose work.
</structured_output_contract>
