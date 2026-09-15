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
 * WHAT THIS DELIBERATELY DOES NOT STORE. No IP addresses beyond a rate-limit key that lives in
 * KV under a 60-second TTL and is never read back into any record, no headers, no cookies,
 * nothing derived from the connection. A submission is what the
 * player chose to send and nothing more. If you change that, change the consent text in the app
 * to match -- people agreed to a specific list.
 *
 * Setup:
 *   wrangler kv namespace create SUBMISSIONS
 *   # put the returned id in wrangler.toml, then:
 *   wrangler deploy
 */

// 2: `artifacts` became a list of labels (best piece per family) instead of `{label, count}` for
// every tier owned; see src/search/submission.ts. Rows already in KV at schema 1 keep their old
// shape and the page renders both -- a stored row is history, not something to migrate.
const SCHEMA = 3;

/**
 * Bounds on everything countable.
 *
 * These are not guesses about malice so much as the values past which a submission stops
 * describing a plan anybody ran: a real chain is single digits of ascensions and a real answer
 * is a few hundred days.
 *
 * DURATION_DAYS is the one that is load-bearing rather than tidy. The KV key embeds
 * `round(days * 10000)` zero-padded to ten characters so that listing a prefix returns the board
 * already in duration order. A value large enough to need an eleventh character -- or large
 * enough that `String()` renders it in exponential form -- sorts ABOVE every genuine entry and
 * takes the top of the leaderboard. Measured before this cap existed: `durationDays: 1e24` was
 * accepted and stored as `sub:490:000001e+28:...`, first in the scan. 100000 days is 274 years,
 * far past any real plan, and `100000 * 10000` is exactly ten digits.
 */
const MAX = {
  CHAIN: 64,
  LEGS: 64,
  ARTIFACTS: 64,
  STONES: 64,
  /** Timezone, effort, window, the two local stamps. */
  TEXT: 64,
  NICKNAME: 40,
  DURATION_DAYS: 100000,
  TE: 1000000,
  /** Gzipped CSV bytes. 8 MB compressed is roughly 180 MB of raw CSV at the ~23x this data
   *  achieves -- far past the largest run anyone has produced, and still inside KV's 25 MB
   *  per-value ceiling with margin for data that compresses worse than measured. */
  CSV_BYTES: 8 * 1024 * 1024,
  /** A virtue loadout is four artifacts with at most three stones each; the caps are generous
   *  rather than exact so a future game change does not silently truncate a real set. */
  LOADOUT_SLOTS: 8,
  LOADOUT_STONES: 8,
  /** Per address, per minute. Enough to post every result of a sitting; far short of a script. */
  SUBMITS_PER_MINUTE: 10,
};

/** Same rules as src/search/submission.ts. Returns the problems; empty means acceptable. */
function validateSubmission(s) {
  const problems = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return ['not an object'];
  if (s.schema !== SCHEMA) problems.push(`unknown schema ${String(s.schema)}`);
  if (!Array.isArray(s.chain) || s.chain.length < 2) {
    problems.push('chain must have at least two entries');
  } else if (s.chain.length > MAX.CHAIN) {
    problems.push(`chain must have at most ${MAX.CHAIN} entries`);
  } else {
    if (!s.chain.every(v => Number.isInteger(v) && v > 0 && v <= MAX.TE)) {
      problems.push('chain must be positive integers within range');
    }
    if (!s.chain.every((v, i) => i === 0 || v > s.chain[i - 1])) problems.push('chain must strictly increase');
  }
  // Number.isFinite, not `> 0`: Infinity passes a `> 0` test and then poisons the sort key.
  if (!Number.isFinite(s.durationDays) || s.durationDays <= 0 || s.durationDays > MAX.DURATION_DAYS) {
    problems.push(`durationDays must be positive and at most ${MAX.DURATION_DAYS}`);
  }
  if (!Number.isFinite(s.finalTE) || s.finalTE <= 0 || s.finalTE > MAX.TE) {
    problems.push(`finalTE must be positive and at most ${MAX.TE}`);
  }
  if (s.nickname !== undefined && (typeof s.nickname !== 'string' || s.nickname.length > MAX.NICKNAME)) {
    problems.push(`nickname must be a string of at most ${MAX.NICKNAME} characters`);
  }
  for (const [field, cap] of [
    ['legs', MAX.LEGS],
    ['artifacts', MAX.ARTIFACTS],
    ['stones', MAX.STONES],
  ]) {
    if (s[field] !== undefined && (!Array.isArray(s[field]) || s[field].length > cap)) {
      problems.push(`${field} must be an array of at most ${cap} entries`);
    }
  }
  if (s.artifacts !== undefined && Array.isArray(s.artifacts) && !s.artifacts.every(a => typeof a === 'string')) {
    problems.push('artifacts must be a list of labels');
  }
  return problems;
}

/** A player id is a bearer token for the whole save. One must never be stored here even if
 *  someone posts one by hand, so text is swept on the way in. */
function scrubText(s) {
  return String(s).replace(/EI\d{16}/g, 'EI[redacted]');
}

const text = (v, max) => (typeof v === 'string' ? scrubText(v).slice(0, max) : undefined);
const num = v => (Number.isFinite(v) ? v : undefined);
const flag = v => (typeof v === 'boolean' ? v : undefined);
/** `label`/`count` pairs, the shape both artifacts and stones use. */
const counts = (v, cap) =>
  Array.isArray(v)
    ? v.slice(0, cap).map(a => ({ label: text(a?.label, MAX.TEXT) ?? '', count: num(a?.count) ?? 0 }))
    : undefined;
/** A solved loadout: up to four slots, each an artifact label and the stones socketed in it. */
const loadout = v =>
  Array.isArray(v)
    ? v.slice(0, MAX.LOADOUT_SLOTS).map(slot =>
        defined({
          artifact: text(slot?.artifact, MAX.TEXT),
          stones: Array.isArray(slot?.stones)
            ? slot.stones.slice(0, MAX.LOADOUT_STONES).map(x => text(x, MAX.TEXT) ?? '')
            : undefined,
        })
      )
    : undefined;

/** Drop keys whose value came back undefined, so a missing field is absent rather than null. */
const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));

/**
 * Build the stored record by WHITELIST, the same way the app builds what it sends.
 *
 * `validateSubmission` answers whether a body is acceptable; this answers what is kept. They are
 * separate because a public endpoint faces a question the app never does -- what to do with
 * fields nobody asked for. Storing the posted object verbatim, which is what scrubbing a body
 * amounts to, turns an open write endpoint into free hosting for whatever someone wants to put
 * in front of the people reading `/all`. Measured before this existed: a POST carrying a 5 KB
 * `evilPayload` string was stored and served back in full. A fresh object with a fixed field
 * list cannot carry anything not named here.
 *
 * Unknown fields are DROPPED, not rejected. A newer app that adds a field bumps SCHEMA, and an
 * unrecognised schema is already refused above; within a schema, silence is the forgiving
 * choice and matches how src/search/submission.ts treats the CSV it builds from.
 */
/**
 * Run cost, bounded. Same whitelist discipline as everything else here: a field is rebuilt from
 * named keys with sane ranges rather than trusted, because these numbers are going into an
 * average and one `1e9` would move it for everyone.
 */
function runCost(r) {
  if (!r || typeof r !== 'object') return undefined;
  const workers = num(r.workers);
  const minutes = num(r.minutes);
  const perChain = num(r.secondsPerChain);
  const cores = r.cores === null || r.cores === undefined ? null : num(r.cores);
  if (workers === undefined || minutes === undefined || perChain === undefined) return undefined;
  if (workers < 1 || workers > 256) return undefined;
  if (minutes < 0 || minutes > 60 * 24 * 30) return undefined;
  if (perChain < 0 || perChain > 3600) return undefined;
  if (cores !== null && (cores === undefined || cores < 1 || cores > 256)) return undefined;
  return { workers, cores, minutes, secondsPerChain: perChain };
}

function pickSubmission(s) {
  return defined({
    schema: SCHEMA,
    nickname: s.nickname ? text(s.nickname, MAX.NICKNAME) : undefined,

    chain: s.chain.slice(0, MAX.CHAIN),
    ascensions: num(s.ascensions),
    durationDays: s.durationDays,
    startLocal: text(s.startLocal, MAX.TEXT),
    endLocal: text(s.endLocal, MAX.TEXT),
    timezone: text(s.timezone, MAX.TEXT),

    currentTE: num(s.currentTE),
    finalTE: s.finalTE,

    effort: text(s.effort, MAX.TEXT),
    window: s.window === null ? null : text(s.window, MAX.TEXT),
    holdShifts: flag(s.holdShifts),
    waitingHours: s.waitingHours === null ? null : num(s.waitingHours),

    // Labels, not counts: an artifact slot takes one artifact, so how many are owned never
    // mattered, and exact counts of a whole hoard are a far sharper fingerprint than the handful
    // that decided the answer. Stones keep their counts -- see the app's `bestPerFamily`.
    artifacts: Array.isArray(s.artifacts)
      ? s.artifacts.slice(0, MAX.ARTIFACTS).map(a => text(a, MAX.TEXT) ?? '')
      : undefined,
    // The two sets the simulator wears, per slot. Additive since schema 2 -- an older app sends
    // neither and the row simply has none, which cannot be misread as an empty loadout because
    // the field is absent rather than `[]`.
    delivery: loadout(s.delivery),
    earnings: loadout(s.earnings),
    stones: counts(s.stones, MAX.STONES),

    // Additive in schema 3: what the run cost the machine that did it, so the panel's time
    // estimate can eventually be fitted against real hardware instead of quoting one 20-core
    // desktop at everybody. Absent from older clients and from checkpoint replays, and `defined`
    // drops the key entirely in that case rather than storing a zeroed row.
    run: runCost(s.run),

    legs: Array.isArray(s.legs)
      ? s.legs.slice(0, MAX.LEGS).map(l =>
          defined({
            te: num(l?.te),
            strategy: text(l?.strategy, MAX.TEXT),
            days: num(l?.days),
            peakDeliveryQph: num(l?.peakDeliveryQph),
          })
        )
      : undefined,
    chainsPriced: num(s.chainsPriced),
    submittedAt: text(s.submittedAt, MAX.TEXT),
  });
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
      // Flood guard, as a small burst rather than a hard one-per-minute.
      //
      // One per minute was not "far above what a human needs" after all: comparing effort tiers,
      // or two chain shapes, means submitting several results back to back, and the old gate made
      // the second one fail with a message that read like the collector was broken. A burst
      // covers a person emptying their results; it still stops a script.
      //
      // The window is carried in the value rather than leaned on KV's TTL, because updating a key
      // to count a submission would otherwise reset its expiry and turn a fixed minute into a
      // window that never closes while someone keeps posting.
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      const gateKey = `gate:${ip}`;
      const now = Date.now();
      let gate = null;
      try {
        gate = JSON.parse((await env.SUBMISSIONS.get(gateKey)) || 'null');
      } catch {
        gate = null;
      }
      if (!gate || typeof gate.until !== 'number' || gate.until <= now) {
        gate = { n: 0, until: now + 60000 };
      }
      if (gate.n >= MAX.SUBMITS_PER_MINUTE) {
        return json({ error: `slow down - at most ${MAX.SUBMITS_PER_MINUTE} submissions a minute` }, 429);
      }
      gate.n++;

      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'body must be JSON' }, 400);
      }

      const problems = validateSubmission(body);
      if (problems.length) return json({ error: 'rejected', problems }, 400);

      const record = pickSubmission(body);
      // Keyed by finalTE then duration then a random suffix: KV lists lexicographically, so this
      // makes "best chains for a 490 target" a prefix scan in sorted order rather than a full
      // read-and-sort. Duration is zero-padded so 9.5 does not sort above 100.
      const dur = String(Math.round(record.durationDays * 10000)).padStart(10, '0');
      const id = crypto.randomUUID().slice(0, 8);
      await env.SUBMISSIONS.put(`sub:${record.finalTE}:${dur}:${id}`, JSON.stringify(record));
      // TTL is longer than the window so a stale counter cannot outlive it and lock anyone out;
      // the `until` inside decides, and the TTL only keeps the address from being retained.
      await env.SUBMISSIONS.put(gateKey, JSON.stringify(gate), { expirationTtl: 120 });

      return json({ ok: true, id });
    }

    // --------------------------------------------------------------- the CSV
    // A run's full working -- every chain, one row per leg -- is megabytes, so it goes as its own
    // request. The JSON submission is the thing that must land; this is the bulky optional half,
    // and losing it must never cost the headline result.
    //
    // GZIPPED, AND COMPRESSED BY THE BROWSER, NOT HERE. Measured on real output: 11,000 chains is
    // 15.3 MB raw and 0.66 MB gzipped, about 23x, because the file is repetitive numeric text.
    // That fits KV's 25 MB per-value limit with room to spare, which is why this needs no R2 and
    // no payment method on the account.
    //
    // The compression happens client-side for a reason that is not just upload speed: the free
    // Workers plan allows ~10ms of CPU per request, and compressing 15 MB here would blow through
    // it. The Worker stores the bytes it is handed.
    //
    // CONSEQUENCE, STATED PLAINLY: the `EI\d{16}` sweep that runs on the JSON path cannot run on
    // an opaque gzip stream without decompressing it, which is the CPU cost we just avoided. So
    // the sweep moved into the app, which scrubs before compressing (see exportCsv). This is
    // belt-and-braces either way -- `buildChainsCsv` has no playerId in its metadata and never
    // printed one -- but the guarantee is now enforced one step upstream, and a hand-made gzip
    // posted directly is NOT swept. It is still capped and still has to be valid gzip.
    if (url.pathname === '/csv' && request.method === 'POST') {
      const id = url.searchParams.get('id');
      if (!id || !/^[a-f0-9-]{4,40}$/.test(id)) return json({ error: 'bad id' }, 400);

      const body = await request.arrayBuffer();
      if (!body.byteLength) return json({ error: 'empty body' }, 400);
      if (body.byteLength > MAX.CSV_BYTES) {
        return json({ error: `CSV too large (${body.byteLength} bytes gzipped, limit ${MAX.CSV_BYTES})` }, 413);
      }
      // Gzip magic. Rejects a raw CSV posted by an older build, which would otherwise be stored
      // and then served with a Content-Encoding the bytes do not have -- a file that downloads
      // and will not open, which is worse than a clear refusal.
      const head = new Uint8Array(body.slice(0, 2));
      if (head[0] !== 0x1f || head[1] !== 0x8b) {
        return json({ error: 'body must be gzip (the app compresses before sending)' }, 400);
      }

      await env.SUBMISSIONS.put(`csv:${id}`, body);
      return json({ ok: true, bytes: body.byteLength });
    }

    if (url.pathname === '/csv' && request.method === 'GET') {
      const id = url.searchParams.get('id');
      if (!id || !/^[a-f0-9-]{4,40}$/.test(id)) return json({ error: 'bad id' }, 400);
      const buf = await env.SUBMISSIONS.get(`csv:${id}`, 'arrayBuffer');
      if (!buf) return json({ error: 'not found' }, 404);
      // Served as a GZIP FILE, not as a gzip-encoded CSV. The difference is not pedantry: the
      // obvious version -- `content-type: text/csv` plus `content-encoding: gzip`, letting the
      // browser inflate on arrival -- is broken by the CDN in front of this Worker. Cloudflare
      // sees a compressible content-type and compresses the response itself, so the body on the
      // wire becomes gzip(gzip(csv)) with only one layer declared. The client strips the declared
      // layer and saves the inner gzip under a .csv name: a file that downloads and will not open.
      // Confirmed against the deployed Worker -- `file` reported the download as gzip whose
      // recorded original size was exactly the COMPRESSED length we uploaded.
      //
      // `application/gzip` is not on the edge's compressible list, so the bytes pass through
      // untouched, and a .csv.gz is a thing every operating system already opens. No decompression
      // here either way, for the CPU reason above.
      return new Response(buf, {
        headers: {
          'content-type': 'application/gzip',
          'content-disposition': `attachment; filename="chains-${id}.csv.gz"`,
          ...CORS,
        },
      });
    }

    // ------------------------------------------------------------- leaderboard
    if (url.pathname === '/leaderboard' || url.pathname === '/all') {
      const final = url.searchParams.get('final');
      const limit = Math.min(Number(url.searchParams.get('limit')) || 50, 200);
      const prefix = final ? `sub:${final}:` : 'sub:';

      // Already in duration order thanks to the key, so this is a scan and not a sort.
      const list = await env.SUBMISSIONS.list({ prefix, limit: url.pathname === '/all' ? 1000 : limit * 4 });
      // Concurrently, not in an awaited loop: these are independent reads of a few hundred keys,
      // and serialising them multiplies one KV round trip by the page size for no reason.
      // Promise.all preserves order, which matters -- the key order IS the ranking.
      // Which submissions have a CSV stored. ONE list call for the whole page, rather than a
      // per-row existence check: the alternative is N extra KV reads to answer a yes/no the key
      // space already encodes. The id is the last segment of a submission key and the whole of a
      // `csv:` key, so the two line up without storing a flag on the record -- which would have
      // meant a read-modify-write on every CSV upload, and writes are the scarce quota here.
      const csvIds = new Set(
        (await env.SUBMISSIONS.list({ prefix: 'csv:', limit: 1000 })).keys.map(k => k.name.slice(4))
      );
      const raws = await Promise.all(list.keys.map(k => env.SUBMISSIONS.get(k.name)));
      const rows = [];
      list.keys.forEach((k, i) => {
        const raw = raws[i];
        if (!raw) return;
        // One unparseable value must not take the whole board down with it.
        try {
          const row = JSON.parse(raw);
          // Derived from the key, never stored: it is already in the key, and a second copy is a
          // second thing that can disagree.
          row.id = k.name.slice(k.name.lastIndexOf(':') + 1);
          row.hasCsv = csvIds.has(row.id);
          rows.push(row);
        } catch {
          /* skip */
        }
      });

      if (url.pathname === '/all') return json({ count: rows.length, rows });

      // Collapse RE-RUNS, not different experiments.
      //
      // This used to key on nickname plus target, so one person got exactly one row per target
      // and everything else they sent was silently dropped from the board. That threw away the
      // answers to the questions the board exists to ask: whether the effort tiers behave the
      // same everywhere, whether a chain shape that wins on one account wins on another, what a
      // schedule actually costs. Submitting 195 219 248 490 at `thorough` and 180 490 at
      // `balanced` is two results, and showing one of them is worse than showing neither --
      // the reader cannot tell that the other was ever tried.
      //
      // So the key is everything that makes a run a different experiment. Two submissions that
      // agree on all of it are the same run priced twice -- a re-run after a restart, the same
      // plan from a slightly different start -- and the faster one stands for both. Duration is
      // deliberately NOT in the key: two runs of the same chain are the same experiment even
      // when they land a few hours apart.
      //
      // ANONYMOUS IS NEVER COLLAPSED, because it is not an identity. Two anonymous submitters
      // who happen to have tried the same chain at the same effort are two people, and deduping
      // them would delete one player's result on the strength of a name they declined to give.
      const seen = new Set();
      const best = [];
      for (const r of rows) {
        const who = r.nickname || '';
        if (who) {
          const key = [
            who,
            r.finalTE,
            (r.chain || []).join('-'),
            r.effort || '',
            r.window || '',
            r.holdShifts ? 'hold' : 'free',
          ].join('|');
          if (seen.has(key)) continue;
          seen.add(key);
        }
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
//
// NOT String.raw, and that is not a style choice. The page's own script builds rows with a
// template literal, so its backticks and `${...}` have to be escaped to survive being nested
// inside this one. String.raw keeps backslashes verbatim, which shipped `=> \`` and `\${i + 1}`
// as literal text into the served HTML -- a SyntaxError on the first line of the inline script,
// killing the whole thing. The page then sat on "Loading…" forever with the API working fine
// underneath it. A cooked literal resolves those escapes to the backtick and `${` the page
// needs. These escapes are the only backslashes in the block, so nothing else changes meaning.
const LEADERBOARD_HTML = `<!doctype html>
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
  tr.row { cursor:pointer; }
  tr.row:hover td { background:color-mix(in srgb, var(--fg) 4%, transparent); }
  tr.row.open td { background:color-mix(in srgb, var(--fg) 6%, transparent); }
  .caret { display:inline-block; width:.8rem; color:var(--mut); }
  td.detail { padding:0 .75rem 1rem; }
  .detail-grid { display:grid; gap:1rem; grid-template-columns:repeat(auto-fit,minmax(15rem,1fr)); }
  .detail h3 { font-size:.62rem; letter-spacing:.1em; text-transform:uppercase;
               color:var(--mut); margin:.25rem 0 .4rem; }
  .kv { font-size:.8rem; }
  .kv div { display:flex; justify-content:space-between; gap:1rem; padding:.1rem 0; }
  .kv span:first-child { color:var(--mut); }
  .legs { font-size:.75rem; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .legs div { padding:.1rem 0; }
  a.csv { display:inline-block; margin-top:.5rem; font-size:.75rem; font-weight:800; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Ascension chain leaderboard</h1>
  <p class="sub">Fastest chains submitted by players, one entry per person. Click a row for the
    artifacts, stones and per-leg detail it was simulated with.</p>

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
      <th></th><th>#</th><th>Who</th><th>Chain</th><th class="num">Ascensions</th>
      <th class="num">Days</th><th>Finishes</th><th class="num">Waiting</th>
      <th>Window</th><th>Effort</th>
    </tr></thead>
    <tbody id="rows"><tr><td colspan="10" class="empty">Loading…</td></tr></tbody>
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
  rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Loading…</td></tr>';
  try {
    const res = await fetch('/leaderboard?' + q);
    const data = await res.json();
    if (!data.rows || !data.rows.length) {
      rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Nothing submitted yet.</td></tr>';
      return;
    }
    // Two rows per entry: the summary, and a detail row that starts hidden. Same shape as the
    // planner's own runner-up table, so the two read alike.
    rowsEl.innerHTML = data.rows.map((r, i) => \`
      <tr class="row" data-i="\${i}">
        <td class="caret">›</td>
        <td class="muted">\${i + 1}</td>
        <td>\${esc(r.nickname || 'anonymous')}</td>
        <td class="chain">\${esc((r.chain || []).join(' '))}</td>
        <td class="num">\${esc(r.ascensions)}</td>
        <td class="num">\${Number(r.durationDays).toFixed(3)}</td>
        <td class="muted">\${esc(r.endLocal || '')}</td>
        <td class="num">\${r.waitingHours == null ? '<span class="muted">—</span>' : Number(r.waitingHours).toFixed(1) + ' h'}</td>
        <td class="muted">\${esc(r.window || 'no schedule')}</td>
        <td class="muted">\${esc(r.effort || '')}</td>
      </tr>
      <tr class="detail" data-detail="\${i}" hidden>
        <td class="detail" colspan="10">\${detail(r)}</td>
      </tr>\`).join('');
    // Populate the target filter from what has actually been submitted.
    if (finalEl.options.length === 1) {
      for (const te of [...new Set(data.rows.map(r => r.finalTE))].sort((a, b) => a - b)) {
        finalEl.add(new Option(te, te));
      }
    }
  } catch (e) {
    rowsEl.innerHTML = '<tr><td colspan="10" class="empty">Could not load: ' + esc(e.message) + '</td></tr>';
  }
}
// What the row was simulated with. Counts are capped by the app before sending, so a number at
// the cap means "that many or more" -- rendered as such rather than as a precise-looking figure.
function counts(list) {
  if (!list || !list.length) return '<div class="muted">none recorded</div>';
  // Two shapes on purpose. Schema 2 sends artifacts as bare labels -- an artifact slot takes one
  // artifact, so the count said nothing -- while stones keep counts because how many you hold
  // decides what can be socketed. Rows stored under schema 1 are still objects and still render.
  return list.map(a =>
    typeof a === 'string'
      ? \`<div><span>\${esc(a)}</span><span></span></div>\`
      : \`<div><span>\${esc(a.label)}</span><span>\${esc(a.count)}</span></div>\`).join('');
}

// A solved loadout, per slot, with the stones inside each artifact. The fourth DELIVERY slot is
// picked as a stone holder -- a T3 legendary ankh beats a T4 epic chalice because sockets matter
// more than the base effect -- so the stones are the part that makes the set legible.
// The fallback argument renders the bare inventory for rows submitted before loadouts existed.
// (No backticks in comments in here: this whole page is itself inside a template literal.)
function sets(slots, fallback) {
  if (!slots || !slots.length) {
    if (fallback) return '<div class="kv">' + counts(fallback) + '</div>';
    return '<div class="muted">not recorded</div>';
  }
  return slots.map(s =>
    \`<div style="margin-bottom:.35rem">
        <div style="font-weight:700">\${esc(s.artifact)}</div>
        <div class="muted" style="margin-left:.6rem">\${
          (s.stones || []).length ? esc((s.stones || []).join(', ')) : 'no stones'
        }</div>
      </div>\`).join('');
}

function detail(r) {
  const legs = (r.legs || []).length
    ? r.legs.map((l, k) =>
        \`<div>A\${k + 1} → \${esc(l.te)}  \${esc(l.strategy || '')}  \${Number(l.days).toFixed(2)} d  \${Number(l.peakDeliveryQph).toFixed(2)} q/hr</div>\`
      ).join('')
    : '<div class="muted">no per-leg detail — this chain was replayed from a saved checkpoint</div>';
  const csv = r.hasCsv
    ? \`<a class="csv" href="/csv?id=\${encodeURIComponent(r.id)}">Download the full CSV (.csv.gz) ↓</a>\`
    : '<div class="muted" style="margin-top:.5rem;font-size:.75rem">No CSV was attached to this run.</div>';
  return \`<div class="detail-grid">
      <div><h3>Run</h3><div class="kv">
        <div><span>Starting TE</span><span>\${esc(r.currentTE)}</span></div>
        <div><span>Target TE</span><span>\${esc(r.finalTE)}</span></div>
        <div><span>Plan starts</span><span>\${esc(r.startLocal || '—')}</span></div>
        <div><span>Chains priced</span><span>\${esc(r.chainsPriced ?? '—')}</span></div>
        <div><span>Shifts held</span><span>\${r.holdShifts ? 'yes' : 'no'}</span></div>
      </div>\${csv}</div>
      <div><h3>Delivery set</h3>\${sets(r.delivery, r.artifacts)}</div>
      <div><h3>Earnings set</h3>\${sets(r.earnings, null)}</div>
      <div><h3>Stones</h3><div class="kv">\${counts(r.stones)}</div></div>
      <div><h3>Legs</h3><div class="legs">\${legs}</div></div>
    </div>\`;
}

// Delegated, because the rows are replaced wholesale on every load and per-row listeners would
// leak with them.
rowsEl.onclick = ev => {
  const tr = ev.target.closest('tr.row');
  if (!tr) return;
  const detailRow = rowsEl.querySelector('tr[data-detail="' + tr.dataset.i + '"]');
  if (!detailRow) return;
  const opening = detailRow.hidden;
  detailRow.hidden = !opening;
  tr.classList.toggle('open', opening);
  tr.querySelector('.caret').textContent = opening ? '⌄' : '›';
};

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
