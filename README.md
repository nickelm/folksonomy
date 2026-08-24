# Folksonomy Sheets

Live tag polling for a lecture hall. Students join on their phones, type or tap
tags, and watch a shared vocabulary form on the projector while Claude Haiku
quietly folds near-duplicates together.

Each exercise is a **sheet**: a set of questions with its own permanent, memorable
URL such as `cooljaguar.duckdns.org:8080/braveotter`. Run it live, then close it -
the URL keeps working as a read-only record students can revisit weeks later.

## Quick start

```bash
npm install
cp .env.example .env      # then edit it
npm start
```

Open <http://localhost:8080/presenter>, sign in, and create a sheet. The five
starter questions ship in `sheets/intro-to-hci.json` and are seeded on first run.

## Running a class

1. **Before the lecture** - create a sheet (or clone last year's) in the presenter
   console. It starts as a *draft*: invisible to students.
2. **At the start** - press **Open to class**. The sheet appears on the student
   index and starts accepting responses.
3. **During** - open **Run** for the projected view. It shows the join URL and a
   QR code students can scan. Press **Ask this question** to open one question;
   only one is open at a time, and only then can anyone answer it.
4. **Afterwards** - **Close** the sheet. Every cloud is revealed, responses stop,
   and the URL becomes a permanent record.

Clouds stay hidden from students until you activate a question, so nobody can read
ahead and anchor on what the room already said.

## Configuration

Everything lives in `.env`:

| Variable | Purpose |
|---|---|
| `PRESENTER_PASSWORD` | Gate for the presenter console. Required. |
| `ANTHROPIC_API_KEY` | Tag merging. Leave unset to run without it. |
| `PORT` | Defaults to `8080`. |
| `PUBLIC_BASE_URL` | What students actually type, e.g. `http://cooljaguar.duckdns.org:8080`. Used for the join URL and QR code. |

Without `PUBLIC_BASE_URL` the QR code encodes whatever `Host` header the browser
sent, which on a droplet is usually the bare IP. Set it.

## Authoring sheets from files

Drop a JSON file in `sheets/`:

```json
{
  "title": "Week 3 - Design critique",
  "status": "draft",
  "questions": [
    { "title": "What is HCI?", "description": "One or two words." }
  ]
}
```

Files are **seeded once, keyed on the filename**. On every boot the server loads
any file it has not seen before and ignores the rest - so questions you later edit
in the presenter console are never clobbered by the file they came from. Editing a
file after it has been seeded does nothing; create a new file, or edit in the UI.

`slug` and `status` are optional. Without a slug the server generates a word pair.

## How tag merging works

When a genuinely new tag appears, it is stored and broadcast **immediately** and
queued for a merge check. At most one Haiku call runs per question per two
seconds, carrying up to ten new tags at once.

The model is asked to be conservative - it merges spellings, plurals,
abbreviations, and true synonyms, and is told explicitly not to merge competing
answers such as "art" and "engineering". Every proposed merge is then re-checked
server-side against the tags that actually exist, so an invented or stale target
is discarded rather than destroying real responses.

Each merge is recorded as an **alias**, so the next student who types the folded
word resolves locally with no further API calls.

If `ANTHROPIC_API_KEY` is unset the app logs one line and runs without merging.

## Deploying to a droplet

```bash
# On a fresh Ubuntu droplet
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone <your repo> /opt/folksonomy && cd /opt/folksonomy
npm ci --omit=dev
cp .env.example .env && nano .env      # set the password, key, and PUBLIC_BASE_URL

sudo ufw allow 8080/tcp
npm start
```

Point your Duck DNS hostname at the droplet's IP, and students reach it at
`http://<hostname>:8080/<slug>`. Port 80 is not used, so the port is part of the
address you read out.

To survive a crash or reboot, run it under a process manager:

```bash
sudo npm install -g pm2
pm2 start server.js --name folksonomy
pm2 save && pm2 startup     # then run the command it prints
```

### Plain HTTP is fine here, with one caveat

Classroom use over HTTP is intentional - no certificate to manage. But an HTTP
origin is not a *secure context*, so `crypto.randomUUID()` is unavailable in the
browser. Session ids fall back to `crypto.getRandomValues`, which has no such
restriction. This is handled in `public/common.js`; it is called out here because
it only shows up once the app is on a real hostname, never on localhost.

## Data

SQLite at `data/poll.db`, created automatically. Back it up by copying the file.

Export a sheet from the presenter console as CSV (tags and counts) or JSON (adds
the merge history - which words the class produced before they were folded).

Closing a sheet is deliberately one-way in the UI, and asks you to type the sheet
title to confirm, because a stray click mid-lecture would be unrecoverable. If you
ever need to undo it:

```bash
sqlite3 data/poll.db "UPDATE sheets SET status='live', closed_at=NULL WHERE slug='braveotter';"
```

Restart the server afterwards so connected clients pick up the change.

## Tests

Start the server on a **fresh** database first (`rm -rf data && PORT=8099 npm start`),
since the suites assert on the starting state.

```bash
node scripts/merge-test.mjs    # merge, vote collision, alias resolution
node scripts/worker-test.mjs   # merge worker queueing and its guards (stubbed API)
node scripts/smoke.mjs         # end-to-end over HTTP + WebSocket
node scripts/ui-test.mjs       # real browser: rendering, typing, layout
SLUG=<slug> node scripts/loadtest.js   # 150 connections and a burst
```

`ui-test.mjs` needs `npm install` to have brought in Playwright and uses your
installed Chrome.
