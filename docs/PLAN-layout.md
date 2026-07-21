# Implementation Plan — Recon Pane Layout

Status: **proposed**, not started. Log a `decisions-log.md` entry on execution.

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

## Phase 1 — Recon collapsed by default (cheap, do first)

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

---

## Phase 2 — Recon as an overlay (structural)

Burst-use tooling should not hold permanent width. Make the recon pane slide
**over** the map rather than displacing it.

**Shape of the change:**

- `.app-shell` becomes two columns (sidebar + map). The recon pane leaves the
  grid entirely.
- `.recon` becomes `position: absolute` within `.map-region`, pinned right,
  full height, translated off-canvas when closed:
  `transform: translateX(100%)` → `translateX(0)`, with a transition.
- The existing `#toggle-right` button drives the same `store.hideRight` flag —
  no change to the state model or persistence.
- `state.map.resize()` on toggle becomes **unnecessary** (the canvas no longer
  changes size), which removes a class of resize-timing bug.
- Guard the whole thing behind the existing `@media (min-width: 1081px)`; below
  that the stacked layout is unchanged.

**The thing that will bite: map centring.** Once the pane floats over the map,
the *visible* map area is narrower than the canvas, so `flyTo` centres entities
behind the overlay. Every fly path is affected — search, feed clicks, change
clicks, alert clicks. MapLibre takes a `padding` option:

```js
state.map.flyTo({ center: [lon, lat], zoom, padding: { right: reconOpen ? 390 : 0 } });
```

There are **7 `flyTo` call sites** today (`public/app.js` lines 584, 1181, 1226,
1284, 1605, 1615, 1623 — cluster zoom, feed click, change click, alert click,
recon history, gazetteer search, geocoded search). Route them through one
`flyToEntity()` helper that applies the current padding, rather than patching
each independently. Doing this is what
makes the overlay feel correct instead of subtly broken.

**Second consideration: the detail card.** `.entity-detail` is absolutely
positioned bottom-right *inside* `.map-region`, which is exactly where the
overlay will sit. Either shift it left by the pane width when the pane is open
(same padding value), or dock it to the bottom-left.

*Verify:* open/close animates without resizing the canvas; clicking an alert with
the pane open puts the entity in the *visible* half, not underneath it; the
detail card and the pane never overlap; below 1081px nothing changed.

---

## The tab ceiling (fold into Phase 2)

Measured at 1280: seven tabs at 44-58px each, none clipped **yet**. An eighth
drops them to ~38px and "Sanctions" begins truncating.

This is the same failure the layer list just hit — fine at 16 items, broken at
27. Once the pane is an overlay it can be wider (say 520px), which buys room; but
if the tab count keeps growing the honest fix is a vertical tab rail or grouped
tabs, the same move as the layer groups. Decide when an eighth tab is actually
needed, not before.

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

1. **Should the overlay be dismissible by clicking the map?** Natural for an
   overlay, but risks closing it accidentally mid-lookup. Leaning no.
2. **Should opening a recon tab from elsewhere auto-open the pane?** E.g. an
   alert notification deep-linking to the Alerts tab. Only matters if such links
   are added.
3. **Is 390px still the right width once it floats?** Wider costs nothing when it
   overlays rather than displaces, and it would relieve the tab ceiling.
4. **Does the left pane want the same treatment eventually?** Probably not — it
   is in continuous use — but if the map still feels cramped after Phase 2, that
   is the next lever.
