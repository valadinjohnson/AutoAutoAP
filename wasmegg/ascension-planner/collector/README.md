# Collecting results, and fixing the API from your own domain

Two Cloudflare Workers. They are independent — deploy either, both, or neither.

| | what it fixes |
|---|---|
| **CORS proxy** | "fetch by player ID" failing on any domain that is not carpet's |
| **Collector** | nowhere to send a result, and no leaderboard to see one on |

Neither is required to use the planner. Without the proxy, load a backup file instead of
fetching by ID. Without the collector, the Share card saves a file you can post anywhere.

---

## 1. The CORS proxy

### Why it breaks

The game's API sends no CORS headers, so browser requests go through a Worker that adds
them. The default is upstream's, and it only accepts requests from origins on its own
allowlist — see `wasmegg/_proxy/index.js`:

```
https://…wasmegg-carpet.netlify.app
https://…eicoop-carpet.netlify.app
https://…eicowop.netlify.app
http://localhost(:port)
http://127.0.0.1(:port)
http://192.168.x.x(:port)
```

**`localhost` and `192.168.*` are already allowed**, so a plain local build works. What does
not work is anything else: a custom domain, a Cloudflare tunnel, a Netlify preview under your
own account, a LAN host on `10.x`. Those are refused by the proxy and the app looks broken
rather than looking like a deployment that needs its own.

### Deploying your own

Upstream's proxy source is in this repo at `wasmegg/_proxy/index.js`. Copy it out, add your
origin to `isAllowedOrigin`, and deploy:

```bash
mkdir egg-proxy && cd egg-proxy
cp ../wasmegg/_proxy/index.js .
```

Add your own origin to the allowlist in `index.js`:

```js
function isAllowedOrigin(origin) {
  return (
    origin?.match(/^https:\/\/egg\.example\.org$/) ||      // <- yours
    origin?.match(/^https:\/\/([\w-]+--)?wasmegg-carpet.netlify.app$/) ||
    // … leave the rest
  );
}
```

`wrangler.toml`:

```toml
name = "egg-proxy"
main = "index.js"
compatibility_date = "2026-01-01"
```

```bash
npx wrangler deploy
```

### Pointing the app at it

Build with the env var set. Unset, nothing changes and upstream's proxy is used:

```bash
VITE_EGG_PROXY=https://egg-proxy.<you>.workers.dev pnpm fastbuild
```

`VITE_EGG_AUTH_PROXY` does the same for the authenticated endpoints, which only the contract
tools need — the ascension planner does not.

**Check it worked** by watching the network tab: requests should go to your Worker, and a
player-ID fetch should return a backup instead of a CORS error. From a page served on your
origin, this is enough -- a 200 whose body you can read is a CORS pass:

```js
await (await fetch('https://<your-worker>.workers.dev/?url=https://www.auxbrain.com' +
  '/ei/bot_first_contact', { method: 'POST', mode: 'cors', body: 'data=' })).text()
// -> "EI user id must be set at index 4" (base64). The game server answered; CORS is fine.
```

Note the endpoint is `/ei/bot_first_contact`; `/ei/first_contact` answers 405 and looks like a
proxy fault when it is not.

### Configure it once instead of per-command

`VITE_EGG_PROXY` and `VITE_PREVIEW_HOSTS` both come out of `.env.local` in this directory
(gitignored -- it holds your own worker URL and hostname). `vite.config.ts` reads it through
`loadEnv`, so a plain `pnpm fastbuild && pnpm serve` is already configured; a shell variable
still overrides it for a one-off.

---

## 1b. Serving it on your own domain

`pnpm serve` is `vite preview`, and vite refuses any request whose `Host` header it does not
recognise -- DNS-rebinding protection, with localhost the only name it knows. Behind a reverse
proxy or a Cloudflare tunnel every request comes back `Blocked request. This host is not
allowed`, which looks like a broken app and is really a one-line config gap.

The hostname is supplied at run time so nobody's private domain ends up in the repo:

```bash
VITE_PREVIEW_HOSTS=egg.example.org pnpm serve
```

Comma-separate for several. Unset keeps the safe localhost-only default.

Check it without a tunnel:

```bash
curl -s -H "Host: egg.example.org" http://127.0.0.1:4173/ascension-planner/ | head -3
```

`vite preview` serves a build, not sources -- it does not re-read `dist/` layout on the fly, so
rebuild (`pnpm fastbuild`) and reload after any change. For a long-lived deployment prefer a
plain static server or Netlify over `vite preview`; preview is a development convenience and has
no allowlist beyond this one.

---

## 2. The collector

One Worker plus one KV namespace, holding `POST /submit`, a JSON leaderboard API, and the
leaderboard page itself. The dataset is a few thousand small objects, so KV is enough and a
database would be borrowing trouble.

```bash
cd collector
npx wrangler kv namespace create SUBMISSIONS   # paste the printed id into wrangler.toml
npx wrangler deploy --config "$PWD/wrangler.toml"
```

**One KV namespace holds everything — no R2, no payment method on the account.** Submissions are
small JSON under `sub:`; a run's full CSV is gzipped by the browser and stored under `csv:`.
Measured on real output: 11,000 chains is 15.3 MB of text and **0.66 MB gzipped**, about 23x,
because a chain table is overwhelmingly repeated numbers and timestamps. KV's ceiling is 25 MB
per value, so that fits with room to spare.

Compression happens in the app, not here, and not only to shrink the upload: the free Workers
plan allows roughly 10ms of CPU per request, and gzipping fifteen megabytes would spend that many
times over. The Worker stores the bytes it is handed and serves them back still compressed with
`Content-Encoding: gzip`, letting the browser inflate them.

The cost of that: the `EI\d{16}` sweep the JSON path runs is a regex over text and cannot read an
opaque gzip stream. So the sweep moved into the app, which scrubs before compressing. A hand-made
gzip posted directly to `/csv` is **not** swept — it is only size-capped and checked for gzip
magic. The CSV never carried a player id to begin with (`buildChainsCsv` has no `playerId` in its
metadata), so this remains belt-and-braces, just enforced one step upstream.

**The `--config` flag is not optional, and leaving it off is confusing rather than obviously
wrong.** Wrangler picks its project root by walking up from the working directory looking for a
`package.json`, and the first one it finds is the planner's, one level above. From there it
looks for `wrangler.toml` in the planner directory, does not find one, and reports a *missing
entry point* -- advice about `main = "src/index.ts"` for a Worker whose config it never read. An
absolute path pins it. `kv namespace create` needs no config, which is why that half works
unaided.

Check the whole thing without publishing:

```bash
npx wrangler deploy --dry-run --config "$PWD/wrangler.toml"
```

That compiles the Worker and resolves the bindings, printing the KV namespace it found, then
exits. It is the cheapest way to catch a config mistake before an endpoint is public.

Then build the app pointing at it:

```bash
VITE_SUBMIT_URL=https://ascension-chain-collector.<you>.workers.dev/submit pnpm fastbuild
```

Without `VITE_SUBMIT_URL` the panel **hides the Submit button entirely** and offers only
"Save the file instead". That is the right default for a fork nobody has configured: there is
no sensible global collector, and a button that silently posts somewhere would be worse than
no button.

### Endpoints

| | |
|---|---|
| `POST /submit` | one submission; validated against a whitelist, rate-limited to 10 per IP per minute |
| `POST /csv?id=<id>` | that run's gzipped CSV. Must be gzip, capped at 8 MB compressed |
| `GET /csv?id=<id>` | it back, served `Content-Encoding: gzip` |
| `GET /leaderboard?final=490&limit=50` | one row per distinct run, already in duration order |
| `GET /all` | everything, for your own analysis |
| `GET /` | the leaderboard page |

Rows from `/leaderboard` and `/all` carry two fields that are **not stored**: `id`, taken from the
last segment of the KV key, and `hasCsv`. The second comes from a single `list({prefix:'csv:'})`
per request rather than an existence check per row — the ids already line up, so storing a flag
on the record would only add a read-modify-write on every upload, and writes are the scarce quota
(~1,000/day on the free plan; each submission costs two).

### What is stored, and what is not

A submission is built in the app by **whitelist** (`src/search/submission.ts`) — a fresh
object with a fixed list of fields — not by stripping things out of the CSV. A field added to
the CSV later cannot leak by being forgotten about.

**The player ID is not in it, and never was**: `buildChainsCsv` has no `playerId` in its
metadata and never printed one. The Worker still sweeps `EI\d{16}` out of every body before
writing, for the case where someone posts a hand-made payload.

Stored: chain, ascension count, duration, local start/end, timezone, TE range, effort tier,
schedule window, whether shifts were held, waiting hours, per-leg strategy and peak delivery,
chains priced, an optional 40-character nickname, and the inventory as described next.

**Artifacts are labels; stones are counted, and both are narrowed.** Schema 2 sends the best piece
per family by name -- eight entries, no numbers -- rather than every tier owned with exact counts.
Stones are cut to the three a virtue set actually sockets: tachyon and quantum on the delivery
side, lunar on the earnings side. The other seven families are in the inventory and appear in no
set the simulator builds, so reporting them was a long list saying nothing. An artifact slot
takes one artifact, so owning 732 T1C necklaces and one T4L never changed the answer; the
simulator wears the T4L. Stones keep their counts because they are socketed three at a time and
how many you hold decides what can be built. Measured on a real account, this took the inventory
from 102 entries and 2,455 characters to 8 artifacts and 7 stone lines -- a smaller payload and a much duller
fingerprint, for no loss of anything that determined the result.

Not stored: IP addresses beyond a rate-limit key that expires within two minutes, headers,
cookies, or anything derived from the connection.

**Still identifying, and the app says so before the button is pressed.** The artifact
inventory with exact counts is close to a fingerprint among people who know each other; the
timezone and local plan start give a region and a daily rhythm; the availability window says
when someone is awake. The inventory is included because a duration is meaningless without
knowing what it was simulated with — 740 days on a full T4L set is a different claim from 740
days on commons.

If you change what is stored, **change the consent text in the panel to match**. People agreed
to a specific list.

### Reading the leaderboard honestly

Durations are not comparable between accounts. A chain's length depends on artifacts,
research and starting TE at least as much as on the chain, and on whether the run was
constrained to the player's waking hours. It answers "what shapes are winning for people",
not "who is best". The page says so under the table.

**One row per distinct RUN, not per person.** A submission is identified by nickname, target,
chain, effort tier, schedule window and whether shifts were held. Two that agree on all of it are
the same experiment priced twice -- a re-run, the same plan from a different start -- and the
faster one stands for both. Two that differ anywhere are different experiments and both show,
because "does `thorough` beat `balanced` here" and "does this shape travel between accounts" are
the questions the board exists to answer, and an earlier version that kept one row per person per
target deleted the evidence for both. Duration is deliberately not part of the identity.

Anonymous rows are never collapsed: anonymous is not an identity, and two people who both tried
the same chain would otherwise cost one of them their result.

`waiting` blank means the submission carried no per-leg detail — a chain replayed from a saved
checkpoint keeps none. That is **unknown**, not zero, and it sorts accordingly.

---

## Testing the Worker without deploying

```bash
npx wrangler dev            # from collector/
```

`worker.js` is a single file with no build step and no dependencies, so a plain Node harness
with a `Map` standing in for KV exercises it end to end — that is how the validation, the rate
limit, the duration ordering and the ID redaction were checked before this was committed.
