# Production measurements and release integration — 18 October 2026

The user skipped physical Android/iPhone acceptance and selected the production-measurement and release-integration steps. Physical acceptance remains unverified. No game code, billing, database rules, authority or hosting-region changes were needed for these measurements.

## Live measurement baseline

Measured the deployed `main` commit `fe4aeb8ef421d0e2392bf5a541f0ee29265a73d3` at [Yalla Nelaab](https://yalla-nelaab-20261016.web.app/). Desktop Chromium 156.0.8078.4, viewport 390×844. [Numeric samples and method notes](production-performance-2026-10-18.json).

| Measurement | Samples | Median | Range |
| --- | ---: | ---: | ---: |
| Cold navigation to enabled create-room button | 5 | 4,470 ms | 4,238–7,446 ms |
| Warm navigation to enabled create-room button | 5 | 1,433 ms | 1,403–1,552 ms |
| Cold first contentful paint | 5 | 2,236 ms | 2,168–4,860 ms |
| Warm first contentful paint | 5 | 480 ms | 400–484 ms |
| Guest lobby readiness acknowledged in enabled UI | 20 | 267 ms | 234–392 ms |
| Guest answer observed in host submitted-count UI | 5 | 247 ms | 241–271 ms |
| Guest answer confirmed in guest submitted-count UI with sending indicator cleared | 5 | 254 ms | 248–274 ms |
| Click to next animation-frame callback with answer disabled | 5 | 13 ms | 11–15 ms |

Startup profile: add 150 ms HTTP latency, 1.6 Mbps download, 750 Kbps upload and 4× CPU slowdown through Chromium CDP. Each cold sample uses a new context, followed by warm navigation in that context. The first cold sample was 7,446 ms; it is retained rather than excluded. Initial JS encoded body was 152,261 bytes on the live compressed response; resource transfer bytes were 153,461 cold and zero warm. Cached entries still report encoded body size, so that field alone is not network usage. The separate build budget remains **175,625 gzip bytes**, at most 185,000; live response encoding and build gzip totals are different metrics.

Gameplay used two isolated browser contexts on the same desktop/network with no synthetic frame delay or CPU throttle. The guest alternated ready/unready twenty times; every command was acknowledged and checked in the host's ready count. In a separate focused, short MCQ match, the guest submitted one answer per round and the host observed its authoritative submitted count before answering. Both clients progressed through five rounds; after the normal final-result transition, both left through the UI. Answers were selected without administrative reads or answer-key access.

Readiness p95 was 362 ms across twenty samples. With only five answer/startup samples, a nearest-rank p95 is the maximum and is not a reliable population tail estimate. Action times include Playwright/browser scheduling. The animation-frame callback checks immediate optimistic input locking; it does not measure physical touch or completed screen paint. Independently observed database REST badge samples were 216, 227 and 254 ms; one observation was unavailable. These are not gameplay acknowledgement times.

The measurement script was temporary and used the existing production UI and locators. An initial answer probe incorrectly counted every `role=status` element, including the persistent network badge. Its assertion failed after the first guest answer. The selector was narrowed to the actual sending indicator, and all five answer samples were rerun successfully in a new room. The completed startup/lobby measurements were retained. The failed probe closed its browser contexts without explicitly leaving that first temporary room; normal room expiry applies. The successful probe explicitly left both seats. No credentials, packet contents, room codes, screenshots, traces or browser storage were exported.

There is no matched older-release production timing sample. Earlier local/emulator startup and acknowledgement numbers use different paths and conditions; comparing them does not prove a production speed improvement or regression. This establishes a current production baseline for one computer/network. It does not cover physical devices, distinct Wi-Fi/mobile routes, 4/8-player production load, every round type in production, or Firebase billed traffic.

## Main integration and CI enforcement

- GitHub default and sole branch: `main`. Both former branches were verified as ancestors before deletion; commit history is retained. Latest source integration commit: `fe4aeb8`.
- A fresh Firebase build, bundle budget and Firebase module graph passed. Hosting deployment from `main` succeeded. Live HTML and entry SHA-256 matched that build; production create/join/readiness/host-transfer smoke passed (one test, 14.3 seconds). Runtime assets are identical to the previous fully hashed reliability deployment.
- [Release checks run 39135805991](https://github.com/eyadismail133/yalla-nelaab/actions/runs/39135805991): **quality SUCCESS**, **emulator-browser SUCCESS**, confirmed through the GitHub API.
- Branch-protection API returned **HTTP 403**: “Upgrade to GitHub Pro or make this repository public to enable this feature.” Repository administration access is available, so the blocker is the provider's plan restriction. Required checks cannot be enabled within the present private/free constraints. No paid upgrade, public visibility change or alternate enforcement workaround was made. Manual publication must continue to verify both CI jobs explicitly; successful workflows do not block direct pushes by themselves.

## Next measured work

1. Profile the cold-load path before choosing another split or initialization change: cold median was 4.47 s while warm was 1.43 s under the recorded profile. Keep the existing 185,000-byte gzip budget and privacy/recovery gates. Further optimization is not yet implemented or proven by this baseline.
2. Use this same profile and action endpoints for a matched after-change production comparison. Retain outliers and report input feedback separately from acknowledgement and database RTT.
3. Physical-phone acceptance stays skipped; free/private required-check enforcement stays externally blocked. These are explicit acceptance gaps, not successful checks. Level 4 content work remains the subsequent roadmap item.
