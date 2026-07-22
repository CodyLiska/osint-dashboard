# Implementation Plan — Recon Pane Layout

Status: **Phases 1 and 2 done** (2026-07-20). Remaining: the tab ceiling (not yet
hit) and the four open questions at the end.

## Goal

Give the map back the screen. Two permanently-docked side panes cost 730px, so
on a laptop the map — the primary artifact of a situational-awareness tool — is
a minority of the display.

## Evidence

Measured 2026-07-20 against the running app:

| Viewport | Map width | Map share |
| -------- | --------- | --------- |
| 1280 (13") | 550px | **43%** |
| 1440 (14") | 710px | 49% |
| 1600 (16") | 870px | 54% |
| 1920 | 1190px | 62% |

The cost is lopsided between the two panes:

- **The left pane earns its space.** Layer toggling is continuous, and after the
  collapsible-group work it is dense and scannable.
- **The right pane mostly does not.** In its default Crypto state, **490px of its
  800px height is an empty result box** (61% empty). It holds burst-use tooling —
  look up a wallet, check an IP, read alerts — behind permanent chrome.

That the `‹ ›` collapse toggles already exist is itself the tell: they were added
because the panes were too big.

## Non-goals

- **The left pane is not in scope.** Grouping fixed its scaling problem.
- **No change to what the recon tools do.** This is where they live, not what
  they are.
- **No mobile redesign.** Below 1081px the shell already stacks vertically and
  the overlay approach must not apply there.

---

## Phase 1 — Recon collapsed by default — DONE (2026-07-20)

The pane stays exactly as it is; it just starts closed. Map goes **43% → 73%** at
1280px, and the pane is one click away on the existing toggle.

**Implementation.** `loadStore()` currently returns `{}` when nothing is saved,
so `store.hideRight` is `undefined` → falsy → pane shown. Seed the default so it
applies only when the key is *absent*:

```js
function loadStore() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    // Spread saved LAST so an explicit `hideRight: false` (the user opened it)
    // survives; only an absent key picks up the default.
    return { hideRight: true, ...saved };
  } catch {
    return { hideRight: true };
  }
}
```

Everything else already works: `applyPaneState()` reads `store.hideRight`, sets
the class, flips the chevron, and calls `state.map.resize()`.

**Note:** existing users have a saved store with no `hideRight` key, so they will
pick up the new default on next load. That is intended, but it is a visible
change to anyone already using it.

*Verify:* fresh profile opens with the map at ~73% and the pane closed; clicking
`›` opens it and that choice survives a reload; the map canvas resizes (no
letterboxing).

**Verified** via Playwright, measured not eyeballed:

| Check | Result |
| ----- | ------ |
| 1280, fresh profile | map 940px = **73%** (was 550px / 43%), pane closed |
| Explicit open + reload | `hideRight:false` persists, back to 550px / 43% |
| 900px (stacked) | `hide-right` class applies but is inert — pane still 885×280 |
| 8 rapid toggles | canvas width tracks region every time, 0 console errors |

Testing gotcha for Phase 2: clearing `localStorage` from a live page does **not**
give a fresh profile — the in-memory `store` is rewritten whole by the next
`persist()` (the map viewport handler fires on resize), restoring the old
`hideRight`. Clear and reload in the same evaluate call.

---

## Phase 2 — Recon as an overlay — DONE (2026-07-20)

Burst-use tooling should not hold permanent width. The recon pane now slides
**over** the map rather than displacing it.

**What was built:**

- `.app-shell` is two columns (sidebar + map) above 1081px; the recon pane leaves
  the grid.
- `.recon` is `position: absolute` within `.app-shell` — **not** `.map-region` as
  planned, which avoided moving it in the DOM. It is pinned right, full height,
  `translateX(100%)` when closed, with `visibility: hidden` delayed until the
  slide finishes so an off-canvas pane is not tab-focusable.
- `#toggle-right` drives the same `store.hideRight` flag — state model unchanged.
- The canvas no longer changes size on toggle (measured: 940px in both states).
- All of it sits inside `@media (min-width: 1081px)`; below that the pane is
  `position: static` and the flag is inert.
- Geometry lives in `--recon-width` / `--pane-transition` on `:root`.

**Map centring — solved more cheaply than planned.** MapLibre's camera `padding`
is **sticky transform state**, not a per-call option. So `syncMapPadding()` sets
it once on toggle and *every* camera move is re-centred — all seven `flyTo` sites,
plus `fitBounds` and the restored viewport — **without touching a single call
site**. The planned `flyToEntity()` helper was not needed and was not built.

`reconOverlayWidth()` reads the live element width (so padding cannot drift from
`--recon-width`) and detects the breakpoint via computed `position === "absolute"`
rather than duplicating `1081px` in JS.

**Correction to this plan's premise.** It claimed an un-padded `flyTo` centres
entities *behind* the overlay. Measured against MapLibre 4.7.1, that is only true
in a narrow band — the centre of the canvas is left of the overlay at most widths:

| Viewport | Map region | Bare `flyTo` x | Overlay starts | Verdict |
| -------- | ---------- | -------------- | -------------- | ------- |
| 1081 | 741 | 371 | 351 | **hidden** (−19px) |
| 1120 | 780 | 390 | 390 | exactly at the edge |
| 1280 | 940 | 470 | 550 | visible, 80px clearance |
| 1440 | 1100 | 550 | 710 | visible, 160px |
| 1920 | 1580 | 790 | 1190 | visible, 400px |

Padded, the target lands at the centre of the *visible* strip every time (275 at
1280). So padding is still right — it is just fixing "off-centre and crowded
against the pane, hidden below ~1120px", not "always hidden".

**The thing that actually bit: the topbar.** The plan flagged `.entity-detail`
but missed that `.topbar` is also pinned to the map region's right edge — and
`#toggle-right` lives at its right end. With the overlay open the close button sat
at x=1220 underneath a pane starting at x=890 (`elementFromPoint` returned a recon
`tab`), so **the pane could be opened but not closed**. Both `.topbar` and
`.entity-detail` now shift by `calc(var(--recon-width) + 18px)` when open.

**Known cost:** animating the padding fires `moveend`, and `refreshViewportAware()`
refetches unconditionally on `moveend` — so toggling the pane triggers one Overpass
refetch when the `infrastructure` layer is enabled. A toggle is a deliberate,
infrequent action, so this was accepted rather than adding a suppression flag. If
Overpass rate-limiting becomes a problem, gate `refreshViewportAware` on an actual
bbox change.

*Verified* (Playwright, measured):

| Check | Result |
| ----- | ------ |
| Canvas resize on toggle | none — 940px across 8 toggles, one distinct width |
| Camera padding | 0 closed / 390 open / 0 below 1081px |
| Centre drift over 4 open-close pairs | exactly 0 |
| `#toggle-right` reachable | clickable in both states (872 ≤ 890 when open) |
| Detail card vs pane | card ends 872, pane starts 890 — no overlap |
| Fly with pane open | Tokyo lands centred in the visible strip |
| 1000px stacked | `position: static`, padding 0, layout unchanged |
| Console errors | 0 |
| `npm test` | 288 pass |

---

## The tab ceiling — RESOLVED 2026-07-21

Measured at 1280: seven tabs at 44-58px each, none clipped **yet**. An eighth
drops them to ~38px and "Sanctions" begins truncating.

**Fixed when the Econ + Entity tabs (8th, 9th) landed:** `.tabs` moved from
`grid-template-columns: repeat(7, 1fr)` to `repeat(auto-fill, minmax(62px, 1fr))`,
so the bar now **wraps to a second row** (~5 per row) instead of clipping. No
overlay widening or vertical rail needed; the ceiling is gone for future tabs
too. The pane can still be widened via `--recon-width` if a single-row look is
ever wanted back.

## Testing

The layout is CSS and cannot be unit-tested here (no browser test runner — the
zero-dep rule stands). Verify via Playwright, as with the previous layout work,
measuring rather than eyeballing:

- map width / viewport width at 1280 and 1920, pane open and closed
- `.recon` is not below the fold and its inner scroll areas still scroll
- a fly with the pane open lands the entity outside the overlay's rectangle
- at 900px wide the stacked layout is byte-identical to today
- no console errors after toggling repeatedly (listener accumulation)

## Open questions

All four were left open by Phase 2 — none blocks it, and each is better answered
after using the overlay than before.

1. **Should the overlay be dismissible by clicking the map?** Natural for an
   overlay, but risks closing it accidentally mid-lookup. Not built; still leaning
   no.
2. **Should opening a recon tab from elsewhere auto-open the pane?** E.g. an
   alert notification deep-linking to the Alerts tab. Only matters if such links
   are added.
3. **Is 390px still the right width once it floats?** Now a one-line change —
   `--recon-width` on `:root`, which both the CSS and the camera padding read. A
   wider pane costs the map nothing while closed and would relieve the tab
   ceiling.
4. **Does the left pane want the same treatment eventually?** Probably not — it
   is in continuous use — but if the map still feels cramped, that is the next
   lever.
