# fuel-log-pwa

A fuel logbook for motorcycles — as a phone app you install from the
browser. No app store, no account, no server.

Log every fill-up — date, odometer, gallons, price per gallon, station
if you want it — and the app shows real MPG per bike: miles since the
previous fill-up divided by gallons at this fill-up. Nothing is
invented: no tank size, no price, no MPG figure is ever suggested.
Every number on screen is one you typed in, or computed from numbers
you typed in by the formulas printed right next to them.

> All bikes, names, and numbers below are examples only.

## What it does

- **Log tab** — fill-ups for the picked bike, newest first, each with
  its MPG. A form logs a new one: bike, date, odometer, gallons, price
  per gallon, station (optional), a "partial fill" checkbox, notes.
  Total cost is computed (gallons × price, rounded to cents), never
  typed.
- **Summary tab** — per-bike totals and all-bikes totals: fill-ups,
  miles, gallons, cost, running-average MPG, cost per mile. The
  running average uses full-to-full segments only — miles and gallons
  summed raw, never an average of rounded per-fill-up figures.
- **Bikes tab** — the shared Pocket Garage roster (b1/b2/b3: 1995 Fat
  Boy, 1990 Softail, 1947 Knucklehead), with an add-a-bike form. Bikes
  live in the shared `pocket-garage-bikes` key via the vendored
  `bike-profile.js` — the same roster the other apps use, no second
  bike model. There is no delete-bike here: roster management belongs
  to the landing dashboard (Phase 2), so a mistyped bike is removed
  there, not here.
- **Data tab** — export the whole log as JSON, export one bike as JSON
  or readable text, import (replaces the log), load example data, and
  delete all fill-ups. Delete clears this app's fill-ups only — the
  shared bike roster is not touched.

## The MPG rule (read this before trusting a number)

MPG for a fill-up = miles since the previous fill-up on that bike
divided by the gallons bought at **this** fill-up. That only means
something when both fill-ups are full tanks, so:

- the first fill-up on a bike has no MPG (nothing before it);
- a partial fill has no MPG, and the fill-up after a partial has no
  MPG either (its miles were partly paid for by the partial's
  gallons). Totals still count partials — gallons, cost, and miles
  are all real money and real miles;
- a fill-up entered out of order (backfilling old receipts) slots
  into odometer order — MPG follows the sort, so it still comes out
  right. A wrong reading shows up as a 0.0 or absurd MPG on its row,
  not as a crash.

Cost per mile = total cost ÷ total miles. The running average MPG =
eligible segment miles ÷ eligible segment gallons.

## Files

- `index.html` — the four tabs (Log / Summary / Bikes / Data).
- `app.js` — pure logic (Node-testable) + the DOM layer. No build
  step, no dependencies.
- `styles.css` — 1990 Treatment (live dyno `styles.css` is the
  reference): gloss tank black #070709, chrome, purple #9d6bff,
  UnifrakturCook headings, Archivo Narrow body. Buttons have no hover
  transform — the house hover shift breaks Playwright stability
  checks and sticks after a tap on touch (AGENTS.md, Nov 24, 2026).
- `sw.js` — app-shell cache `fuel-log-v1`; every file `index.html`
  loads is precached. `sw-update.js` is the shared update-button
  module (vendored verbatim, md5 `dca37625a13049e7eb021d5a25c649d3`).
- `bike-profile.js` — the shared bike roster module (vendored
  verbatim, md5 `c618323a4b8ed7f37004260a044503ce`).
- `manifest.webmanifest`, `icons/` — PWA install files. Icons are
  Pillow-drawn from `make_icons.py` (gas pump: chrome body, MPG
  screen, purple nozzle).
- `test.js` — Node suite, 79 checks. `test_ui.py` — Playwright UI
  smoke (see TESTING.md).

## Publish

New repo (the connector cannot create repos — that happens in the
browser at publish time), GitHub Pages enabled in Settings → Pages
(it is off by default on a new repo and the site 404s without it),
then a landing card for the fuel log. Push paths (every file the live
`sw.js` precaches or `index.html` loads — the standing lesson): all
files in this directory except `make_icons.py`, `test.js`,
`test_ui.py`, and `TESTING.md`.
