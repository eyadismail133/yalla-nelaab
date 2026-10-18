# Graphite / copper redesign — 19 October 2026

Current visual direction approved after the earlier purple and cream form iterations.

## Requested outcome

Remove the purple direction and change the visual composition substantially. Create a richer, coherent game identity rather than another color-only change. Implementation remains direct Codex work, without Antigravity, as requested by the user.

## Delivered design

- Neutral graphite page and panels, copper-orange actions, ivory typography, and restrained brass details. Round token names remain compatible with the game registry; the former violet/fuchsia tokens now resolve to non-purple colors.
- Original orange speech-bubble/controller SVG logo, PNG export, favicon, and matching result-card mark.
- New generated tactile 3D illustration of a party-game kit. Responsive local WebP assets are 33,062 and 101,656 bytes. Earlier artwork is retained in local design drafts and is not shipped.
- Integrated hero composition: the illustration blends into the background beside the copy and working form, with no frame or caption box. On mobile it becomes a subdued decorative backdrop behind the heading. Invite joining uses a compact mobile layout.
- A four-part facts strip derived from the existing registry and topic manifest, plus illustrated previews of three real games, followed by topics and the expandable discovery/catalog tools.
- Custom SVG game symbols, responsive catalog and preset grids, monochrome topic icons, consistent neutral surfaces throughout gameplay and exported results.
- Homepage-specific styles live in `apps/web/src/home.css`; shared tokens and game styling remain in `styles.css`. Transport, game rules, content, and scoring have not been changed.

## Verification

**Direct review verdict: APPROVED.** Reviewed against the requested composition, existing action handling, asset references, and responsive/accessibility requirements.

- Existing suite: 713 tests / 36 files passed on the complete rerun. One recovery BroadcastChannel timing assertion failed during concurrent build load, then passed both in isolation and in the full rerun; recovery code was unchanged.
- TypeScript and Firebase production build passed; bundle-size budget and Firebase module isolation passed.
- Fresh release gates: 83 Firebase emulator tests and all 6 production-build browser scenarios passed. The dependency audit found zero vulnerabilities. Deployment targets Firebase Hosting only because the database rules are unchanged.
- Home and join layouts checked at 320×740, 360×800, 390×844, 412×915, 768×1024, 1024×768, 1440×1000, 1920×1080, and 667×375 landscape. The actual computed background/action colors were asserted, not inferred from source files. No horizontal overflow or page errors.
- All 18 catalog cards expanded at 320, 390, 768, 1024, and 1440 px; filters worked and visible cards fit their containers.
- Homepage at 200% root text size: no visible element overflow at 390 px. Reduced-motion scrolling checked.
- Two independent players created/joined a room, confirmed readiness, played a complete focused five-round match, downloaded the branded PNG result card, and rematched. No page errors.
- Empty-name validation preserved the invite room code.
- Final hero screenshots are saved as `docs/verification/integrated-hero-*.png`. Gameplay screenshots and the actual exported result image are saved as `docs/verification/graphite-*.png`.

Viewport checks used Chromium emulation, not physical phone hardware. Publishing was requested after design approval; the release is subject to fresh unit, emulator, browser, build, bundle and dependency gates, followed by live verification.

## Artwork provenance and prompt

Generated with the built-in imagegen tool; logo and game symbols were drawn as native SVG. Final assets live in `apps/web/public/brand/` with `challenge-kit-` and `logo-graphite` names.

Hero prompt: premium 3D editorial still life for an Arabic friends party game. Central thick upright tangerine card with a debossed ivory question mark, cream and graphite cards, brushed brass trophy, ivory die, orange stopwatch, sculptural asterisk tokens on charcoal geometric podiums. Tactile paper/polymer textures, precise bevels, warm orange rim light and ivory fill, near-black stage. Landscape 3:2, objects in the central 75%, negative space and charcoal edges. No people, purple/violet/lavender/magenta/blue/teal/mint/green, text, numbers, logos, watermark, or UI mockup. Only question marks and die dots as markings.
