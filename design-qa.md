# Design QA — Autopilot onboarding ibrido

## Comparison target

- Source visual truth: `design/concepts/autopilot-onboarding-hybrid-selected.png`
- Rendered implementation: `design/audits/autopilot-2026-08-25/implementation-desktop-1487x1058.png`
- Full-view side-by-side evidence: `design/audits/autopilot-2026-08-25/comparison-reference-vs-implementation.png`
- Responsive evidence: `design/audits/autopilot-2026-08-25/implementation-mobile-390x844.png`
- Route/state: `http://127.0.0.1:4173/autopilot?onboarding=review`, light theme, review step, portfolio `0405bc2a-2bd1-443b-9000-8e6846fe6d10`.
- Desktop viewport and CSS size: 1487 × 1058 px. Source and implementation pixels: 1487 × 1058. Device density: 1 CSS px per comparison pixel; no density scaling.
- Mobile viewport and CSS size: 390 × 844 px. Screenshot pixels: 390 × 844. Measured document width: 390 px; no horizontal page overflow.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] The implementation preserves Torri’s existing 232 px desktop navigation shell, while the concept used a narrower illustrative sidebar. This is an intentional product constraint: it keeps every existing route stable and does not remove or crop review content.
- [P3] The implementation adds a close control to return to the existing Autopilot dashboard. This is an intentional usability addition outside the core visual target.

## Required fidelity surfaces

- Fonts and typography: DM Serif Display is used for the editorial headings and Manrope for UI/copy. Hierarchy, optical weight, line height, tracking, wrapping, and numeric emphasis match the selected concept closely at both viewports.
- Spacing and layout rhythm: two-column review, divider, card geometry, vertical rhythm, donut/legend balance, scenario section, risk control, and primary CTA align with the source. Mobile collapses to one column with the four-step progress visible.
- Colors and visual tokens: warm ivory/paper surfaces, forest green, sage, muted blue, gold, lavender, neutral cash, and green-to-coral risk gradient are consistently mapped to component tokens. Contrast remains legible.
- Image quality and asset fidelity: the target contains no photographic imagery. Charts are rendered as live Recharts graphics and interface icons use the existing Lucide icon library; no placeholder, emoji, handcrafted SVG, or raster substitute was introduced.
- Copy and content: portfolio identity, strategy title, preferences, 3% cash target, up-to-20 positions, +18%/−24% scenarios, guardrail explanation, and 14-day shadow promise are present and readable. Scenario language explicitly says these are modelled estimates, not predictions.

## Interaction and browser evidence

- Tested the complete progression: goals → preferences → guardrails → generated review.
- Tested macro-area selection, explicit meme-coin opt-in state, step navigation, local deterministic generation fallback, portfolio change affordance, and shadow activation affordance visibility.
- The native range controls are focusable and wired to React state; drag mutation was not automated because the selected browser control surface does not expose a drag gesture.
- Browser console checked after desktop and mobile review: 0 errors, 0 warnings.
- Production build, TypeScript, ESLint, Worker tests, StrategySpec tests, universe-policy tests, token-binding tests, and `git diff --check` passed.

## Focused-region evidence

A separate crop was not needed: the normalized 2974 × 1058 side-by-side comparison keeps typography, portfolio card, donut legend, scenario labels, slider, and CTA readable at original detail. Mobile was reviewed separately at 390 × 844 to validate the responsive regions that do not exist in the source concept.

## Comparison history

1. Earlier desktop pass: allocation donut and scenario panel were undersized relative to the source. Increased donut diameter, widened the allocation gap, tightened the scenario value column, adjusted the chart domain, and aligned CTA spacing. Post-fix evidence: `implementation-desktop-1487x1058.png` in the final side-by-side comparison.
2. [P2] First 390 px pass: the fixed onboarding layer had `right: 0` with an automatic left edge, causing the content to begin off-screen. Added an explicit mobile `left: 0`. Post-fix evidence showed the full title and card with document width equal to viewport width.
3. [P2] Second 390 px pass: the 620 px minimum-width progress row required horizontal scrolling and hid later steps. Reworked the ≤560 px stepper into four equal compact items. Post-fix evidence: `implementation-mobile-390x844.png`; all four steps are visible and page overflow remains zero.
4. Final desktop pass: repeated source/implementation comparison at the same 1487 × 1058 state; no actionable P0/P1/P2 difference remained.

## Implementation checklist

- [x] Match the selected hybrid visual direction.
- [x] Preserve real portfolio/scenario data semantics.
- [x] Make the four-step journey functional.
- [x] Validate desktop fidelity and mobile responsiveness.
- [x] Verify console, build, lint, deterministic engine, dynamic universe, and token binding.

## Follow-up polish

- Optional: if the entire Torri shell is redesigned later, evaluate narrowing the global desktop sidebar across every route as a separate product-wide change.

final result: passed

---

# Design QA — Strategia applicata e collaborazione multi-AI

## Comparison target

- Visual source reused: `design/audits/autopilot-2026-08-25/implementation-desktop-1487x1058.png` (the selected green/ivory onboarding review).
- Rendered implementation: `design/audits/autopilot-2026-08-25/active-strategy-viewport-stable.png`.
- Combined comparison input: `design/audits/autopilot-2026-08-25/active-strategy-comparison.html`.
- Route/state: `http://127.0.0.1:4173/autopilot?preview=active-strategy`, active shadow strategy with realistic allocation, scenario, virtual equity and multi-model review data.
- Browser viewport: 1280 × 720 CSS px; screenshot: 1269 × 720 px after the Torri browser shell.

## Findings and fixes

- [Fixed P2 · behavior] The first capture happened during the intended Recharts entrance animation, so the donut and scenario fan appeared partially drawn. Rechecked after animation completion; the stable screenshot contains the complete donut and full 12-month scenario.
- No actionable P0, P1, or P2 visual issues remain in the stable state.
- [P3 · intentional] The active strategy contains more information below the fold than the onboarding reference: portfolio movement, collaboration trace and deterministic guardrails are new requirements, not density drift.

## Required fidelity surfaces

- Fonts, palette and surfaces: the implementation preserves the DM Serif editorial hierarchy, warm ivory paper, forest green actions, sage chips, thin dividers and low-elevation cards from the selected source.
- Layout: allocation and scenarios remain the primary two-column pair. Agent Portfolio movement becomes the next full-width evidence panel; model review and guardrails form the final two-column block.
- Charts: the allocation donut, scenario bands and observed performance curve are live Recharts graphics with tooltips. The euro curve is explicitly identified as a proportional estimate based on eToro's virtual equity.
- Copy: “virtuale eToro” and “capitale reale” are never conflated. Scenario language says “forchetta, non promessa”. Collaboration copy exposes artifacts, verdicts and controls without exposing hidden model reasoning.
- Icons and states: all interface icons come from Lucide. Shadow, running, passed, warning and failed states have distinct text and color treatment.
- Accessibility: sections and timeline use semantic headings/lists; buttons are native, status updates use live regions during generation, motion respects `prefers-reduced-motion`, and no console errors or warnings were present.
- Responsiveness: the dashboard collapses its overview, allocation, performance and lower grids at 980/720 px, then makes actions and KPI groups single-column at phone widths. These breakpoints were also checked against TypeScript/CSS structure; the selected browser surface did not expose a viewport override for a second rendered mobile capture in this pass.

## Functional evidence

- Completing activation closes onboarding, selects “Strategia e limiti” and renders the persisted active dashboard.
- “Rivedi strategia” reopens the saved review; “Prova in dry-run” runs the already-active policy without regenerating it.
- Strategy generation streams a readable multi-provider trace, stores the final collaboration record and falls back across Cloudflare, Gemini, Groq and OpenRouter.
- Runtime rebalance remains single-model, first-success routing; deterministic validation remains the final authority.
- Production build, TypeScript, ESLint, Worker module import and 41 deterministic Worker tests passed. Build warnings are limited to the existing Node/Vite version advisory and bundle-size advisory.

final result: passed
