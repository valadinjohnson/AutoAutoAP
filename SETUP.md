# AutoAutoAP Setup Guide

AutoAutoAP plans **ascension chains** for Egg, Inc.'s Virtue Prestige system — the
sequence of Truth Egg checkpoints that gets you to a target the fastest.

This guide gets you from a fresh clone to the planner running at
`http://localhost:4173/ascension-planner/` in your browser. It covers **macOS** and
**Windows**; where a command differs, both versions are shown.

There are two separate tools here:

- **The web app** (this guide) — an interactive planner. You type in TE targets and hit
  "Generate Plan" to get one chain.
- **`scripts/autoplan.py`** (optional, covered at the end) — a command-line batch search
  that tests thousands of candidate chains to find the fastest one. It's a separate tool
  that reuses the web app's own simulator; it isn't part of the GUI.

---

## Before you start

Install these once:

| Tool | Why |
|---|---|
| **Node.js 24+** | Runs the build tooling. 26 works too. |
| **pnpm** | The package manager this project's workspace is built with — not npm or yarn. |
| **protoc** | Compiles Egg, Inc.'s `.proto` API definitions into TypeScript the app imports from. |
| **make** | Runs the build recipes in each folder's `Makefile`. |
| **Python 3.9+** | Only needed for the optional batch chain-search script. |

### macOS

One Homebrew line covers everything:

```bash
# if you don't have Homebrew yet:
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# then:
brew install node pnpm protobuf python git
```

### Windows

Chocolatey covers everything in one line. This also installs **Git for Windows**, which
brings **Git Bash** — use that terminal for every command below, since `make` and `&&`
chaining need it (plain PowerShell/cmd won't work the same way).

```powershell
# Run as Administrator. If you don't have Chocolatey yet:
Set-ExecutionPolicy Bypass -Scope Process -Force
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor 3072
iex ((New-Object System.Net.WebClient).DownloadString('https://community.chocolatey.org/install.ps1'))
```

```powershell
# then, in a new admin PowerShell window:
choco install git nodejs-lts pnpm protoc make python -y
```

After this finishes, close PowerShell and open **Git Bash** (search for it in the Start
menu) — use it for every step from here on.

---

## Build & run

Run these from the project root unless noted otherwise. Commands are identical on macOS
and Windows (Git Bash) from this point on.

### 1. Open a terminal in the project folder

Wherever you saved `AutoAutoAP-ascension-chain-search` — a download, a USB drive, a clone
from wherever you got it — navigate there first.

```bash
cd path/to/AutoAutoAP-ascension-chain-search
```

### 2. Install workspace dependencies

This is a pnpm **workspace** — 23 sub-projects share one install. Always run this at the
**repo root**, never inside a subfolder.

```bash
pnpm install
```

### 3. Generate the protobuf bindings

Every other package imports the Egg, Inc. API types from `lib/proto` — but that folder is
generated, not committed. **This is the step people skip**, and it's the one that produces
a wall of `Cannot find module '../proto'` errors if you do.

```bash
cd lib
make
```

### 4. Build the planner

Compiles the Vue app into a static bundle in `dist/`.

```bash
cd ../wasmegg/ascension-planner
pnpm fastbuild
```

### 5. Run it

Serves the build locally. Leave this terminal window open while you use the app.

```bash
pnpm serve
```

Open **`http://localhost:4173/ascension-planner/`** in your browser.

> **Heads up:** the app needs a secure context to work — `localhost` is fine, but serving
> it over plain HTTP on your LAN (e.g. another device hitting your IP address) will break
> silently, because the browser's crypto APIs refuse to run there.

---

## Going further (optional): searching for the best chain

`scripts/autoplan.py` drives thousands of simulated chains through the same engine the web
app uses, to find one that's genuinely close to optimal rather than just good.

**Verify the build first**, before trusting a multi-hour run — this confirms your
machine's simulator matches the reference result to the hour:

```bash
cd wasmegg/ascension-planner
pnpm search:build
node dist-search/fastsearch.js \
  --backup your_backup.json --final 490 \
  --start-date 2026-09-04 --start-time 18:51 \
  --timezone America/Denver --force-continue
```

**Then run a search:**

```bash
python scripts/autoplan.py \
  --player-id EIxxxxxxxxxxxxxxxx \
  --backup me.json \
  --effort balanced --jobs 12 --yes
```

`--player-id` fetches your save over the network; `--backup file.json` runs fully offline
instead.

> ⚠️ **Treat your player ID as a secret.** The Egg, Inc. API will hand your entire save to
> anyone who has it — that's exactly what `--player-id` requests. Don't paste a real one
> into a screenshot, log, or chat.

---

## Troubleshooting

**`Cannot find module '../proto'` or `UNRESOLVED_IMPORT`**
You skipped step 3 above. Go to the repo root, `cd lib`, and run `make` — this generates
the file every other package is importing from.

**`No targets specified and no makefile found`**
You ran `make` from the wrong folder — there's no top-level `Makefile` at the repo root.
`cd lib` (or the specific project folder) first, then run `make` there.

**`protoc: command not found` / `pbjs` fails**
protobuf isn't installed, or your terminal was opened before the install finished. Re-run
the prerequisites install command, then open a **new** terminal window so it picks up the
updated PATH.

**`ENOENT: no such file or directory, open 'blind_main.json'`**
Expected — that filename is a placeholder example from someone else's private backup, not
something shipped in this repo. Point `--backup` at your own save file instead, or fetch
one live with `--player-id`.

**Windows: `'make' is not recognized` / `&& was unexpected`**
You're running commands in PowerShell or Command Prompt. Use **Git Bash** instead — it's
installed alongside Git for Windows and behaves like the macOS examples above.

---

Built on top of `wasmegg-carpet/egg`. The Makefiles and GitHub build workflows in this
repo are the full reference if a step here ever drifts out of date.
