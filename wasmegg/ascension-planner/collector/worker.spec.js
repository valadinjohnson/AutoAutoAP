/**
 * End-to-end tests for the collector Worker.
 *
 * `worker.js` is a single file with no build step and no dependencies, so a plain `Map` standing
 * in for KV exercises it the whole way through -- validation, the whitelist, the rate limit, the
 * duration ordering, the ID sweep. No wrangler, no network, no account.
 *
 * The cases that are not obvious are the ones that were found by probing the Worker before it
 * was ever deployed, and each would have been invisible until someone abused it:
 *
 *   - a body carrying unknown fields was stored verbatim and served back from /all;
 *   - `durationDays: 1e24` was accepted and keyed as `sub:490:000001e+28:...`, sorting ABOVE
 *     every real entry and taking the top of the leaderboard;
 *   - `Infinity` passed a `> 0` check for the same reason.
 *
 * The last test is the one that matters most in the other direction: hardening the ingest must
 * not quietly drop a field a genuine submission depends on.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import worker from './worker.js';

/** KV, as far as this Worker is concerned: get, put with an ignored TTL, prefix list in key order. */
function makeKV() {
  const m = new Map();
  return {
    _m: m,
    async get(k) {
      return m.has(k) ? m.get(k) : null;
    },
    async put(k, v) {
      m.set(k, v);
    },
    async list({ prefix, limit }) {
      const keys = [...m.keys()]
        .filter(k => k.startsWith(prefix))
        .sort()
        .slice(0, limit);
      return { keys: keys.map(name => ({ name })) };
    },
  };
}

let env;
beforeEach(() => {
  env = { SUBMISSIONS: makeKV() };
});

const post = (path, body, ip = '1.1.1.1') =>
  worker.fetch(
    new Request('https://collector.test' + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'cf-connecting-ip': ip },
      body: JSON.stringify(body),
    }),
    env
  );

const get = path => worker.fetch(new Request('https://collector.test' + path), env);

const stored = () =>
  [...env.SUBMISSIONS._m.entries()].filter(([k]) => k.startsWith('sub:')).map(([k, v]) => [k, JSON.parse(v)]);

const MINIMAL = { schema: 3, chain: [195, 490], durationDays: 700, finalTE: 490 };

/** A submission with every field the app actually builds (see src/search/submission.ts). */
const FULL = {
  schema: 3,
  nickname: 'Jordan',
  chain: [195, 219, 248, 286, 327, 490],
  ascensions: 6,
  durationDays: 741.965,
  startLocal: '2026-09-04 18:51',
  endLocal: '2028-09-15 11:02',
  timezone: 'America/Denver',
  currentTE: 120,
  finalTE: 490,
  effort: 'balanced',
  window: '08:00-23:00 daily',
  holdShifts: true,
  waitingHours: 412.5,
  artifacts: ['T4L Quantum metronome', 'T4L Lunar totem'],
  stones: [{ label: 'T4 Tachyon stone', count: 40 }],
  legs: [{ te: 195, strategy: '2-sale-tier13', days: 70.2, peakDeliveryQph: 12.5 }],
  run: { workers: 12, cores: 20, minutes: 65.3, secondsPerChain: 2.36 },
  epicResearch: { maxed: true, atMax: 36, total: 36, short: [] },
  colleggtibles: { maxed: false, byTier: [4, 0, 1, 2, 7], total: 14, short: ['carbon T3'] },
  chainsPriced: 11000,
  submittedAt: '2026-09-13T23:00:00.000Z',
};

describe('ingest is a whitelist, not a scrub', () => {
  it('drops fields nobody asked for rather than storing them', async () => {
    const res = await post('/submit', { ...MINIMAL, evilPayload: 'X'.repeat(5000), note: 'arbitrary text' });
    expect(res.status).toBe(200);
    const [, record] = stored()[0];
    expect(record).not.toHaveProperty('evilPayload');
    expect(record).not.toHaveProperty('note');
  });

  it('keeps every field of a genuine submission byte for byte', async () => {
    expect((await post('/submit', FULL)).status).toBe(200);
    const board = await (await get('/leaderboard?final=490')).json();
    const row = board.rows.find(r => r.nickname === 'Jordan');
    for (const [key, value] of Object.entries(FULL)) {
      expect(row[key], `field ${key}`).toEqual(value);
    }
  });
});

describe('bounds', () => {
  it('refuses a chain longer than any real one', async () => {
    const chain = Array.from({ length: 50000 }, (_, i) => i + 1);
    expect((await post('/submit', { ...MINIMAL, chain })).status).toBe(400);
  });

  it('refuses oversized inventories', async () => {
    const artifacts = Array.from({ length: 20000 }, () => 'Y'.repeat(200));
    expect((await post('/submit', { ...MINIMAL, artifacts })).status).toBe(400);
  });

  // The sort key is `round(days * 10000)` padded to ten characters. A value needing an eleventh
  // character, or rendering as `1e+28`, sorts above every genuine entry.
  it.each([1e24, Infinity, -1, 0, NaN])('refuses durationDays %p', async durationDays => {
    expect((await post('/submit', { ...MINIMAL, durationDays })).status).toBe(400);
  });

  it('keeps a real duration first in the key space', async () => {
    await post('/submit', { ...MINIMAL, nickname: 'slow', durationDays: 900 }, '2.2.2.2');
    await post('/submit', { ...MINIMAL, nickname: 'fast', durationDays: 600 }, '3.3.3.3');
    const board = await (await get('/leaderboard?final=490')).json();
    const days = board.rows.map(r => r.durationDays);
    expect(days).toEqual([...days].sort((a, b) => a - b));
    expect(board.rows[0].nickname).toBe('fast');
  });
});

describe('what never gets stored', () => {
  it('sweeps a player id out of free text', async () => {
    await post('/submit', { ...MINIMAL, nickname: 'EI1234567890123456' });
    const dump = JSON.stringify(await (await get('/all')).json());
    expect(dump).not.toContain('EI1234567890123456');
    expect(dump).toContain('EI[redacted]');
  });

  it('keeps no trace of the submitter address in the record', async () => {
    await post('/submit', MINIMAL, '203.0.113.7');
    expect(JSON.stringify(stored())).not.toContain('203.0.113.7');
  });
});

describe('rate limit', () => {
  // A burst, not one-per-minute: comparing effort tiers means posting several results back to
  // back, and the old gate failed the second one with a message that read like a broken server.
  it('allows a burst from one address, then refuses', async () => {
    for (let i = 0; i < 10; i++) {
      expect((await post('/submit', { ...MINIMAL, nickname: `n${i}` }, '4.4.4.4')).status).toBe(200);
    }
    const over = await post('/submit', MINIMAL, '4.4.4.4');
    expect(over.status).toBe(429);
    expect((await over.json()).error).toMatch(/slow down/);
  });

  it('counts each address separately', async () => {
    for (let i = 0; i < 10; i++) await post('/submit', { ...MINIMAL, nickname: `a${i}` }, '4.4.4.4');
    expect((await post('/submit', MINIMAL, '4.4.4.4')).status).toBe(429);
    expect((await post('/submit', MINIMAL, '5.5.5.5')).status).toBe(200);
  });

  it('survives a corrupt gate value instead of locking the address out', async () => {
    await env.SUBMISSIONS.put('gate:6.6.6.6', 'not json');
    expect((await post('/submit', MINIMAL, '6.6.6.6')).status).toBe(200);
  });
});

describe('the board keeps different experiments, and collapses re-runs', () => {
  const run = (over, ip) =>
    post(
      '/submit',
      {
        ...MINIMAL,
        nickname: 'Willsalt',
        chain: [195, 490],
        effort: 'balanced',
        window: null,
        holdShifts: true,
        ...over,
      },
      ip
    );

  it("keeps one person's runs at different effort tiers", async () => {
    await run({ effort: 'balanced', durationDays: 700 }, '1.1.1.1');
    await run({ effort: 'thorough', durationDays: 690 }, '1.1.1.1');
    const board = await (await get('/leaderboard?final=490')).json();
    expect(board.rows.map(r => r.effort).sort()).toEqual(['balanced', 'thorough']);
  });

  it("keeps one person's different chain shapes", async () => {
    await run({ chain: [195, 490], durationDays: 700 }, '1.1.1.1');
    await run({ chain: [180, 220, 490], durationDays: 705 }, '1.1.1.1');
    const board = await (await get('/leaderboard?final=490')).json();
    expect(board.rows).toHaveLength(2);
  });

  it('keeps a scheduled run beside the same chain run unconstrained', async () => {
    await run({ window: null, durationDays: 700 }, '1.1.1.1');
    await run({ window: 'every day 09:00-23:00 America/Denver', durationDays: 740 }, '1.1.1.1');
    const board = await (await get('/leaderboard?final=490')).json();
    expect(board.rows).toHaveLength(2);
  });

  it('collapses a genuine re-run to the faster one', async () => {
    // Same chain, same effort, same schedule -- the same experiment priced twice. Duration is
    // deliberately not part of the identity, so these are one row and the quicker stands.
    await run({ durationDays: 700 }, '1.1.1.1');
    await run({ durationDays: 690 }, '1.1.1.1');
    const board = await (await get('/leaderboard?final=490')).json();
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0].durationDays).toBe(690);
  });

  it('never collapses anonymous submissions, which are not one person', async () => {
    await run({ nickname: undefined, durationDays: 700 }, '1.1.1.1');
    await run({ nickname: undefined, durationDays: 701 }, '2.2.2.2');
    const board = await (await get('/leaderboard?final=490')).json();
    expect(board.rows).toHaveLength(2);
  });
});

describe('the leaderboard page', () => {
  // This is the test that would have caught the page being dead on arrival. The API was fine
  // the whole time; the inlined script had `\${...}` in it as literal text, because the template
  // holding it was String.raw, and a SyntaxError on line one meant the table never left
  // "Loading…". Compiling the script is a real parse, not a string match for the old mistake --
  // `new Function` compiles the body without running it, so `document` is never touched.
  it('serves an inline script that actually parses', async () => {
    const html = await (await get('/')).text();
    const script = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(script, 'page should carry an inline script').not.toBeNull();
    expect(() => new Function(script[1])).not.toThrow();
  });

  it('serves HTML at the root', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});

describe('artifacts are labels, stones are counted', () => {
  it('refuses the old {label, count} shape for artifacts', async () => {
    const res = await post('/submit', { ...MINIMAL, artifacts: [{ label: 'T4L Gusset', count: 3 }] });
    expect(res.status).toBe(400);
    expect((await res.json()).problems.join(' ')).toMatch(/labels/);
  });

  it('keeps stone counts', async () => {
    await post('/submit', { ...MINIMAL, stones: [{ label: 'T4 Lunar stone', count: 8 }] });
    const [, record] = stored()[0];
    expect(record.stones).toEqual([{ label: 'T4 Lunar stone', count: 8 }]);
  });
});

describe('solved loadouts', () => {
  const SET = [
    { artifact: 'T4E Quantum metronome', stones: ['T4 Tachyon stone', 'T4 Tachyon stone'] },
    { artifact: 'T3L Tungsten ankh', stones: ['T4 Tachyon stone', 'T4 Tachyon stone', 'T4 Tachyon stone'] },
  ];

  it('stores both sets with their stones intact', async () => {
    await post('/submit', { ...MINIMAL, delivery: SET, earnings: SET });
    const [, record] = stored()[0];
    expect(record.delivery).toEqual(SET);
    expect(record.earnings).toEqual(SET);
  });

  it('leaves them absent rather than empty when a submission has none', async () => {
    await post('/submit', MINIMAL);
    const [, record] = stored()[0];
    // Absent, not []: "this build did not record a loadout" is not "the simulator wore nothing".
    expect(record).not.toHaveProperty('delivery');
    expect(record).not.toHaveProperty('earnings');
  });

  it('bounds a hand-made loadout', async () => {
    const huge = Array.from({ length: 500 }, () => ({ artifact: 'x'.repeat(500), stones: [] }));
    await post('/submit', { ...MINIMAL, delivery: huge });
    const [, record] = stored()[0];
    expect(record.delivery.length).toBeLessThanOrEqual(8);
    expect(record.delivery[0].artifact.length).toBeLessThanOrEqual(64);
  });
});

describe('the CSV half', () => {
  const gz = async text => {
    const cs = new CompressionStream('gzip');
    const w = cs.writable.getWriter();
    void w.write(new TextEncoder().encode(text));
    void w.close();
    return await new Response(cs.readable).arrayBuffer();
  };
  const postCsv = (id, body, type = 'application/gzip') =>
    worker.fetch(
      new Request('https://collector.test/csv?id=' + id, { method: 'POST', headers: { 'content-type': type }, body }),
      env
    );

  const gunzip = async buf => {
    const ds = new DecompressionStream('gzip');
    const w = ds.writable.getWriter();
    void w.write(new Uint8Array(buf));
    void w.close();
    return await new Response(ds.readable).text();
  };

  it('stores a gzipped CSV and hands back bytes that inflate to the original', async () => {
    const csv = 'rank,chain,days\n1,195 490,741.9\n'.repeat(200);
    const packed = await gz(csv);
    // The whole reason this design works: a chain table is repetitive enough that KV can hold it.
    expect(packed.byteLength).toBeLessThan(csv.length / 10);
    expect((await postCsv('abcd1234', packed)).status).toBe(200);

    const res = await worker.fetch(new Request('https://collector.test/csv?id=abcd1234'), env);
    expect(res.status).toBe(200);
    // A gzip FILE, not a gzip-encoded CSV. Declaring `content-encoding: gzip` on a `text/csv`
    // body made Cloudflare compress the response a second time, so the client stripped one layer
    // and saved the inner gzip under a .csv name. `application/gzip` is not compressible to the
    // edge, so the bytes arrive as sent. Asserting the absence of the header is the point.
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(res.headers.get('content-type')).toBe('application/gzip');
    expect(res.headers.get('content-disposition')).toContain('.csv.gz');
    expect(await gunzip(await res.arrayBuffer())).toBe(csv);
  });

  // A raw CSV stored as-is would later be served with a Content-Encoding its bytes do not have:
  // a download that will not open. Refusing is the kinder failure.
  it('refuses a body that is not gzip', async () => {
    const res = await postCsv('abcd1234', 'rank,chain\n1,195 490\n');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/gzip/);
  });

  it('refuses an empty body and a bad id', async () => {
    expect((await postCsv('abcd1234', new ArrayBuffer(0))).status).toBe(400);
    expect((await postCsv('not a valid id!', await gz('x'))).status).toBe(400);
  });

  it('404s for a CSV that was never uploaded', async () => {
    const res = await worker.fetch(new Request('https://collector.test/csv?id=deadbeef'), env);
    expect(res.status).toBe(404);
  });

  // The board has to know which rows have one, without an extra read per row.
  it('marks rows on the leaderboard with whether a CSV exists', async () => {
    const submit = await post('/submit', MINIMAL);
    const { id } = await submit.json();
    let board = await (await get('/leaderboard?final=490')).json();
    expect(board.rows[0].id).toBe(id);
    expect(board.rows[0].hasCsv).toBe(false);

    await postCsv(id, await gz('rank,chain\n1,195 490\n'));
    board = await (await get('/leaderboard?final=490')).json();
    expect(board.rows[0].hasCsv).toBe(true);
  });
});

describe('rejections are explained', () => {
  it('names the problems rather than failing blank', async () => {
    const res = await post('/submit', { schema: 1, chain: [5], durationDays: -1, finalTE: 0 });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.problems.length).toBeGreaterThan(0);
  });

  it('refuses a schema it does not recognise', async () => {
    expect((await post('/submit', { ...MINIMAL, schema: 99 })).status).toBe(400);
    // Schema 1 is what the app sent before artifacts became labels. Refused rather than
    // reinterpreted: the two shapes disagree about what `artifacts` even is.
    expect((await post('/submit', { ...MINIMAL, schema: 1 })).status).toBe(400);
  });
});

describe('run cost', () => {
  // This field feeds an average across every submission on the board, so a single absurd value
  // moves the estimate for everyone. Bounded on the way in, like every other field here.
  it('stores a plausible run cost', async () => {
    await post('/submit', { ...MINIMAL, run: { workers: 12, cores: 20, minutes: 65.3, secondsPerChain: 2.36 } });
    expect(stored()[0][1].run).toEqual({ workers: 12, cores: 20, minutes: 65.3, secondsPerChain: 2.36 });
  });

  it('drops a run cost with an impossible worker count', async () => {
    await post('/submit', { ...MINIMAL, run: { workers: 1e9, cores: 8, minutes: 10, secondsPerChain: 1 } });
    expect(stored()[0][1].run).toBeUndefined();
  });

  it('drops a run cost claiming a year of compute', async () => {
    await post('/submit', { ...MINIMAL, run: { workers: 8, cores: 8, minutes: 60 * 24 * 400, secondsPerChain: 1 } });
    expect(stored()[0][1].run).toBeUndefined();
  });

  it('drops a partial run cost rather than storing half of it', async () => {
    await post('/submit', { ...MINIMAL, run: { workers: 8 } });
    expect(stored()[0][1].run).toBeUndefined();
  });

  it('keeps a null core count, which means "not reported"', async () => {
    await post('/submit', { ...MINIMAL, run: { workers: 8, cores: null, minutes: 10, secondsPerChain: 1 } });
    expect(stored()[0][1].run.cores).toBeNull();
  });

  it('stores nothing at all when the sender omits it', async () => {
    await post('/submit', { ...MINIMAL });
    expect('run' in stored()[0][1]).toBe(false);
  });
});

describe('progression summaries', () => {
  it('stores epic research and colleggtible summaries', async () => {
    await post('/submit', {
      ...MINIMAL,
      epicResearch: { maxed: true, atMax: 36, total: 36, short: [] },
      colleggtibles: { maxed: false, byTier: [4, 0, 1, 2, 7], total: 14, short: ['carbon T3'] },
    });
    const row = stored()[0][1];
    expect(row.epicResearch).toEqual({ maxed: true, atMax: 36, total: 36, short: [] });
    expect(row.colleggtibles.byTier).toEqual([4, 0, 1, 2, 7]);
  });

  it('refuses a byTier that is not the five fixed buckets', async () => {
    await post('/submit', { ...MINIMAL, colleggtibles: { maxed: false, byTier: [1, 2], total: 3, short: [] } });
    expect(stored()[0][1].colleggtibles).toBeUndefined();
  });

  it('refuses an atMax larger than the total', async () => {
    await post('/submit', { ...MINIMAL, epicResearch: { maxed: true, atMax: 99, total: 36, short: [] } });
    expect(stored()[0][1].epicResearch).toBeUndefined();
  });

  it('truncates a short list a client failed to cap', async () => {
    const short = Array.from({ length: 100 }, (_, i) => `r${i} 0/10`);
    await post('/submit', { ...MINIMAL, epicResearch: { maxed: false, atMax: 0, total: 100, short } });
    expect(stored()[0][1].epicResearch.short).toHaveLength(16);
  });

  it('stores neither when the sender omits them', async () => {
    await post('/submit', { ...MINIMAL });
    const row = stored()[0][1];
    expect('epicResearch' in row).toBe(false);
    expect('colleggtibles' in row).toBe(false);
  });
});

describe('schema compatibility', () => {
  // The app and the Worker deploy separately. Refusing everything but the newest schema created a
  // window where every submission failed with "unknown schema 3" and nothing the sender could do.
  it('accepts the previous schema, which is missing only optional fields', async () => {
    const res = await post('/submit', { ...MINIMAL, schema: 2 });
    expect(res.status).toBe(200);
    expect(stored()).toHaveLength(1);
  });

  it('records the schema the sender actually used', async () => {
    await post('/submit', { ...MINIMAL, schema: 2 });
    expect(stored()[0][1].schema).toBe(2);
  });

  it('still refuses a schema it has never heard of', async () => {
    expect((await post('/submit', { ...MINIMAL, schema: 99 })).status).toBe(400);
    expect((await post('/submit', { ...MINIMAL, schema: 1 })).status).toBe(400);
  });

  it('names what it does accept, so the sender knows what to do', async () => {
    const res = await post('/submit', { ...MINIMAL, schema: 99 });
    expect((await res.json()).problems.join(' ')).toContain('accepts 2, 3');
  });
});
