# Folksonomy Sheets

Live polling for a lecture hall. Students join on their phones, answer one
question at a time, and watch the room's collective answer form on the projector
while Claude Haiku quietly tidies it up.

Each exercise is a **sheet**: a set of questions with its own permanent, memorable
URL such as `cooljaguar.duckdns.org:3000/braveotter`. Run it live, then close it -
the URL keeps working as a read-only record students can revisit weeks later.

Questions come in three kinds:

- **tags** - a word cloud the class builds together. Type a tag or tap someone
  else's to vote for it. Haiku folds spellings and synonyms together as they
  arrive. Can start with words already on the board.
- **freetext** - a sentence or two, capped at 280 characters, which everyone else
  can up- or down-vote. Afterwards Haiku groups the answers into named themes.
- **choice** - a fixed ballot. Everyone picks exactly one option; changing your
  mind moves your vote rather than adding one, so the counts always sum to the
  number of people who answered. A yes/no question is a choice with two options.

Three screens read the same sheet at once: the students' phones, a **live view**
for the projector, and a **dashboard** of six analytic panels.

## Quick start

```bash
npm install
cp .env.example .env      # then edit it
npm start
```

Open <http://localhost:3000/presenter>, sign in, and create a sheet. The six
starter questions ship in `sheets/intro-to-hci.json` and are seeded on first run.

## Running a class

1. **Before the lecture** - create a sheet (or clone last year's) in the presenter
   console. It starts as a *draft*: invisible to students.
2. **At the start** - press **Open to class**. The sheet appears on the student
   index and starts accepting responses.
3. **During** - open **Run** for the console. It shows the join URL and a QR code
   students can scan. Press **Ask this question** to open one question; only one is
   open at a time, and only then can anyone answer it.
4. **On the projector** - open **Live view** from the console header. It shows only
   the question that is currently open, full screen, with no controls.
5. **Afterwards** - **Close** the sheet. Everything is revealed, responses stop, and
   the URL becomes a permanent record. The **Dashboard** link is the one to send
   students home with.

Results stay hidden from students until you activate a question, so nobody can read
ahead and anchor on what the room already said. Once revealed they stay visible
permanently and keep updating - a sheet is a notebook page for the session, not a
slide that disappears.

### Where each screen lives

| Screen | URL | Who |
|---|---|---|
| Student sheet | `/<slug>` | Everyone. Also reachable as `/s/<slug>`. |
| Presenter console | `/presenter/<slug>` | You. Also `/p/<slug>`. Password required. |
| Live view | `/live/<slug>` | The projector. No controls, no password. |
| Dashboard | `/d/<slug>` | Anyone. Six panels, click one to fill the screen. |

The bare `/<slug>` is the canonical student URL because it is the one you read
aloud to a room. `/s/` and `/p/` are aliases that redirect to it.

## Configuration

Everything lives in `.env`:

| Variable | Purpose |
|---|---|
| `PRESENTER_PASSWORD` | Gate for the presenter console. Required. |
| `ANTHROPIC_API_KEY` | Tag merging. Leave unset to run without it. |
| `PORT` | Defaults to `3000`. |
| `PUBLIC_BASE_URL` | What students actually type, e.g. `http://cooljaguar.duckdns.org:3000`. Used for the join URL and QR code. |

Without `PUBLIC_BASE_URL` the QR code encodes whatever `Host` header the browser
sent, which on a droplet is usually the bare IP. Set it.

## Authoring sheets from files

Drop a JSON file in `sheets/`:

```json
{
  "slug": "week3",
  "title": "Week 3 - Design critique",
  "status": "draft",
  "questions": [
    { "title": "What is HCI?", "type": "tags", "description": "One or two words." },
    { "title": "Why is it hard?", "type": "freetext", "description": "A sentence." },
    { "title": "Art or engineering?", "type": "choice",
      "options": ["art", "engineering", "both"] },
    { "title": "What makes it bad?", "type": "tags",
      "options": ["slow", "confusing"] }
  ]
}
```

`type` is `tags` (the default), `freetext`, or `choice`.

`options` means two different things, deliberately:

- on a **choice** question they are the ballot. At least two, at most eight, and
  students cannot add to them.
- on a **tags** question they are a starting point - words already on the board
  that students can vote for, ignore, or add to. That is how "art" and
  "engineering" get put up without deciding for the room that those are the only
  two answers.

Authored options are remembered as authored. Cloning a sheet carries them over
and leaves last year's student answers behind, and tag merging will never fold
one away into a word a student typed.

Files are **seeded once, keyed on the filename**. On every boot the server loads
any file it has not seen before and ignores the rest - so questions you later edit
in the presenter console are never clobbered by the file they came from. Editing a
file after it has been seeded does nothing; create a new file, or edit in the UI.

`slug` and `status` are optional. Without a slug the server generates a word pair.

The starter sheet ships as `sheets/intro-to-hci.json` with the slug `intro`. If you
already have a database from before it existed, that file will not be re-read -
seeding is once per filename. Either add a new file, or add the questions by hand
in the presenter console.

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

## One phone, one vote - roughly

The session id lives in **sessionStorage**, so each browser tab is its own voter.

That is a deliberate loosening. In localStorage, two tabs of one browser were one
voter, and the second tab's votes disappeared into the unique constraint with no
error and no visible effect - which is the most confusing thing this app could do,
because everything looks like it worked.

The trade: somebody who deliberately opens five tabs gets five votes. localStorage
never really stopped that either - a private window was always enough - and this is
a lecture exercise, not a ballot. What the id is genuinely for is absorbing the
accidental double-tap, and per-tab still does that.

## How theme clustering works

Merging cleans up a tag cloud one word at a time, forever. Clustering is the other
shape: a single pass over a freetext question that has finished.

Press **Find themes** on a freetext question in the console, or just move on to the
next question - deactivating a freetext question triggers a run automatically. Every
answer goes to Haiku at once and comes back sorted into four to six named themes.

The result is checked before it is written. An id the model invented is discarded,
an answer claimed by two themes goes to the first, and a theme with no usable name
is dropped. Anything the model left out stays unlabelled and shows as
"Unclustered" rather than being quietly filed under the nearest heading.

It needs at least four answers, and does nothing without `ANTHROPIC_API_KEY`.

## The live view

`/live/<slug>` is for the projector: the active question, full screen, no chrome.

Underneath is an animated d3 bar chart. Over it, a canvas layer implementing
**visual sedimentation** (Huron, Vuillemot & Fekete, InfoVis 2013): each submission
enters as a token at the top of the screen, falls while drifting and fading, and
merges into the bar for its tag - which grows at the moment the token arrives.

That last detail is the point, and it is why the drawn number briefly disagrees
with the server. A bar that grew on arrival of the *message* would already have
absorbed the token before it landed, and the merge would be invisible. So the view
holds each increment back until its own token gets there. Tokens that cannot be
drawn - past the 240-particle cap, or on a machine set to reduce motion - do not
hold anything back, and their counts appear immediately.

Set `prefers-reduced-motion` and the canvas is skipped entirely; the bar chart is
complete on its own.

## The dashboard

`/d/<slug>` is six panels over one question, with a selector at the top. Click any
panel to fill the viewport, Escape to go back.

1. **Ranked frequency** - sorted animated bars. The default readout.
2. **Word cloud** - Jason Davies' `d3-cloud` layout. On a freetext question it
   clouds word frequencies from the answers instead.
3. **Theme clusters** - the Haiku grouping, one column per theme.
4. **Tags that travel together** - a force-directed graph of tags the same people
   picked together.
5. **How the vocabulary formed** - when each tag first appeared and how it
   accumulated.
6. **Raw responses** - unaggregated, score-sorted for freetext.

One colour scale is shared across all six, keyed on the label, so a tag is the same
colour everywhere - including on the live view next to it.

d3 and `d3-cloud` are served from `/vendor/` straight out of `node_modules`. No
CDN, so a projector with no internet still draws; and the student pages never load
them, which is why this is not a global script tag.

## Deploying to a droplet

```bash
# On a fresh Ubuntu droplet
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git

git clone <your repo> /opt/folksonomy && cd /opt/folksonomy
npm ci --omit=dev
cp .env.example .env && nano .env      # set the password, key, and PUBLIC_BASE_URL

sudo ufw allow 3000/tcp
npm start
```

Point your Duck DNS hostname at the droplet's IP, and students reach it at
`http://<hostname>:3000/<slug>`. Port 80 is not used, so the port is part of the
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

Export a sheet from the presenter console as CSV (tags with counts, or answers with
scores) or JSON (adds the merge history - which words the class produced before they
were folded - and the theme each answer landed in).

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
node scripts/merge-test.mjs      # merge, vote collision, alias resolution
node scripts/worker-test.mjs     # merge worker queueing and its guards (stubbed API)
node scripts/cluster-test.mjs    # clustering, and every way it distrusts the model
node scripts/choice-test.mjs     # ballots, seeded options, cloning, throttling
node scripts/smoke.mjs           # end-to-end over HTTP + WebSocket
node scripts/freetext-test.mjs   # posting, the undo/flip vote rule, type guards
node scripts/ui-test.mjs         # real browser: student page rendering and typing
node scripts/views-test.mjs      # real browser: live view and dashboard

SLUG=<slug> node scripts/loadtest.js                # 150 connections and a burst
SLUG=<slug> MODE=freetext node scripts/loadtest.js  # the same, with 280-char answers
```

The browser suites need `npm install` to have brought in Playwright and use your
installed Chrome. They write screenshots to `scripts/shot-*.png`.

`node scripts/shots.mjs` is not a test - it builds a sheet with both question
types, some answers and some votes, and photographs the student page and the
presenter console. Useful for looking at a CSS change without setting a lecture up
by hand.

Run each suite against a freshly started server: `smoke.mjs` closes the seeded
sheet, so a second run in the same session reports false failures.
