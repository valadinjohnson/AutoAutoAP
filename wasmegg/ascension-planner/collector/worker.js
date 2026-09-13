/**
 * Cloudflare Worker: collects chain-search submissions and serves the leaderboard.
 *
 * Deploy this and point the app's `VITE_SUBMIT_URL` at `https://<worker>/submit`. Everything
 * lives in one Worker plus one KV namespace, because the whole dataset is a few thousand small
 * JSON objects and reaching for a database would be borrowing trouble.
 *
 *   POST /submit       one submission, validated, stored, rate-limited by IP
 *   GET  /leaderboard  ?final=490&limit=50  -> the best chain per submitter
 *   GET  /all          everything, for anyone who wants to do their own analysis
 *   GET  /             the leaderboard page (see leaderboard.html)
 *
 * VALIDATION IS DUPLICATED ON PURPOSE. `validateSubmission` in src/search/submission.ts is the
 * same ruleset, and the app runs it before sending -- but a public endpoint cannot trust that
 * the thing posting to it is the app. The rules are kept identical by being short enough to read
 * side by side; if they drift, the Worker's copy is the one that matters.
 *
 * WHAT THIS DELIBERATELY DOES NOT STORE. No IP addresses beyond an in-memory rate-limit key that
 * expires, no headers, no cookies, nothing derived from the connection. A submission is what the
 * player chose to send and nothing more. If you change that, change the consent text in the app
 * to match -- people agreed to a specific list.
 *
 * Setup:
 *   wrangler kv namespace create SUBMISSIONS
 *   # put the returned id in wrangler.toml, then:
 *   wrangler deploy
 */

const SCHEMA = 1;

/** Same rules as src/search/submission.ts. Returns the problems; empty means acceptable. */
function validateSubmission(s) {
  const problems = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['not an object'];
  if (s.schema !== SCHEMA) problems.push(`unknown schema ${String(s.schema)}`);
  if (!Array.isArray(s.chain) || s.chain.length < 2) {
    problems.push('chain must have at least two entries');
  } else {
    if (!s.chain.every(v => Number.isInteger(v) && v > 0)) problems.push('chain must be positive integers');
    if (!s.chain.every((v, i) => i === 0 || v > s.chain[i - 1])) problems.push('chain must strictly increase');
  }
  if (typeof s.durationDays !== 'number' || !(s.durationDays > 0)) problems.push('durationDays must be positive');
  if (typeof s.finalTE !== 'number' || !(s.finalTE > 0)) problems.push('finalTE must be positive');
  if (s.nickname !== undefined && (typeof s.nickname !== 'string' || s.nickname.length > 40)) {
    problems.push('nickname must be a string of at most 40 characters');
  }
  return problems;
}

/** A player id is a bearer token for the whole save. One must never be stored here even if
 *  someone posts one by hand, so the serialised body is swept before it is written. */
function scrub(value) {
  return JSON.parse(JSON.stringify(value).replace(/EI\d{16}/g, 'EI[redacted]'));
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json;charset=utf-8', ...CORS },
  });

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

    // ------------------------------------------------------------------ submit
    if (url.pathname === '/submit' && request.method === 'POST') {
      // Cheap flood guard. One submission per IP per minute is far above what a human doing this
      // by hand needs, and the key expires so nothing about the address is retained.
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const gateKey = `gate:${ip}`;
      if (await env.SUBMISSIONS.get(gateKey)) {
        return json({ error: 'slow down - one submission per minute' }, 429);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }

      const problems = validateSubmission(body);
      if (problems.length) return json({ error: 'rejected', problems }, 400);

      const record = scrub(body);
      // Keyed by finalTE then duration then a random suffix: KV lists lexicographically, so this
      // makes "best chains for a 490 target" a prefix scan in sorted order rather than a full
      // read-and-sort. Duration is zero-padded so 9.5 does not sort above 100.
      const dur = String(Math.round(record.durationDays * 10000)).padStart(10, '0');
      const id = crypto.randomUUID().slice(0, 8);
      await env.SUBMISSIONS.put(`sub:${record.finalTE}:${dur}:${id}`, JSON.stringify(record));
      await env.SUBMISSIONS.put(gateKey, '1', { expirationTtl: 60 });

      return json({ ok: true, id });
    }

    // --------------------------------------------------------------- the CSV
    // A run's full working -- every chain, one row per leg -- is megabytes, so it goes to R2
    // rather than KV and it goes as its own request. The JSON submission is the thing that must
    // land; this is the bulky optional half, and losing it must never cost the headline result.
    //
    // R2 is OPTIONAL. With no CSVS binding this answers 501 and the app reports "the CSV was
    // refused" while still counting the submission as sent, which is the honest outcome for a
    // collector that was only ever configured for the summaries.
    if (url.pathname === '/csv' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      if (!id || !/^[a-f0-9-]{4,40}$/.test(id)) return json({ error: 'bad id' }, 400);
      if (!env.CSVS) return json({ error: 'no CSV storage configured on this collector' }, 501);

      const body = await request.text();
      if (!body.length) return json({ error: 'empty body' }, 400);
      if (body.length > 40 * 1024 * 1024) return json({ error: 'CSV too large' }, 413);
      // Same sweep as the JSON path. A CSV never carried a player id, but a hand-made one might.
      const clean = body.replace(/EI\d{16}/g, 'EI[redacted]');
      await env.CSVS.put(`csv/${id}.csv`, clean, {
        httpMetadata: { contentType: 'text/csv; charset=utf-8' },
      });
      return json({ ok: true, bytes: clean.length });
    }

    if (url.pathname === '/csv' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id || !/^[a-f0-9-]{4,40}$/.test(id)) return json({ error: 'bad id' }, 400);
      if (!env.CSVS) return json({ error: 'no CSV storage configured' }, 501);
      const obj = await env.CSVS.get(`csv/${id}.csv`);
      if (!obj) return json({ error: 'not found' }, 404);
      return new Response(obj.body, {
        headers: { 'content-type': 'text/csv;charset=utf-8', ...CORS },
      });
    }

    // ------------------------------------------------------------- leaderboard
    if (url.pathname === '/leaderboard' || url.pathname === '/all') {
      const final = url.searchParams.get('final');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const prefix = final ? `sub:${final}:` : 'sub:';

      // Already in duration order thanks to the key, so this is a scan and not a sort.
      const list = await env.SUBMISSIONS.list({ prefix, limit: url.pathname === '/all' ? 1000 : limit * 4 });
      const rows = [];
      for (const k of list.keys) {
        const raw = await env.SUBMISSIONS.get(k.name);
        if (raw) rows.push(JSON.parse(raw));
      }

      if (url.pathname === '/all') return json({ count: rows.length, rows });

      // One row per submitter, best only: without this a single player running the search ten
      // times owns the whole board, which tells nobody anything.
      const seen = new Set();
      const best = [];
      for (const r of rows) {
        const who = r.nickname || 'anonymous';
        const key = `${who}:${r.finalTE}`;
        if (who !== 'anonymous' && seen.has(key)) continue;
        seen.add(key);
        best.push(r);
        if (best.length >= limit) break;
      }
      return json({ count: best.length, rows: best });
    }

    // -------------------------------------------------------------------- page
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(LEADERBOARD_HTML, {
        headers: { 'content-type': 'text/html;charset=utf-8', ...CORS },
      });
    }

    return json({ error: 'not found' }, 404);
  },
};

// The page is inlined so the Worker is a single file with no build step and no asset hosting.
// It is small, it has no dependencies, and it reads the same endpoints documented above.
const LEADERBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Ascension chain leaderboard</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --fg:#1e293b; --mut:#64748b; --line:#e2e8f0; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f172a; --fg:#e2e8f0; --mut:#94a3b8; --line:#1e293b; --card:#111c33; }
  }
  body { margin:0; background:var(--bg); color:var(--fg);
         font:14px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; }
  .wrap { max-width:70rem; margin:0 auto; padding:2rem 1rem 4rem; }
  h1 { font-size:1.5rem; margin:0 0 .25rem; }
  p.sub { color:var(--mut); margin:0 0 1.5rem; }
  .controls { display:flex; gap:.75rem; align-items:end; flex-wrap:wrap; margin-bottom:1rem; }
  label { display:block; font-size:.65rem; font-weight:800; letter-spacing:.1em;
          text-transform:uppercase; color:var(--mut); margin-bottom:.25rem; }
  select,input { padding:.4rem .6rem; border:1px solid var(--line); border-radius:.5rem;
                 background:var(--card); color:var(--fg); font-weight:700; }
  table { width:100%; border-collapse:collapse; background:var(--card);
          border:1px solid var(--line); border-radius:.75rem; overflow:hidden; }
  th { text-align:left; font-size:.65rem; letter-spacing:.1em; text-transform:uppercase;
       color:var(--mut); padding:.6rem .75rem; border-bottom:1px solid var(--line); }
  td { padding:.6rem .75rem; border-bottom:1px solid var(--line); }
  tr:last-child td { border-bottom:0; }
  .chain { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-weight:700; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .muted { color:var(--mut); }
  .note { margin-top:1.25rem; color:var(--mut); font-size:.8rem; }
  .empty { padding:2rem; text-align:center; color:var(--mut); }
  .scroll { overflow-x:auto; }
  details.upload { margin:1.25rem 0 0; padding:.75rem 1rem; background:var(--card);
                   border:1px solid var(--line); border-radius:.75rem; }
  details.upload summary { cursor:pointer; font-weight:800; font-size:.8rem; }
  details.upload p { color:var(--mut); font-size:.8rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Ascension chain leaderboard</h1>
  <p class="sub">Fastest chains submitted by players, one entry per person.</p>

  <div class="controls">
    <div>
      <label for="final">Target TE</label>
      <select id="final"><option value="">all</option></select>
    </div>
    <div>
      <label for="limit">Rows</label>
      <input id="limit" type="number" min="5" max="200" value="50" />
    </div>
  </div>

  <div class="scroll"><table>
    <thead><tr>
      <th>#</th><th>Who</th><th>Chain</th><th class="num">Ascensions</th>
      <th class="num">Days</th><th>Finishes</th><th class="num">Waiting</th>
      <th>Window</th><th>Effort</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="9" class="empty">Loading…</td></tr></tbody>
  </table></div>

  <details class="upload">
    <summary>Upload a saved result</summary>
    <p>
      Saved a result to disk instead of submitting it? Drop the JSON here. This is the same
      endpoint the app posts to, so a file saved on a machine with no network reaches the board
      from any machine that has one.
    </p>
    <input id="file" type="file" accept="application/json,.json" multiple />
    <span id="upstatus" class="muted"></span>
  </details>

  <p class="note">
    <strong>Durations are not directly comparable.</strong> A chain's length depends on the account's
    artifacts, research and starting TE as much as on the chain, and on whether the run was
    constrained to the player's waking hours. Read this as "what shapes are winning for people",
    not as a ranking of players. <em>Waiting</em> is the time the plan spends held for the player's
    schedule; blank means the submission carried no per-leg detail, which is not the same as zero.
  </p>
</div>

<script>
const rowsEl = document.getElementById('rows');
const finalEl = document.getElementById('final');
const limitEl = document.getElementById('limit');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);

async function load() {
  const q = new URLSearchParams();
  if (finalEl.value) q.set('final', finalEl.value);
  q.set('limit', limitEl.value || '50');
  rowsEl.innerHTML = '<tr><td colspan="9" class="empty">Loading…</td></tr>';
  try {
    const res = await fetch('/leaderboard?' + q);
    const data = await res.json();
    if (!data.rows || !data.rows.length) {
      rowsEl.innerHTML = '<tr><td colspan="9" class="empty">Nothing submitted yet.</td></tr>';
      return;
    }
    rowsEl.innerHTML = data.rows.map((r, i) => \`
      <tr>
        <td class="muted">\${i + 1}</td>
        <td>\${esc(r.nickname || 'anonymous')}</td>
        <td class="chain">\${esc((r.chain || []).join(' '))}</td>
        <td class="num">\${esc(r.ascensions)}</td>
        <td class="num">\${Number(r.durationDays).toFixed(3)}</td>
        <td class="muted">\${esc(r.endLocal || '')}</td>
        <td class="num">\${r.waitingHours == null ? '<span class="muted">—</span>' : Number(r.waitingHours).toFixed(1) + ' h'}</td>
        <td class="muted">\${esc(r.window || 'no schedule')}</td>
        <td class="muted">\${esc(r.effort || '')}</td>
      </tr>\`).join('');
    // Populate the target filter from what has actually been submitted.
    if (finalEl.options.length === 1) {
      for (const te of [...new Set(data.rows.map(r => r.finalTE))].sort((a, b) => a - b)) {
        finalEl.add(new Option(te, te));
      }
    }
  } catch (e) {
    rowsEl.innerHTML = '<tr><td colspan="9" class="empty">Could not load: ' + esc(e.message) + '</td></tr>';
  }
}
finalEl.onchange = load;
limitEl.onchange = load;

// Uploading a file saved offline. Posts to the same /submit the app uses, so the Worker's
// validation applies identically -- there is no second, looser path into the dataset.
document.getElementById('file').onchange = async ev => {
  const status = document.getElementById('upstatus');
  const files = [...ev.target.files];
  let ok = 0;
  const fails = [];
  for (const f of files) {
    try {
      const body = await f.text();
      const res = await fetch('/submit', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      if (res.ok) ok++;
      else {
        const err = await res.json().catch(() => ({}));
        fails.push(f.name + ': ' + (err.problems ? err.problems.join('; ') : res.status));
      }
    } catch (e) {
      fails.push(f.name + ': ' + e.message);
    }
  }
  status.textContent = ok + ' accepted' + (fails.length ? ', ' + fails.length + ' rejected - ' + fails.join(' | ') : '');
  if (ok) load();
};

load();
</script>
</body>
</html>`;
