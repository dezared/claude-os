# Memory at wiki scale — spec

Status: implemented · Owner: the owner · Date: 2026-11-12

## Intent

The wiki memory was built so that a project can hold tens of thousands of one-fact notes without loading them into context: `MEMORY.md` stays a budgeted index, everything else is reached through `memory_search`. The interface still told the user to prune a project to 180 notes, the server rebuilt everything from disk on every change, and the map loaded every note. This change removes the cap, makes the server, search and map hold 60k notes in one project, redesigns Tools → Storage around the whole memory, and asks sessions to write notes actively.

## Evidence

- The "180 notes" advice came from one place: `OVER_LIMIT = 180` in `web/src/screens/VaultPane.tsx` with the hint "Claude Code reads only the first 200 files of a memory folder: merge or prune notes". No prompt, tool answer or guard rule carried it. Claude Code's 200-file scan only decides which notes it offers on its own; Claude OS sessions reach every note through `memory_search`.
- `scripts/memory-bench.ts` generates a vault in a temp dir (never the user's) and measures through the real routes. Baseline at 60,000 notes in one project: first map 6.8 s with a 19 MB answer of 60,001 nodes, a search 300–5,300 ms (the index synced on every query and the 2 s view TTL rebuilt everything), one changed note 9.5 s until the next search, RSS 1.2 GB.
- Profile of the baseline: the language check of lint (`nonLatinRatio`, a regex per letter) and the full relint of every note on every rebuild dominated; the FTS sync re-read every row per query.

## Goals

1. No note cap anywhere in the interface, prompts or tools; prompts say that `MEMORY.md` lists some notes and `memory_search` finds all.
2. At 60k notes: a search under 200 ms; the map answer at most `MEMORY_MAP_CAP` (1500) nodes, with the full totals.
3. A note write costs a reread of that file, not a rescan; lint and the search index redo only what changed.
4. Tools → Storage shows per-project counts, growth, types, tags and health, searches all notes with filters, opens a note, and hands reorganizing and merging duplicates to Claude.
5. Sessions are asked to write a note after meaningful work, within the work-tab prompt budget (2 KB).

## Non-goals

- Generating notes in the user's vault, or migrating existing notes (the wiki migration does that).
- A persistent index on disk: the FTS index stays in memory and is rebuilt at start.
- Embeddings.

## Anti-goals

- A search that misses notes because the map shows a subset.
- `MEMORY.md` growing: it keeps its 100 lines / 10 KB budget.
- The work-tab prompt over 2 KB, the note rules over 150 words.
- A regenerated `MEMORY.md` or `_index` built from a half-read vault.

## Design

**Store.** `server/memory/scan.ts` keeps the parsed note files between scans. The watcher's changed paths are reread one by one (`store.touch(paths)`); a path that is no note file asks for a stat pass, which rereads only files whose mtime or size moved. The stat pass also heals missed watcher events: every 15 s up to 5,000 notes, every 60 s above. The view is rebuilt when the scan changed or after 15 s (settings and connections have no watcher). Unchanged notes keep their view objects.

**Lint cache.** `LintCache` (`noteIndex.ts`) keeps each note's codes with its text hash and the names it depends on (its possible names, its link targets). A rebuild relints a note only when its text changed or one of those names gained or lost a note. A cold build lints for 150 ms and queues the rest as jobs run in 40 ms steps between requests; when they finish the view is rebuilt from the cache and `memory` is invalidated. Lint and the wiki sync itself never depend on the deferred issues. `nonLatinRatio` counts letters without an array per letter.

**Search.** The index syncs only after a view rebuild. A sync is planned against an in-memory mirror of the indexed hashes and written in steps: up to 500 rows at once before the query, more in 40 ms steps between requests; a search during a large first build sees the notes indexed so far. The first build starts 2 s after the server is up.

**Map.** `GET /api/memory/graph` returns `MemoryMap` (`shared/memory.ts`): at most 1500 nodes chosen per project (share by the square root of its size, at least 24 or all of a small project): hubs by degree, then the newest, then neighbours of what is in, then the newest again; edges among them; `total` and `counts` for the whole vault. The home pill, the core popover and the work side panel count from `total`/`counts`; the pill adds "N on the map" when a subset is drawn.

**Storage panel.** `GET /api/memory/overview` (`MemoryOverview`) and `GET /api/memory/list` (`MemoryNoteList`, filters `q`, `project`, `type`, `tag`, `health`, paged; a query ranks through FTS up to 1000 hits). Health marks: malformed (a lint issue other than an unresolved link or the soft length flag), broken (an unresolved link), duplicate (the same description in a project, or a name taken twice), orphan (no links either way; informational). The pane shows a stat strip, a projects table (notes, read-only outside notes, 12-week growth bars, type split, top tags, health chips that filter the list, the migration cell, a row menu), the list of all notes, and the old vault import section below. The row menu and right-click run two microtasks, `memory-reorganize` and `memory-dedupe`, in the user's chosen tab.

**Prompts.** `root/NOTE_RULES.md` keeps its format block and adds: `MEMORY.md` lists some notes, `memory_search` finds all, before work on a topic and before writing; after meaningful work note decisions and why, bug causes, constraints, preferences; notes are unlimited. The `memory_search` description and the `MEMORY.md` overflow line say the same.

Touchpoints: two microtasks (registered in `MICROTASK_ROUTES`, checked by `check:touchpoints`), two routes (route lines in `shared/contract.ts`), the e2e fixture serves the new routes through the real catalog functions.

Rejected: an async store (every caller of the view is synchronous; the gain is the cold read only); paginating the graph (the map needs a whole picture, not pages); persisting the lint cache (the deferred cold lint is enough).

## Order of work

1. Bench script, scanner, lint cache, search steps, sampled map, routes, unit tests.
2. Prompts and microtasks.
3. Web: counts from totals, the Storage panel, e2e.

## Verification

- `server/memory/scale.test.ts`: rereads by path, lint follows names, deferred lint jobs, the map sample, the graph subset with full counts, health marks, overview and list routes, planned sync in steps.
- `e2e/memory-wiki.test.ts`: the storage pane's figures, a health chip filtering the list, search, a note opening; the row menu opening the reorganize microtask; the migration flows through the projects table.
- `node --disable-warning=ExperimentalWarning scripts/memory-bench.ts 60000 1` after the change (this machine, load average 5–9 from parallel work): search 1–98 ms, map 6 ms warm and 140 ms after a change with 1500 nodes and 540 KB, search index complete 3.6 s after start in steps, overview 45 ms warm, list 15 ms, a query with filters 120 ms, search right after a write 470 ms (the view rebuild), RSS 690 MB.

## Measured

Follow-up (2026-11-13): the owner waited about 8 s for the panel after a start and asked whether Claude works well at 100k notes. Machine: 4 cores, WSL2, load average 5–9 from parallel sessions, so the times are pessimistic.

**Start.** `data/memory-snapshot.ndjson` keeps the scanned note files (one JSON line per note, a versioned header, the body cut from the content again on load), written atomically after the start pass and at most every 10 minutes after a change. A start loads it, stats every file and rereads only what moved, all in 15 ms slices (`scan.ts` `sliced`); a missing, foreign, old or broken snapshot means a full read in the same slices. Until the first full view is built (also in slices, with the map sample) readers get an empty view, `store.complete()` is false, the wiki sync defers its paths and the migration routes answer 503; then `memory` and `projects` are invalidated. Content stays in the snapshot: lint and the search index read it. The vault is watched folder by folder with `fs.watch` (`watchDirs.ts`): chokidar statted every note at start, about 3.5 s of the server's time at 100k. An aged view (15 s TTL) and the rebuild after the deferred lint now run in slices while readers keep the current view; the search index replans only when the notes changed.

`node --disable-warning=ExperimentalWarning scripts/memory-start-bench.ts <notes> 4` (a fresh process per start; first answer = the first `/api/memory/graph`; complete = the full view and the map are ready; max stall from `monitorEventLoopDelay`):

| notes | start | register | first answer | complete | first search after | search index done | max stall | RSS |
|---|---|---|---|---|---|---|---|---|
| 100k | before (`memory-bench.ts 100000 1`, sync scan) | 499 ms | up to 7.8 s (the stall) | — | — | 12.8 s | 7848 ms | 1044 MB |
| 100k | cold, no snapshot | 46 ms | 63 ms | 7.3 s | 75 ms | 8.9 s | 201 ms | 784 MB |
| 100k | warm snapshot | 36–42 ms | 50–59 ms | 2.9–3.0 s | 73–82 ms | 4.3 s | 179 ms | 690 MB |
| 100k | warm, 400 files changed offline | 36 ms | 50 ms | 4.0 s | 109 ms | 5.5 s | 246 ms | 809 MB |
| 200k | cold | 44 ms | 83 ms | 22.8 s | 245 ms | 27.1 s | 556 ms | 1060 MB |
| 200k | warm snapshot | 44–82 ms | 60–121 ms | 7.0–8.7 s | 194–264 ms | 10.4–13.2 s | 423–605 ms | 1044–1220 MB |

Against the targets: an answer within 300 ms of start is met at both sizes. A complete view under 2 s with a warm snapshot is not met: about 3 s at 100k and 7–9 s at 200k on this loaded machine, spent on parsing the 160 MB snapshot (~1 s at 100k), 100k stat calls (~0.3 s), the view and the map sample. No block over 50 ms is not met either: the slices themselves stay near 15–20 ms, but one stretch of 175–250 ms (100k) and 400–600 ms (200k) remains where the start's promise chain, the wiki sync's start set and the first index plan follow each other without a timer turn. A rebuild after a note write was still synchronous: about 0.7–1.1 s at 100k, once per watcher batch (300 ms debounce), because `MEMORY.md` regeneration must read a view that holds the written note; see Writes below. The start targets need a persisted lint cache and search index; not done here.

**Writes** (2026-11-13). A note write no longer rebuilds the view. The scanner logs the paths each version changed and which of them were added (`changedSince`); the store updates its view by them (`viewDelta.ts`): the notes array is patched in the scanner's order, `byId`/`byName` follow, the links of the changed notes and of every note linking to a name whose resolution may have moved are taken back and added again (each note keeps what its links resolved to, each name who links to it, each pair its link count), and lint judges the changed notes and the dependents of moved names (`lintDelta.ts`, the lint cache keeps who depends on which name), 20 ms at once and the rest as deferred jobs. The search index takes the changed notes instead of diffing every row. The map sample, the catalog with its overview, and `MEMORY.md`/`_index` of a large vault (over 5,000 notes) are made in steps while readers keep the last result, and the interface is told when the new one is ready; `MEMORY.md` ranks only the notes it can list. All background steps of the memory module take turns (`turns.ts`): one 10 ms slice per turn of the event loop, because Node ran every queued immediate in one go. A full rebuild remains for a migration (`touch()` without paths), the 15 s settings refresh (in slices), and a gap in the change log. `viewDelta.test.ts` checks the updated view against a full rebuild with a cold lint cache after every batch of random writes, deletes and renames, with and without old-place notes. `memory_search` is loaded with every session (`alwaysLoad`), so the `ToolSearch` before the first search is gone.

`node --disable-warning=ExperimentalWarning scripts/memory-write-bench.ts 100000 4 50` (50 new notes, one every 20 ms, while a client refetches the map and the overview on every invalidation and searches for every written note not found yet): before, max stall 2.3–4.4 s and a note searchable after 4.0 s median, 5.1–10.6 s max; after, max stall 32–58 ms (most runs under 50 ms; the rest is 15 concurrent searches of the bench client in one turn), searchable after 230–260 ms median and 380–410 ms max, of which 300 ms is the watcher's debounce. The start is unchanged within noise (`memory-start-bench.ts 100000 4`: complete 3.1 s with a warm snapshot, the start stretch of 160–210 ms remains).

**Claude at 100k.** `scripts/memory-eval-vault.ts` writes six projects (35k/25k/20k/10k/6k/4k notes) of realistic one-fact notes with types, tags and wikilinks around 28 needle notes, three of them reached only through a `[[link]]`, and near-miss distractors (an older K-factor, another Redis cluster's policy, the pre-2026 dedup window). `node --disable-warning=ExperimentalWarning scripts/memory-claude-eval.ts 100000 [--measure] [--only 3,8]` measures what a session receives, then asks 15 questions through the Agent SDK as a work tab does (preset prompt with the work-tab append, `autoMemoryDirectory` on the project's vault folder, only the `memory_search` tool of a throwaway memory module, Read/Grep/Glob inside the temp dir). It uses the signed-in Claude login only: no user settings (`settingSources: []`), no session files (`persistSession: false`); a temp `CLAUDE_CONFIG_DIR` is not signed in. Not in the gate.

- Session prompt append: 1880 B (~470 tokens). `MEMORY.md` per project: 82–86 lines, 9885–9955 B (~2.5k tokens), all within `MEMORY_BUDGET` (100 lines / 10 KB).
- `memory_search` answer with the question itself as the query: 0.2–1.3 KB (≤ ~320 tokens) at the default limit 5, at most 6.4 KB (~1.6k tokens) at limit 20 before the change and 1.6 KB after; the needle ranked first in every case.
- Latency of the 17 queries Claude actually sent (3 rounds plus 1 more across the 15 s view TTL, 68 searches): before median 15 ms, p90 105 ms, max 1.1–1.8 s (a sync view rebuild when the TTL ran out or the deferred lint finished, and an OR fallback ranking every note with a common word); after median 5 ms, p90 20 ms, max 41 ms.

Model `claude-opus-5-5` (the CLI default for this login, no model set), three runs of 15 questions:

| run | search build | found | memory_search calls per question | context at start | peak context | input tokens per question, all calls |
|---|---|---|---|---|---|---|
| 1 | before | 15/15 | 1 each | 23.5–23.9k | 24.3–25.8k | 72.7k–124.6k |
| 2 | before | 15/15 | 1, two hops 2 | 23.5–23.9k | 24.3–26.5k | 95.6k–151.1k |
| 3 | rarer words in the OR fallback | 14/15 | 1, two hops 2 | 23.5–23.9k | 24.3–25.2k | 71.9k–147.2k |

Run 3 per question (hop: the answer is behind a `[[link]]`):

| # | project | hop | found | memory_search | other tools | context at start | peak context | input tokens, all calls | tool answers | turns |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | payments |  | y | 1 | 3 | 23627 | 24666 | 96897 | 0.8 KB | 5 |
| 2 | payments |  | y | 1 | 1 | 23617 | 24275 | 71872 | 0.6 KB | 3 |
| 3 | payments | yes | y | 1 | 4 | 23633 | 25085 | 97471 | 1.3 KB | 6 |
| 4 | payments |  | y | 1 | 2 | 23618 | 24359 | 96064 | 0.7 KB | 4 |
| 5 | payments |  | y | 1 | 2 | 23617 | 24326 | 96045 | 0.6 KB | 4 |
| 6 | infra |  | y | 1 | 2 | 23866 | 24640 | 97118 | 0.7 KB | 4 |
| 7 | infra |  | y | 1 | 1 | 23852 | 24485 | 72533 | 0.6 KB | 3 |
| 8 | infra | yes | y | 2 | 3 | 23854 | 25169 | 147187 | 1.4 KB | 6 |
| 9 | game-client |  | y | 1 | 2 | 23501 | 24295 | 95678 | 0.8 KB | 4 |
| 10 | game-client |  | y | 1 | 2 | 23499 | 24296 | 95706 | 0.6 KB | 4 |
| 11 | game-client |  | y | 1 | 4 | 23496 | 24635 | 120902 | 0.7 KB | 6 |
| 12 | mobile |  | y | 1 | 3 | 23535 | 24535 | 96266 | 0.7 KB | 5 |
| 13 | mobile |  | y | 1 | 3 | 23539 | 25164 | 98225 | 1.8 KB | 5 |
| 14 | data-pipeline | yes | n | 2 | 3 | 23800 | 25131 | 122501 | 1.3 KB | 6 |
| 15 | docs-site |  | y | 1 | 1 | 23803 | 24420 | 72389 | 0.5 KB | 3 |

"Other tools" are mostly `Read` of the note path the hit gives, one `ToolSearch` per session (the tool was deferred and loaded first; it loads with the session since, see Writes) and denied `Bash` calls. The miss in run 3: Claude read `event-dedup-window`, searched `pipeline constants dedup window`, got only that note again (every word of the query was in it, so AND returned one hit), and gave up instead of reading the linked note; runs 1 and 2 read it. After that run a search fills its limit with partial matches after the full ones: the same query now returns `event-dedup-window`, `pipeline-constants`, `dedup-before-2026`. The three-run cap was spent, so that change was checked offline, not with another Claude run.

Reading: memory costs a session about 3k tokens up front (append and `MEMORY.md`) and each search 0.1–0.5k; the peak context of a question stayed under 26.5k with a ~23.5k baseline. Search found the right note first for every question; the one miss was a hop the model did not follow.

## Left to the builder

The colours of the note types, the sample weights, the step sizes.

## Claude's calls

1. Superseded (see Measured): the start loads a snapshot and checks the vault in slices; `MEMORY.md`, `_index` and migrations wait until the whole vault was checked, so none is built from a half-read vault.
2. A view rebuild after a write costs about 250–400 ms at 60k notes, so the first search after a write is slower than 200 ms; searches between writes are well under.
3. "Orphan" is shown without a warning tone: the note rules ask for links only when needed, so most notes have none.
4. The map keeps every project visible (at least 24 notes or all of it) even when 1500 cannot hold the proportional share of every project.
