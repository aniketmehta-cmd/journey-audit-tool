# Journey Audit Tool

A small static web tool for auditing CleverTap retention journeys. Drop in your journey CSV exports — for any product, any category, any time period — and the dashboard rebuilds itself from the data.

Built for the Mosaic Wellness retention-ops team but works for any CleverTap journey export.

---

## What this tool does (and what it doesn't)

**Does:**
- Parses one or many CleverTap journey export CSVs in your browser
- Dedupes across files (handles the Android/iOS row split CleverTap exports for some journeys)
- Shows topline aggregates, per-journey deep-dives, and auto-generated Data Quality flags
- Works completely offline — no server, no install, no data leaves your browser

**Doesn't:**
- Write strategic recommendations for you (those are a human exercise — see [/docs](./docs) for examples done by hand)
- Compute Control-Group / incremental lift (Control Group data isn't in the journey export schema; pull it separately)
- Talk to CleverTap APIs (works on exported CSVs only)

---

## Quick start

### To run it (no install)

1. Download or clone this folder
2. Double-click `index.html`
3. The dashboard opens with Hair / Stage 2 sample data already loaded
4. Drop your own CleverTap CSV files anywhere on the page to replace the demo

That's it. No npm, no Python, no terminal needed.

### To share with someone

You have two options:

**Option A — share the whole folder** (good for collaborators):
- Zip the folder, send it
- They unzip and double-click `index.html`

**Option B — share a single file** (good for non-technical recipients):
- Run `python3 scripts/build.py` to bundle everything into one file
- Send them `dist/journey-audit-tool.html`
- They double-click that one file in any browser

---

## Folder structure

```
journey-audit-tool/
├── index.html              ← Entry point. Open this in a browser.
├── styles.css              ← All the CSS, with section headers
├── app.js                  ← Main app logic (state, file upload, rendering)
├── flags.js                ← Data Quality flag rules — edit to add new rules
├── data/
│   └── demo.js             ← Pre-loaded Hair / Stage 2 sample data
├── vendor/
│   └── papaparse.min.js    ← CSV parser (MIT licensed)
├── scripts/
│   └── build.py            ← Bundler — runs to produce dist/journey-audit-tool.html
├── dist/                   ← Generated bundled output (created on first build)
│   └── journey-audit-tool.html
└── README.md               ← This file
```

---

## Common edits

The tool is plain HTML/CSS/JS — no build step required for development. Edit any file, save, refresh the browser.

### Change the title or branding

Edit `index.html`. Look for:
```html
<div class="kicker">Mosaic Wellness · Retention Ops</div>
<h1>Journey Audit <em>Tool</em></h1>
```

### Change the color scheme

Edit `styles.css`. At the very top there's a `:root` block with all the color variables:

```css
:root {
  --bg: #faf7f2;          /* page background */
  --accent: #b8420d;      /* primary brand color */
  ...
}
```

Change these and the whole tool re-skins.

### Edit a tab's introductory copy

Each tab is a `<section class="tabpanel" data-tab="...">` block in `index.html`. Find the tab by ID (e.g. `data-tab="about"`) and edit the markup inside.

### Add a new Data Quality flag

Open `flags.js`. Each rule is a function. Copy an existing one as a template, change the condition, and add the new function name to the `FLAG_RULES` array at the bottom. The Data Quality tab will pick it up automatically.

Example: flag any journey with more than 30 nodes.

```javascript
function flagOversized(journeys) {
  const matches = journeys.filter(j => j.msg_nodes > 30);
  if (matches.length === 0) return null;
  return {
    type: 'warn',
    label: 'Possibly too long',
    title: 'Journeys with more than 30 message nodes',
    desc: `${matches.length} journey${matches.length>1?'s have':' has'} more than 30 messages. Worth checking for redundant or merge-able steps.`,
    journeys: matches,
  };
}

// Then add to FLAG_RULES at the bottom:
window.FLAG_RULES = [
  flagSilentRunning,
  flagDuplicateNames,
  // ...
  flagOversized,    // ← new one
];
```

### Change which CSV columns are required

Edit `app.js`, section A. Look for:
```javascript
const REQUIRED_COLS = ['Journey ID', 'Node ID', 'Journey Name'];
```

### Remove the demo data when sharing

Edit `data/demo.js` and replace its content with:
```javascript
window.DEMO_DATA = [];
```

Then the tool opens to a "no data loaded" empty state on first open. Useful when sharing externally.

### Add a new tab

1. In `index.html`, add a new `<section class="tabpanel" data-tab="myid">` block in the `<main>`
2. In `app.js` section A, add the tab to the `TABS` array: `{ id: 'myid', label: 'My Tab' }`
3. (Optional) Add a `renderMyTab()` function and call it from `renderAll()`

---

## How the data pipeline works

When you drop a CSV (or many), here's exactly what happens:

1. **Parse** each CSV using PapaParse (handles quotes, multi-line cells, etc.)
2. **Validate schema** — every file must have `Journey ID`, `Node ID`, and `Journey Name`. If not, a clear error is shown and your existing data is NOT replaced.
3. **Dedup across files** — for each Journey ID, pick the first file that contains it. If a journey shows up in two files (e.g. a category export and a single-journey export), the first-loaded one wins; the other is silently dropped.
4. **Sum within files** — group by (Journey ID, Node ID) and sum the metric columns. This collapses Android/iOS-split rows into one row per node, with metrics correctly added across both OSs. This is the key fix that prevents the under-counting bug in earlier versions of this analysis.
5. **Build journey objects** — one object per journey with: ID, name, status, owner, every message node (in order), full message copy, channel breakdown, goals, and pre-computed totals.
6. **Persist** to browser local storage so reloading the page doesn't lose your data.
7. **Render** all tabs.

All processing is local — your data never leaves the browser.

---

## Hosting it online (optional)

This is a static site, so you can host it for free anywhere. A few options:

- **GitHub Pages** — push the folder to a GitHub repo, enable Pages in repo settings, point at the root. Anyone with the URL can use it.
- **Netlify drop** — drag the folder onto [app.netlify.com/drop](https://app.netlify.com/drop). Instant URL.
- **Vercel** — `vercel deploy` from the folder. Same idea.
- **Your company intranet** — drop the bundled `dist/journey-audit-tool.html` on any internal file server.

Caveat: regardless of how it's hosted, all CSV processing still happens in the visitor's browser. You're not uploading data to a server.

---

## When you'd outgrow this tool

- **More than ~100,000 nodes** — browser parsing gets slow. At that point you want a server-side pipeline.
- **Need to compare datasets** (e.g. Q1 vs Q2) — currently the tool overwrites on each upload. You'd want a side-by-side comparison view.
- **Need scheduled refreshes** — this tool requires manual file drops. For automated nightly reports, you'd want a different setup (e.g. a Python script writing to a cloud bucket + a hosted dashboard).

When you hit these limits, talk to a developer about turning this into a proper data pipeline. The schema and dedup logic in `app.js` are a good starting point.

---

## License & attribution

PapaParse — MIT License, [github.com/mholt/PapaParse](https://github.com/mholt/PapaParse)

Everything else in this folder — internal Mosaic Wellness use.
