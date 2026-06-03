/*
  Journey Audit Tool — Application Logic
  ====================================================================
  This file is the engine that ties everything together. The user
  interacts with index.html; this file:
    - reads & parses uploaded CSV files
    - dedupes the data
    - keeps the current state in memory
    - renders every tab
    - handles drag/drop, file picker, persistence

  Section map (search for these headers to navigate):
    A. Config & constants
    B. State + storage
    C. Formatters
    D. CSV parsing pipeline
    E. File upload handling
    F. Drag-drop overlay + buttons
    G. Rendering — dataset bar
    H. Rendering — Overview tab
    I. Rendering — Journeys tab
    J. Rendering — Data Quality tab
    K. Rendering — tabs and dispatch
    L. Init

  IMPORTANT
  ---------
  - Demo data is loaded from data/demo.js (sets `window.DEMO_DATA`).
  - Flag rules come from flags.js (sets `window.FLAG_RULES`).
  - PapaParse (the CSV library) is loaded from vendor/papaparse.min.js.
*/


/* ====================================================================
   A. CONFIG & CONSTANTS
   ==================================================================== */

// localStorage key — bump the version (v1 → v2) if the data shape changes
const STORAGE_KEY = 'cm_journey_audit_v1';

// CSV columns the tool needs to consider a file valid
const REQUIRED_COLS = ['Journey ID', 'Node ID', 'Journey Name'];

// CSV columns that carry numbers we want to sum across OS-split rows
const METRIC_COLS = [
  'Total Sent','Total Delivered','Total Viewed','Total Clicked','Errors',
  'Unique Sent within Conversion Time','Unique Viewed within Conversion Time',
  'Unique Clicked within Conversion Time','Unique Converted within Conversion Time',
  'Influenced Conversions','Influenced Revenue','Total Unsubscribes','Total Replied',
  'Goal 1 Conversions','Goal 2 Conversions','Goal 3 Conversions',
];

// Tabs shown in order — edit this to add/remove tabs
const TABS = [
  { id: 'about',    label: 'About' },
  { id: 'overview', label: 'Overview' },
  { id: 'journeys', label: 'Journeys' },
  { id: 'quality',  label: 'Data Quality' },
  { id: 'method',   label: 'Methodology' },
];


/* ====================================================================
   B. STATE + STORAGE
   ==================================================================== */

let state = {
  mode: 'demo',                     // 'demo' | 'uploaded'
  files: [],                        // [{ name, rowCount }]
  journeys: window.DEMO_DATA || [], // processed journey objects
  loadedAt: null,
};

function save() {
  try {
    if (state.mode === 'uploaded') {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        mode: state.mode,
        files: state.files,
        journeys: state.journeys,
        loadedAt: state.loadedAt,
      }));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch (e) {
    console.warn('Could not save to local storage:', e);
    toast('Could not save to local storage (may be full). Data will not persist across reloads.', 'error', 6000);
  }
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (data.journeys && data.journeys.length) {
      state.mode = data.mode || 'uploaded';
      state.files = data.files || [];
      state.journeys = data.journeys;
      state.loadedAt = data.loadedAt;
      return true;
    }
  } catch (e) {
    console.warn('Could not load from local storage:', e);
  }
  return false;
}


/* ====================================================================
   C. FORMATTERS
   ==================================================================== */

function fmt(n) {
  if (n == null || isNaN(n)) return '–';
  if (n === 0) return '0';
  return Number(n).toLocaleString('en-IN');
}
function fmtLakh(n) { return n ? '₹' + (n/100000).toFixed(1) + 'L' : '–'; }
function fmtCr(n)   { return n ? '₹' + (n/10000000).toFixed(2) + ' Cr' : '–'; }
function pct(a, b, dp = 1) {
  if (!b) return '–';
  return ((a/b)*100).toFixed(dp) + '%';
}
function escapeHTML(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function toast(msg, type='info', duration=4000) {
  const c = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  c.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(20px)';
    el.style.transition = 'all 0.2s';
  }, duration - 200);
  setTimeout(() => el.remove(), duration);
}


/* ====================================================================
   D. CSV PARSING PIPELINE
   - Parse each file with PapaParse
   - Validate schema (required columns present)
   - For each Journey ID, pick ONE source file (first-loaded wins)
   - Group by (Journey, Node) and SUM metric columns
     (collapses Android/iOS row splits)
   - Build the per-journey objects the UI expects
   ==================================================================== */

function parseCsvFile(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      dynamicTyping: false,
      complete: results => {
        if (results.errors.length) {
          console.warn(`Parse warnings for ${file.name}:`, results.errors.slice(0, 3));
        }
        resolve({ name: file.name, rows: results.data });
      },
      error: err => reject(err)
    });
  });
}

// Resolve a column by name, tolerating leading/trailing whitespace
// (CleverTap exports sometimes have " Channel / Segment / Controller Type" with a leading space)
function getCol(row, ...candidates) {
  for (const c of candidates) {
    if (c in row) return row[c];
    for (const k of Object.keys(row)) {
      if (k.trim() === c.trim()) return row[k];
    }
  }
  return undefined;
}

function toNum(v) {
  if (v === '' || v == null) return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function classifyJourneyChannels(nodes) {
  const ch = {};
  nodes.forEach(n => {
    if (!n.channel) return;
    if (!ch[n.channel]) {
      ch[n.channel] = { nodes: 0, sent:0, delivered:0, viewed:0, clicked:0, converted:0, influenced:0, inf_rev:0 };
    }
    ch[n.channel].nodes++;
    ch[n.channel].sent       += n.sent;
    ch[n.channel].delivered  += n.delivered;
    ch[n.channel].viewed     += n.viewed;
    ch[n.channel].clicked    += n.clicked;
    ch[n.channel].converted  += n.converted;
    ch[n.channel].influenced += n.influenced;
    ch[n.channel].inf_rev    += n.inf_rev;
  });
  return ch;
}

function processRawRows(filesData) {
  // -- 1. Schema validation --
  const missing = [];
  for (const f of filesData) {
    if (f.rows.length === 0) continue;
    const normalizedKeys = Object.keys(f.rows[0]).map(k => k.trim());
    for (const req of REQUIRED_COLS) {
      if (!normalizedKeys.includes(req)) missing.push({ file: f.name, col: req });
    }
  }
  if (missing.length) {
    const msg = missing.slice(0, 5).map(m => `${m.file} missing column "${m.col}"`).join('; ');
    throw new Error(`Invalid CSV schema — ${msg}`);
  }

  // -- 2. Pick one source file per Journey ID (first-loaded wins) --
  const jidToSource = {};
  for (const f of filesData) {
    for (const row of f.rows) {
      const jid = getCol(row, 'Journey ID');
      if (jid == null || jid === '') continue;
      if (!(jid in jidToSource)) jidToSource[jid] = f.name;
    }
  }

  // -- 3. Keep only rows from the chosen source per journey --
  const keptRows = [];
  for (const f of filesData) {
    for (const row of f.rows) {
      const jid = getCol(row, 'Journey ID');
      if (jid == null || jid === '') continue;
      if (jidToSource[jid] === f.name) {
        row.__source = f.name;
        keptRows.push(row);
      }
    }
  }

  // -- 4. Group by (Journey, Node), SUM metrics across OS-split rows --
  const grouped = new Map();
  for (const row of keptRows) {
    const jid = getCol(row, 'Journey ID');
    const nid = getCol(row, 'Node ID');
    const key = `${jid}__${nid}`;
    if (!grouped.has(key)) {
      const fresh = { __jid: jid, __nid: nid };
      for (const k of Object.keys(row)) fresh[k] = row[k];
      for (const mc of METRIC_COLS) fresh[mc] = toNum(getCol(row, mc));
      grouped.set(key, fresh);
    } else {
      const acc = grouped.get(key);
      for (const mc of METRIC_COLS) acc[mc] += toNum(getCol(row, mc));
    }
  }

  // -- 5. Build journey objects --
  const journeyMap = new Map();
  for (const row of grouped.values()) {
    const jid = row.__jid;
    if (!journeyMap.has(jid)) {
      journeyMap.set(jid, {
        id: Number(jid),
        name: getCol(row, 'Journey Name') || '(no name)',
        status: getCol(row, 'Version Status') || 'Unknown',
        start: getCol(row, 'Journey Start Time') || '',
        published: getCol(row, 'Version Published on') || '',
        entry_type: getCol(row, 'Version Entry Type') || '',
        reentry: String(getCol(row, 'Re-entry Allowed') || ''),
        creator: (getCol(row, 'Version Created by') || '').split('@')[0],
        total_nodes: Number(getCol(row, 'Number of Nodes in the version') || 0),
        nodes: [],
        goals: [],
        _source: row.__source,
      });
    }
    const j = journeyMap.get(jid);
    const nodeType = getCol(row, 'Node Type');
    if (nodeType === 'message') {
      let msg = String(getCol(row, 'Campaign Message') || '').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ');
      if (msg.length > 400) msg = msg.slice(0, 400).trim() + '…';
      const channel = (
        getCol(row, ' Channel / Segment / Controller Type') ||
        getCol(row, 'Channel / Segment / Controller Type') ||
        ''
      ).trim();
      j.nodes.push({
        node_id: row.__nid,
        name: getCol(row, 'Campaign / Segment / Controller Name') || '',
        channel,
        delay: getCol(row, 'Delay before Node') || '',
        connector: getCol(row, 'Connector from Previous') || '',
        sent:        row['Total Sent'],
        delivered:   row['Total Delivered'],
        viewed:      row['Total Viewed'],
        clicked:     row['Total Clicked'],
        converted:   row['Unique Converted within Conversion Time'],
        influenced:  row['Influenced Conversions'],
        inf_rev:     row['Influenced Revenue'],
        message:     msg || '(no copy)',
      });
    }
    // Goals are journey-level — collect once, on the first row that has any
    if (j.goals.length === 0) {
      for (const i of [1, 2, 3]) {
        const gn = getCol(row, `Goal ${i} Name`);
        const gc = getCol(row, `Goal ${i} Conversions`);
        // CleverTap writes literal "N/A" / "NA" / "" for unset goals — treat those as missing
        const gnStr = (gn == null ? '' : String(gn)).trim();
        if (gnStr && gnStr.toUpperCase() !== 'N/A' && gnStr.toUpperCase() !== 'NA') {
          j.goals.push({ name: gnStr, conv: toNum(gc) });
        }
      }
    }
  }

  // -- 6. Aggregate channel + totals per journey --
  for (const j of journeyMap.values()) {
    j.by_channel = classifyJourneyChannels(j.nodes);
    j.msg_nodes = j.nodes.length;
    j.totals = {
      sent:       j.nodes.reduce((a, n) => a + (n.sent || 0), 0),
      delivered:  j.nodes.reduce((a, n) => a + (n.delivered || 0), 0),
      viewed:     j.nodes.reduce((a, n) => a + (n.viewed || 0), 0),
      clicked:    j.nodes.reduce((a, n) => a + (n.clicked || 0), 0),
      converted:  j.nodes.reduce((a, n) => a + (n.converted || 0), 0),
      influenced: j.nodes.reduce((a, n) => a + (n.influenced || 0), 0),
      inf_rev:    j.nodes.reduce((a, n) => a + (n.inf_rev || 0), 0),
    };
  }

  return Array.from(journeyMap.values()).sort((a, b) => a.id - b.id);
}


/* ====================================================================
   E. FILE UPLOAD HANDLING
   ==================================================================== */

async function handleFiles(fileList) {
  const files = Array.from(fileList).filter(f =>
    f.name.toLowerCase().endsWith('.csv') || f.type === 'text/csv'
  );
  if (files.length === 0) {
    toast('No CSV files in that drop. Try again.', 'error');
    return;
  }

  toast(`Parsing ${files.length} file${files.length>1?'s':''}…`, 'info', 2500);

  try {
    const parsed = await Promise.all(files.map(parseCsvFile));
    const journeys = processRawRows(parsed);
    if (journeys.length === 0) {
      toast('No journeys found in those files.', 'error');
      return;
    }
    state.mode = 'uploaded';
    state.files = parsed.map(p => ({ name: p.name, rowCount: p.rows.length }));
    state.journeys = journeys;
    state.loadedAt = new Date().toISOString();
    save();
    renderAll();
    toast(`Loaded ${journeys.length} journeys from ${files.length} file${files.length>1?'s':''}.`, 'success', 4000);
  } catch (err) {
    console.error(err);
    toast(err.message || 'Error parsing files.', 'error', 7000);
  }
}


/* ====================================================================
   F. DRAG-DROP OVERLAY + BUTTONS
   ==================================================================== */

let dragCounter = 0;

window.addEventListener('dragenter', e => {
  e.preventDefault();
  dragCounter++;
  if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) {
    document.getElementById('drop-overlay').classList.add('active');
  }
});
window.addEventListener('dragover', e => e.preventDefault());
window.addEventListener('dragleave', e => {
  e.preventDefault();
  dragCounter--;
  if (dragCounter <= 0) {
    dragCounter = 0;
    document.getElementById('drop-overlay').classList.remove('active');
  }
});
window.addEventListener('drop', e => {
  e.preventDefault();
  dragCounter = 0;
  document.getElementById('drop-overlay').classList.remove('active');
  if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
    handleFiles(e.dataTransfer.files);
  }
});

document.getElementById('upload-btn').addEventListener('click', () => {
  document.getElementById('file-input').click();
});

document.getElementById('file-input').addEventListener('change', e => {
  if (e.target.files && e.target.files.length) handleFiles(e.target.files);
  e.target.value = '';   // allow re-uploading the same file
});

document.getElementById('reset-btn').addEventListener('click', () => {
  if (!confirm('Reset to the Hair / Stage 2 demo data? Your uploaded data will be cleared from local storage.')) return;
  state.mode = 'demo';
  state.files = [];
  state.journeys = window.DEMO_DATA || [];
  state.loadedAt = null;
  save();
  renderAll();
  toast('Reset to demo data.', 'info', 3000);
});

document.getElementById('export-btn').addEventListener('click', () => {
  const data = JSON.stringify(state.journeys, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = state.mode === 'demo'
    ? 'demo_journeys.json'
    : `journeys_export_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Downloaded deduped JSON.', 'success', 3000);
});


/* ====================================================================
   G. RENDERING — DATASET BAR
   ==================================================================== */

function renderDatasetBar() {
  const modeEl   = document.getElementById('dataset-mode');
  const filesEl  = document.getElementById('dataset-files');
  const countsEl = document.getElementById('dataset-counts');
  const resetBtn = document.getElementById('reset-btn');

  if (state.mode === 'demo') {
    modeEl.textContent = 'DEMO';
    modeEl.classList.remove('uploaded');
    filesEl.textContent = 'Hair / Stage 2 sample data (5 source CSV files)';
    resetBtn.style.display = 'none';
  } else {
    modeEl.textContent = 'UPLOADED';
    modeEl.classList.add('uploaded');
    const fileNames = state.files.map(f => f.name).join(' · ');
    filesEl.textContent = fileNames;
    filesEl.title = fileNames;
    resetBtn.style.display = '';
  }
  const nMsgNodes = state.journeys.reduce((a, j) => a + (j.msg_nodes || 0), 0);
  countsEl.textContent = `${state.journeys.length} journeys · ${nMsgNodes} message nodes`;
}


/* ====================================================================
   H. RENDERING — OVERVIEW TAB
   ==================================================================== */

function renderTopline() {
  const grid = document.getElementById('topline-grid');
  const note = document.getElementById('topline-note');

  if (state.journeys.length === 0) {
    grid.innerHTML = '<div class="empty-state"><strong>No data loaded.</strong>Drop CSV files anywhere on this page, or click "+ Load CSV files" in the bar above.</div>';
    note.textContent = '';
    return;
  }

  const totals = state.journeys.reduce((a, j) => {
    a.sent       += j.totals.sent;
    a.delivered  += j.totals.delivered;
    a.viewed     += j.totals.viewed;
    a.converted  += j.totals.converted;
    a.influenced += j.totals.influenced;
    a.inf_rev    += j.totals.inf_rev;
    return a;
  }, { sent:0, delivered:0, viewed:0, converted:0, influenced:0, inf_rev:0 });

  const nRunning    = state.journeys.filter(j => j.status === 'Running').length;
  const nPaused     = state.journeys.filter(j => j.status === 'Paused').length;
  const nRestricted = state.journeys.filter(j => j.status === 'Restricted').length;
  const nOther      = state.journeys.length - nRunning - nPaused - nRestricted;

  grid.innerHTML = `
    <div class="topline-card hero">
      <div class="label">Influenced Revenue</div>
      <div class="value">${totals.inf_rev ? '₹' + (totals.inf_rev/10000000).toFixed(2) + '<span class="unit"> Cr</span>' : '–'}</div>
      <div class="note">Lifetime, all journeys, attributed (direct + assist)</div>
    </div>
    <div class="topline-card">
      <div class="label">Messages Sent</div>
      <div class="value">${totals.sent ? (totals.sent/1000000).toFixed(2) + '<span class="unit"> M</span>' : '–'}</div>
      <div class="note">All channels combined (incl. webhook fires)</div>
    </div>
    <div class="topline-card">
      <div class="label">Influenced Conversions</div>
      <div class="value">${fmt(totals.influenced)}</div>
      <div class="note">${fmt(totals.converted)} direct (within conversion window)</div>
    </div>
    <div class="topline-card">
      <div class="label">Delivered (WA + SMS)</div>
      <div class="value">${fmt(totals.delivered)}</div>
      <div class="note">Push delivery isn't exported by CleverTap</div>
    </div>
    <div class="topline-card">
      <div class="label">Viewed / Impressions</div>
      <div class="value">${fmt(totals.viewed)}</div>
      <div class="note">Push impressions + WhatsApp read receipts</div>
    </div>
    <div class="topline-card">
      <div class="label">Status</div>
      <div class="value">${nRunning}<span class="unit"> / ${state.journeys.length}</span></div>
      <div class="note">${nRunning} running · ${nPaused} paused · ${nRestricted} restricted${nOther ? ' · ' + nOther + ' other' : ''}</div>
    </div>
  `;
  note.innerHTML = `Numbers are <strong>lifetime totals</strong> since each journey was published. A journey running for 2 years and one running for 3 months are not directly comparable on absolute volume.`;
}

function renderStatusTable() {
  const tbody = document.querySelector('#status-table tbody');
  if (state.journeys.length === 0) { tbody.innerHTML = ''; return; }
  const buckets = {};
  for (const j of state.journeys) {
    const s = j.status || 'Unknown';
    if (!buckets[s]) buckets[s] = { count:0, sent:0, conv:0, inf:0, rev:0 };
    buckets[s].count++;
    buckets[s].sent += j.totals.sent;
    buckets[s].conv += j.totals.converted;
    buckets[s].inf  += j.totals.influenced;
    buckets[s].rev  += j.totals.inf_rev;
  }
  const order = ['Running', 'Restricted', 'Paused', 'Draft', 'Unknown'];
  const rows = Object.keys(buckets).sort((a, b) =>
    (order.indexOf(a) >= 0 ? order.indexOf(a) : 99) - (order.indexOf(b) >= 0 ? order.indexOf(b) : 99)
  );
  tbody.innerHTML = rows.map(s => `
    <tr>
      <td><span class="pill ${s.toLowerCase()}">${s}</span></td>
      <td class="num">${buckets[s].count}</td>
      <td class="num">${fmt(buckets[s].sent)}</td>
      <td class="num">${fmt(buckets[s].conv)}</td>
      <td class="num">${fmt(buckets[s].inf)}</td>
      <td class="num">${fmtCr(buckets[s].rev)}</td>
    </tr>
  `).join('');
}

function renderTopPerformers() {
  const revTbody = document.querySelector('#top-rev-table tbody');
  const cvrTbody = document.querySelector('#top-cvr-table tbody');
  if (state.journeys.length === 0) {
    revTbody.innerHTML = '';
    cvrTbody.innerHTML = '';
    return;
  }

  const byRev = [...state.journeys].sort((a, b) => b.totals.inf_rev - a.totals.inf_rev).slice(0, 10);
  revTbody.innerHTML = byRev.map(j => `
    <tr>
      <td class="id">${j.id}</td>
      <td>${escapeHTML(j.name)}</td>
      <td><span class="pill ${j.status.toLowerCase()}">${j.status}</span></td>
      <td class="num">${fmt(j.totals.sent)}</td>
      <td class="num">${fmt(j.totals.converted)}</td>
      <td class="num">${fmt(j.totals.influenced)}</td>
      <td class="num">${fmtLakh(j.totals.inf_rev)}</td>
    </tr>
  `).join('');

  const byCvr = state.journeys
    .filter(j => j.totals.delivered >= 1000)
    .map(j => ({ ...j, cvr: j.totals.converted / j.totals.delivered }))
    .sort((a, b) => b.cvr - a.cvr)
    .slice(0, 10);

  if (byCvr.length === 0) {
    cvrTbody.innerHTML = `<tr><td colspan="6" class="small" style="text-align:center; padding: 20px;">No journeys with ≥ 1,000 WhatsApp/SMS delivered in this dataset.</td></tr>`;
  } else {
    cvrTbody.innerHTML = byCvr.map(j => `
      <tr>
        <td class="id">${j.id}</td>
        <td>${escapeHTML(j.name)}</td>
        <td><span class="pill ${j.status.toLowerCase()}">${j.status}</span></td>
        <td class="num">${fmt(j.totals.delivered)}</td>
        <td class="num">${fmt(j.totals.converted)}</td>
        <td class="num">${(j.cvr*100).toFixed(2)}%</td>
      </tr>
    `).join('');
  }
}


/* ====================================================================
   I. RENDERING — JOURNEYS TAB
   ==================================================================== */

function renderChannelCard(channel, d) {
  let keyRate = '', rows = '';
  if (channel === 'WhatsApp') {
    rows = `
      <div class="ch-row"><span class="k">Sent</span><span class="v">${fmt(d.sent)}</span></div>
      <div class="ch-row"><span class="k">Delivered</span><span class="v">${fmt(d.delivered)}</span></div>
      <div class="ch-row"><span class="k">Read</span><span class="v">${fmt(d.viewed)}</span></div>
      <div class="ch-row"><span class="k">Conv</span><span class="v">${fmt(d.converted)}</span></div>`;
    keyRate = `Del ${pct(d.delivered, d.sent)} · Read ${pct(d.viewed, d.delivered)} · CVR ${pct(d.converted, d.delivered, 2)}`;
  } else if (channel === 'Push') {
    rows = `
      <div class="ch-row"><span class="k">Sent</span><span class="v">${fmt(d.sent)}</span></div>
      <div class="ch-row"><span class="k">Impressions</span><span class="v">${fmt(d.viewed)}</span></div>
      <div class="ch-row"><span class="k">Clicked</span><span class="v">${fmt(d.clicked)}</span></div>
      <div class="ch-row"><span class="k">Conv</span><span class="v">${fmt(d.converted)}</span></div>`;
    keyRate = `Impr ${pct(d.viewed, d.sent)} · CTR ${pct(d.clicked, d.viewed, 2)} · CVR ${pct(d.converted, d.sent, 2)}`;
  } else if (channel === 'SMS') {
    rows = `
      <div class="ch-row"><span class="k">Sent</span><span class="v">${fmt(d.sent)}</span></div>
      <div class="ch-row"><span class="k">Delivered</span><span class="v">${fmt(d.delivered)}</span></div>
      <div class="ch-row"><span class="k">Conv</span><span class="v">${fmt(d.converted)}</span></div>`;
    keyRate = `Del ${pct(d.delivered, d.sent)} · CVR ${pct(d.converted, d.delivered, 2)}`;
  } else {
    rows = `
      <div class="ch-row"><span class="k">Fired</span><span class="v">${fmt(d.sent)}</span></div>
      <div class="ch-row"><span class="k">Nodes</span><span class="v">${d.nodes}</span></div>`;
    keyRate = 'Background action — no comm';
  }
  return `
    <div class="ch-card">
      <div class="ch-name">${channel} · ${d.nodes} node${d.nodes>1?'s':''}</div>
      ${rows}
      <div class="ch-key">${keyRate}</div>
    </div>
  `;
}

function nodeMetricsLine(n) {
  const ch = n.channel;
  if (ch === 'WhatsApp')
    return `Sent <span class="v">${fmt(n.sent)}</span> <span class="arrow">→</span> Del <span class="v">${fmt(n.delivered)}</span> <span class="pct">(${pct(n.delivered,n.sent)})</span> <span class="arrow">→</span> Read <span class="v">${fmt(n.viewed)}</span> <span class="pct">(${pct(n.viewed,n.delivered)})</span> <span class="arrow">→</span> Conv <span class="v">${fmt(n.converted)}</span> <span class="pct">(${pct(n.converted,n.delivered,2)})</span>  ·  Influenced <span class="v">${fmt(n.influenced)}</span>`;
  if (ch === 'Push')
    return `Sent <span class="v">${fmt(n.sent)}</span> <span class="arrow">→</span> Impr <span class="v">${fmt(n.viewed)}</span> <span class="pct">(${pct(n.viewed,n.sent)})</span> <span class="arrow">→</span> Click <span class="v">${fmt(n.clicked)}</span> <span class="pct">(${pct(n.clicked,n.viewed,2)})</span> <span class="arrow">→</span> Conv <span class="v">${fmt(n.converted)}</span> <span class="pct">(${pct(n.converted,n.sent,2)})</span>  ·  Influenced <span class="v">${fmt(n.influenced)}</span>`;
  if (ch === 'SMS')
    return `Sent <span class="v">${fmt(n.sent)}</span> <span class="arrow">→</span> Del <span class="v">${fmt(n.delivered)}</span> <span class="pct">(${pct(n.delivered,n.sent)})</span> <span class="arrow">→</span> Conv <span class="v">${fmt(n.converted)}</span>  ·  Influenced <span class="v">${fmt(n.influenced)}</span>`;
  if (ch === 'Webhook')
    return `Fired <span class="v">${fmt(n.sent)}</span> times — background action, no comm sent`;
  return `Sent <span class="v">${fmt(n.sent)}</span>`;
}

function summarize(j) {
  const channels = Object.keys(j.by_channel);
  const chList = channels.length ? channels.map(c => `${j.by_channel[c].nodes} ${c}`).join(', ') : 'no message nodes';

  let statusLine;
  if (j.status === 'Running' && j.totals.sent === 0) {
    statusLine = '<strong>Running but has never sent.</strong> Likely cause: entry condition is broken or no customers match it. ';
  } else if (j.status === 'Paused') {
    statusLine = `<strong>Paused.</strong> Lifetime total: ${fmt(j.totals.sent)} sends to date. `;
  } else if (j.status === 'Restricted') {
    statusLine = `<strong>Restricted</strong> — can\'t accept new entries. Lifetime total: ${fmt(j.totals.sent)} sends. `;
  } else {
    statusLine = `${j.status}. Lifetime total: <strong>${fmt(j.totals.sent)} messages sent</strong>. `;
  }

  let perfLine = '';
  if (j.totals.delivered > 0) {
    const cvr = (j.totals.converted / j.totals.delivered * 100).toFixed(1);
    perfLine = `Direct conversions: <strong>${fmt(j.totals.converted)}</strong> (${cvr}% of WA/SMS delivered). Influenced: <strong>${fmt(j.totals.influenced)}</strong>, attributed to <strong>${fmtCr(j.totals.inf_rev)}</strong> in revenue.`;
  } else if (j.totals.sent > 0 && j.totals.influenced > 0) {
    perfLine = `Influenced <strong>${fmt(j.totals.influenced)}</strong> conversions worth <strong>${fmtCr(j.totals.inf_rev)}</strong>.`;
  } else if (j.totals.sent > 0) {
    perfLine = `No purchase tracking populated (typical for webhook / background-action journeys).`;
  }

  return `${statusLine}Uses ${chList}. ${perfLine}`;
}

function renderJourneyCard(j) {
  const channelPills = Object.entries(j.by_channel).map(([c, d]) =>
    `<span class="pill channel ${c.toLowerCase()}">${c} ${d.nodes}</span>`
  ).join('');

  const channelCards = Object.entries(j.by_channel).map(([c, d]) => renderChannelCard(c, d)).join('');

  const goals = (j.goals && j.goals.length)
    ? `<div class="goals"><b>Goals tracked:</b> ${j.goals.map((g, i) => `Goal ${i+1}: ${escapeHTML(g.name)} (${fmt(g.conv)})`).join('  ·  ')}</div>`
    : '<div class="goals"><b>Goals tracked:</b> none configured</div>';

  const nodesHtml = j.nodes.map((n, idx) => {
    const chClass = (n.channel || '').toLowerCase();
    const copyBlock = n.channel === 'Webhook' ? '' : `<div class="copy">${escapeHTML(n.message || '')}</div>`;
    return `
      <div class="node ${chClass}">
        <div class="head-line">
          <span class="nn">${String(idx+1).padStart(2,'0')}</span>
          <span class="pill channel ${chClass}">${n.channel || '—'}</span>
          <span class="nname">${escapeHTML(n.name)}</span>
          <span class="meta">delay: ${escapeHTML(n.delay || '—')} · path: ${escapeHTML(n.connector || '—')}</span>
        </div>
        <div class="metrics">${nodeMetricsLine(n)}</div>
        ${copyBlock}
      </div>
    `;
  }).join('') || '<div class="small" style="padding: 12px 0;">No message nodes in this journey.</div>';

  return `
    <div class="journey" data-id="${j.id}" data-status="${j.status}">
      <div class="head">
        <span class="chev">▶</span>
        <span class="jid">J-${j.id}</span>
        <span class="jname">${escapeHTML(j.name)}</span>
        <span class="pill ${j.status.toLowerCase()}">${j.status}</span>
        <span class="quick">
          <span>${channelPills}</span>
          <span>Sent <b>${fmt(j.totals.sent)}</b></span>
          <span>Conv <b>${fmt(j.totals.converted)}</b></span>
          <span>Inf ₹ <b>${fmtLakh(j.totals.inf_rev)}</b></span>
        </span>
      </div>
      <div class="body">
        <div class="summary-box">${summarize(j)}</div>
        <div class="meta">
          <b>Owner:</b> ${escapeHTML(j.creator || '—')}  ·  
          <b>Started:</b> ${escapeHTML(j.start || '—')}  ·  
          <b>Entry type:</b> ${escapeHTML(j.entry_type || '—')}  ·  
          <b>Re-entry allowed:</b> ${escapeHTML(j.reentry || '—')}  ·  
          <b>${j.total_nodes} total nodes</b> (${j.msg_nodes} message)
        </div>
        ${Object.keys(j.by_channel).length ? `<div class="channel-grid">${channelCards}</div>` : ''}
        ${goals}
        <div class="nodes-title">Every message in this journey (in order)</div>
        ${nodesHtml}
      </div>
    </div>
  `;
}

let journeyFilter = 'all';
let journeyQuery = '';

function renderJourneys() {
  const container = document.getElementById('journeys-list');
  if (state.journeys.length === 0) {
    container.innerHTML = '<div class="empty-state"><strong>No journeys loaded.</strong>Drop CSV files anywhere on this page to load data.</div>';
    return;
  }

  const sorted = [...state.journeys].sort((a, b) => {
    if (a.status !== b.status) {
      const order = { Running: 0, Restricted: 1, Paused: 2 };
      return (order[a.status] ?? 9) - (order[b.status] ?? 9);
    }
    return b.totals.sent - a.totals.sent;
  });

  const q = journeyQuery.toLowerCase();
  const filtered = sorted.filter(j => {
    if (journeyFilter !== 'all' && j.status !== journeyFilter) return false;
    if (q && !j.name.toLowerCase().includes(q) && !String(j.id).includes(q)) return false;
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state">No journeys match your filter.</div>';
    return;
  }

  container.innerHTML = filtered.map(renderJourneyCard).join('');
}

document.getElementById('j-search').addEventListener('input', e => {
  journeyQuery = e.target.value;
  renderJourneys();
});

document.querySelectorAll('[data-j-filter]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-j-filter]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    journeyFilter = btn.dataset.jFilter;
    renderJourneys();
  });
});

document.getElementById('expand-all-btn').addEventListener('click', () => {
  document.querySelectorAll('#journeys-list .journey').forEach(j => j.classList.add('open'));
});
document.getElementById('collapse-all-btn').addEventListener('click', () => {
  document.querySelectorAll('#journeys-list .journey').forEach(j => j.classList.remove('open'));
});

document.addEventListener('click', e => {
  const head = e.target.closest('.journey > .head');
  if (head) head.parentElement.classList.toggle('open');
});


/* ====================================================================
   J. RENDERING — DATA QUALITY TAB
   Uses the rules defined in flags.js (loaded as window.FLAG_RULES).
   ==================================================================== */

function generateFlags() {
  if (!window.FLAG_RULES) return [];
  const flags = [];
  for (const rule of window.FLAG_RULES) {
    try {
      const result = rule(state.journeys);
      if (result) flags.push(result);
    } catch (e) {
      console.error('Flag rule error:', rule.name, e);
    }
  }
  return flags;
}

function renderFlags() {
  const container = document.getElementById('flags-list');
  if (state.journeys.length === 0) {
    container.innerHTML = '<div class="empty-state"><strong>No data loaded.</strong>Drop CSV files anywhere on this page to load data.</div>';
    return;
  }
  const flags = generateFlags();
  if (flags.length === 0) {
    container.innerHTML = '<div class="empty-state"><strong>No quality flags raised.</strong>Looks clean! (Or the rules haven\'t caught anything in this dataset.)</div>';
    return;
  }
  container.innerHTML = flags.map(f => {
    const list = f.journeys.slice(0, 30).map(j => `
      <div class="jrow"><strong>J-${j.id}</strong> · ${escapeHTML(j.name)} · ${j.status} · sent ${fmt(j.totals.sent)}</div>
    `).join('');
    const more = f.journeys.length > 30 ? `<div class="jrow small">… and ${f.journeys.length - 30} more</div>` : '';
    return `
      <div class="flag ${f.type}">
        <div class="lbl">${f.label}</div>
        <h4>${f.title}</h4>
        <p class="desc">${f.desc}</p>
        <div class="journey-list">${list}${more}</div>
      </div>
    `;
  }).join('');
}


/* ====================================================================
   K. RENDERING — TABS AND DISPATCH
   ==================================================================== */

function renderTabs() {
  document.getElementById('tabs').innerHTML = TABS.map((t, i) => {
    let count = '';
    if (t.id === 'journeys') count = `<span class="count">${state.journeys.length}</span>`;
    if (t.id === 'quality') {
      const n = generateFlags().length;
      count = n ? `<span class="count">${n}</span>` : '';
    }
    return `<button class="tab ${i===0?'active':''}" data-tab="${t.id}">${t.label}${count}</button>`;
  }).join('');
  document.querySelectorAll('.tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
}

function switchTab(id) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === id));
  document.querySelectorAll('.tabpanel').forEach(p => p.classList.toggle('active', p.dataset.tab === id));
  window.scrollTo({ top: 0, behavior: 'instant' });
  history.replaceState(null, '', '#' + id);
}

function renderAll() {
  renderTabs();
  renderDatasetBar();
  renderTopline();
  renderStatusTable();
  renderTopPerformers();
  renderJourneys();
  renderFlags();
}


/* ====================================================================
   L. INIT
   ==================================================================== */

loadFromStorage();
renderAll();
const initial = (location.hash || '#about').slice(1);
if (TABS.find(t => t.id === initial)) switchTab(initial);
else switchTab('about');
