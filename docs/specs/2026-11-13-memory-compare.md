# Memory system: before and after, by stage

Status: measured · Date: 2026-11-13 · Harness: `scripts/memory-compare.ts`, `scripts/memory-real-eval.ts`

The owner asked for the difference before and after the memory work, with numbers for each stage. Every number below was measured on a real server process of that stage's tree; none is copied from earlier specs.

## Stages

| stage | commit | what changed |
|---|---|---|
| S0 baseline | `1355ba6` | before the scale work: the whole view built on the first request, the map sent every note, the search index synced on every query |
| S1 scale | `0a25ecd` | 180-note advice removed, FTS synced after view rebuilds in steps, map sample of about 1,500 nodes, storage panel (`/api/memory/overview`) |
| S2 instant start | `fcf1d60` | snapshot of the scanned notes, start in slices, `fs.watch` per folder |
| S3 search by meaning | `c5fd442` | hybrid FTS + multilingual-e5-small vectors, when the model is installed |
| S4 incremental writes | `4fffb30` (= main) | a write patches the view instead of rebuilding it; `memory_search` is loaded with every session |

## Method

- `node --disable-warning=ExperimentalWarning scripts/memory-compare.ts --sizes 10000,100000 --runs 3 --model <e5 cache dir>` checks every stage out into a temp git worktree (`git worktree add --detach`, `node_modules` linked), and starts `server/index.ts` of that tree as a separate process with its own temp `HOME`, data, config, vault and Claude config dir, so nothing of the user's is read or written. Requests go over HTTP with the auth cookie, invalidations over the WebSocket, as the interface does.
- The vault is `writeEvalVault` of `scripts/memory-eval-vault.ts` (fixed seed: six projects of one-fact notes with types, tags and links, 28 needle notes, near-miss distractors) at 10,000 and 100,000 notes, written once and copied to the same path before every run. The harness generates it, so the older trees need no copy of the generator. All six projects are wiki-managed, so writes regenerate `MEMORY.md`.
- Each run: a cold start (fresh data dir), then the search, recall and map probes, then a stop and a second start over the same data dir (S2+: warm snapshot; S0–S1 have none and read every file again), then a burst of 50 new notes, one every 20 ms, while a client refetches the map and the overview on every `memory` invalidation and searches for every note written and not found yet. Three runs per stage and size; the tables show the median of the three.
- Times are from process spawn. "Server up" is the first `/health`; "first map answer" is the first `/api/memory/graph`; "view complete" is when the map's `total` (S1+) or node count (S0) covers every note; "search finds every needle" is when a search for each of the 28 needle names returns it.
- Event-loop stall: a preload (`scripts/memory-compare-loop.ts`, `node --import`) measures how late a 5 ms timer fires. The start window opens at the first `/health` (module loading is the same in every stage) and closes 1 s after search finds every needle; the burst window covers the writes and 1 s after the last note was found. RSS is `VmRSS`/`VmHWM` of the server process (the e5 engine runs in its own process and is not included).
- `memory_search` latency: the 15 questions of the Claude eval and the 5 keyword probes, 3 rounds, `limit=5`, through `/api/memory/search` (the route the tool's `find` sits behind since S3). Recall@5: the keyword, English paraphrase and Russian probe sets of `scripts/memory-semantic-eval.ts` (5, 17 and 17 queries), each must return its needle in the top 5 of its project.
- Search by meaning (S3, S4): the model installed in the data dir and every vector built before probing. Vectors of 100k notes take about 45 minutes here, so the 100k column uses a 20,000-note vault of the same generator. The vectors file format is the same in S3 and S4, so S4 builds them and S3 reuses the file (the build time is S4's).
- Machine: AMD Ryzen 7 4800H, 4 cores given to WSL2, Node 22.23.3. Other agent sessions ran in parallel; the 1-minute load average during the timing runs was 0.79–1.73.

## Results

**Start (from process spawn)**

| metric | notes | S0 | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|
| server up (/health) | 10k | 724 ms | 727 ms | 729 ms | 744 ms | 725 ms |
| server up (/health) | 100k | 1087 ms | 1140 ms | 792 ms | 769 ms | 809 ms |
| first map answer, cold | 10k | 1854 ms | 1415 ms | 788 ms | 814 ms | 778 ms |
| first map answer, cold | 100k | 9661 ms | 5452 ms | 861 ms | 839 ms | 879 ms |
| first map answer, warm snapshot | 10k | n/a (no snapshot) | n/a (no snapshot) | 800 ms | 788 ms | 777 ms |
| first map answer, warm snapshot | 100k | n/a (no snapshot) | n/a (no snapshot) | 749 ms | 782 ms | 755 ms |
| view complete, cold | 10k | 1854 ms | 1415 ms | 1459 ms | 1525 ms | 1608 ms |
| view complete, cold | 100k | 9661 ms | 5452 ms | 5914 ms | 5924 ms | 6866 ms |
| view complete, warm snapshot | 10k | n/a (no snapshot) | n/a (no snapshot) | 1139 ms | 1120 ms | 1254 ms |
| view complete, warm snapshot | 100k | n/a (no snapshot) | n/a (no snapshot) | 3073 ms | 2974 ms | 3783 ms |
| search finds every needle, cold | 10k | 2849 ms | 2611 ms | 2368 ms | 2415 ms | 2268 ms |
| search finds every needle, cold | 100k | 68.3 s | 11.5 s | 12.0 s | 12.2 s | 13.5 s |
| search finds every needle, warm | 10k | n/a (no snapshot) | n/a (no snapshot) | 2005 ms | 2014 ms | 1924 ms |
| search finds every needle, warm | 100k | n/a (no snapshot) | n/a (no snapshot) | 9114 ms | 9295 ms | 10.3 s |
| max event-loop stall in start, cold | 10k | 935 ms | 682 ms | 69 ms | 59 ms | 50 ms |
| max event-loop stall in start, cold | 100k | 12.6 s | 4332 ms | 256 ms | 266 ms | 188 ms |
| max event-loop stall in start, warm | 10k | n/a (no snapshot) | n/a (no snapshot) | 55 ms | 64 ms | 48 ms |
| max event-loop stall in start, warm | 100k | n/a (no snapshot) | n/a (no snapshot) | 273 ms | 251 ms | 197 ms |
| RSS after start, cold | 10k | 262 MB | 247 MB | 231 MB | 234 MB | 235 MB |
| RSS after start, cold | 100k | 1800 MB | 825 MB | 760 MB | 719 MB | 779 MB |
| peak RSS in start, cold | 10k | 263 MB | 247 MB | 240 MB | 235 MB | 235 MB |
| peak RSS in start, cold | 100k | 1853 MB | 825 MB | 760 MB | 719 MB | 779 MB |

**Second start**

| metric | notes | S0 | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|
| server up, 2nd start | 10k | 1964 ms | 1533 ms | 733 ms | 723 ms | 733 ms |
| server up, 2nd start | 100k | 12.8 s | 5427 ms | 712 ms | 728 ms | 725 ms |
| first map answer, 2nd start | 10k | 2176 ms | 1705 ms | 800 ms | 788 ms | 777 ms |
| first map answer, 2nd start | 100k | 13.6 s | 5804 ms | 749 ms | 782 ms | 755 ms |
| view complete, 2nd start (S0–S1 read every file, S2+ snapshot) | 10k | 2176 ms | 1705 ms | 1139 ms | 1120 ms | 1254 ms |
| view complete, 2nd start (S0–S1 read every file, S2+ snapshot) | 100k | 13.6 s | 5804 ms | 3073 ms | 2974 ms | 3783 ms |
| max stall, 2nd start | 10k | 145 ms | 127 ms | 55 ms | 64 ms | 48 ms |
| max stall, 2nd start | 100k | 13.0 s | 296 ms | 273 ms | 251 ms | 197 ms |

**Search (FTS; no model installed)**

| metric | notes | S0 | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|
| memory_search median | 10k | 34 ms | 14 ms | 4 ms | 4 ms | 4 ms |
| memory_search median | 100k | 419 ms | 154 ms | 34 ms | 35 ms | 25 ms |
| memory_search p90 | 10k | 40 ms | 20 ms | 6 ms | 6 ms | 6 ms |
| memory_search p90 | 100k | 12.4 s | 228 ms | 55 ms | 54 ms | 42 ms |
| memory_search max | 10k | 484 ms | 21 ms | 9 ms | 7 ms | 7 ms |
| memory_search max | 100k | 13.1 s | 1153 ms | 151 ms | 175 ms | 48 ms |
| recall@5 keywords | 10k | 100% | 100% | 100% | 100% | 100% |
| recall@5 keywords | 100k | 100% | 100% | 100% | 100% | 100% |
| recall@5 English paraphrase | 10k | 82% | 82% | 76% | 76% | 76% |
| recall@5 English paraphrase | 100k | 82% | 82% | 76% | 76% | 76% |
| recall@5 Russian | 10k | 0% | 0% | 0% | 0% | 0% |
| recall@5 Russian | 100k | 0% | 0% | 0% | 0% | 0% |

**Map and overview**

| metric | notes | S0 | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|
| map answer (warm) | 10k | 27 ms | 8 ms | 7 ms | 7 ms | 13 ms |
| map answer (warm) | 100k | 304 ms | 8 ms | 13 ms | 8 ms | 13 ms |
| map answer size | 10k | 3.3 MB | 503 KB | 502 KB | 502 KB | 502 KB |
| map answer size | 100k | 32.9 MB | 503 KB | 503 KB | 503 KB | 503 KB |
| map nodes sent | 10k | 10000 | 1497 | 1496 | 1496 | 1496 |
| map nodes sent | 100k | 100000 | 1497 | 1496 | 1496 | 1496 |
| overview answer | 10k | n/a (no route) | 6 ms | 12 ms | 11 ms | 3 ms |
| overview answer | 100k | n/a (no route) | 61 ms | 80 ms | 73 ms | 12 ms |
| overview size | 10k | n/a (no route) | 3 KB | 3 KB | 3 KB | 3 KB |
| overview size | 100k | n/a (no route) | 3 KB | 3 KB | 3 KB | 3 KB |

**Burst of 50 writes, one every 20 ms**

| metric | notes | S0 | S1 | S2 | S3 | S4 |
|---|---|---|---|---|---|---|
| max event-loop stall in the burst | 10k | 1531 ms | 88 ms | 100 ms | 101 ms | 60 ms |
| max event-loop stall in the burst | 100k | 40.9 s | 1146 ms | 1507 ms | 1537 ms | 433 ms |
| written note searchable, median | 10k | 1304 ms | 288 ms | 297 ms | 295 ms | 202 ms |
| written note searchable, median | 100k | 26.0 s | 6576 ms | 3457 ms | 3471 ms | 489 ms |
| written note searchable, max | 10k | 3165 ms | 493 ms | 494 ms | 483 ms | 346 ms |
| written note searchable, max | 100k | 40.9 s | 7096 ms | 3905 ms | 3917 ms | 766 ms |
| notes found of 50 (30 s) | 10k | 50 | 50 | 50 | 50 | 50 |
| notes found of 50 (30 s) | 100k | 18 | 50 | 50 | 50 | 50 |
| RSS after the burst | 10k | 351 MB | 246 MB | 227 MB | 237 MB | 247 MB |
| RSS after the burst | 100k | 1792 MB | 1262 MB | 1249 MB | 1001 MB | 926 MB |

**Search by meaning (vectors fully built)**

| stage | vault | vectors | recall@5 keywords | English paraphrase | Russian | search median / p90 / max | server RSS |
|---|---|---|---|---|---|---|---|
| S4 | 10k | built in 273.7 s | 100% | 88% | 76% | 12 ms / 16 ms / 17 ms | 234 MB |
| S3 | 10k | reused from S4 | 100% | 88% | 76% | 12 ms / 16 ms / 16 ms | 246 MB |
| S4 | 20k (for 100k) | built in 533.2 s | 100% | 88% | 76% | 14 ms / 20 ms / 22 ms | 278 MB |
| S3 | 20k (for 100k) | reused from S4 | 100% | 88% | 76% | 15 ms / 21 ms / 22 ms | 312 MB |

FTS-only recall is the same in S3 and S4 as in S2 because without the model those stages search exactly as S2 does; the gain of S3 is the table above.

## What each stage gave

**S0, baseline.** At 10k the start held the server for 0.9 s and a write burst for 1.5 s; at 100k everything was slow. The first map request built the whole view synchronously: 9.7 s from spawn, the longest stall of the start 12.6 s, a 33 MB answer of 100,000 nodes, 1.8 GB RSS. A search took 419 ms at the median and 12–13 s at p90, because a query could land on a full rebuild. In the write burst the server was frozen for 41 s at a stretch, and only 18 of 50 new notes were searchable within 30 s; the median of 26 s is of those 18 only. A second start over the same data dir was worse: the server did not answer even `/health` for 12.8 s at 100k (S1: 5.4 s), so the window had no server at all; the work before the server listens was not profiled.

**S1, scale.** The map became a sample: 503 KB and 1,497 nodes instead of 33 MB, 8 ms instead of 304 ms, and the storage overview appeared (61 ms at 100k). At 100k RSS fell from 1.8 GB to 825 MB, the search median from 419 ms to 154 ms and its p90 from 12.4 s to 228 ms, and the first map answer from 9.7 s to 5.5 s. The start still blocked: one stall of 4.3 s at 100k, about 0.7 s at 10k. A written note became searchable after 6.6 s at 100k, and all 50 were found.

**S2, instant start.** The first map answer is about 70 ms after the server is up at both sizes (0.86 s from spawn at 100k, against 5.5 s in S1), and the longest start stall fell from 4.3 s to about 0.26 s. With the warm snapshot the full view is ready in 3.1 s at 100k (5.9 s cold). Search got 4–5x faster again (median 34 ms, p90 55 ms, max 151 ms at 100k), and a written note was searchable after 3.5 s instead of 6.6 s. The burst still froze the server for 1.5 s at a stretch: every write batch rebuilt the view. One English paraphrase probe of 17 dropped out of the FTS top 5 here (82% to 76%); FTS ranking moved with the search changes, not investigated.

**S3, search by meaning.** Without the model S3 measures like S2. With the vectors built, recall@5 for Russian queries goes from 0% to 76% (13 of 17) and for English paraphrases from 76% to 88%, keywords stay at 100%, on 10k and on 20k notes alike. A search costs 12 ms median and 16–22 ms max with the query embedding, against 4 ms FTS-only at 10k. Building the vectors is the cost: 274 s for 10k notes and 533 s for 20k (about 27 ms a note, in the engine process; the server's RSS stays under 320 MB).

**S4, incremental writes.** Writes are what changed: at 100k a new note is searchable after 0.49 s median and 0.77 s max (S3: 3.5 s and 3.9 s), at 10k after 0.20 s; the longest stall during the burst fell from 1.5 s to 0.43 s at 100k and to 60 ms at 10k. The search max at 100k fell from 175 ms to 48 ms and the overview from 73 ms to 12 ms. The start got slower: the complete view takes 6.9 s cold and 3.8 s warm at 100k, against 5.9 s and 3.0 s in S2–S3, consistent over all three runs (6.8–6.9 s against 5.8–6.1 s). The longest start stall is lower (188 ms against 256–266 ms). The likely cause is the 10 ms slices taking one turn each (`ff1b428`), which trade throughput for shorter stalls; not profiled.

## Real notes with real Claude (S4)

`scripts/memory-real-eval.ts`: the owner's `vault/projects` (907 notes in 13 projects) copied read only into a temp dir, grown to 39,985 notes with generated filler notes in the same projects in proportion to their real size, all projects wiki-managed, every vector built (3,095 s for 40k notes). Each of 15 questions was asked once with the search by meaning on, then once more after `POST /api/memory/semantic/disable`, the way `scripts/memory-claude-eval.ts` asks: Agent SDK, the signed-in login, `settingSources: []`, no session files, only `memory_search` and Read/Grep/Glob on the vault (anything else is denied and counted under "other tools"). The answers exist only in the owner's notes; 6 questions were asked in Russian. The questions and their source notes are not in the repository.

| # | project (notes) | question, in short | lang | in MEMORY.md | on: correct | on: searches | on: other tools | on: input tokens | off: correct | off: searches | off: other tools | off: input tokens |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | A, backend (357) | a config ratio and why it is truncated | en | no | y | 1 | 2 | 97,991 | y | 1 | 2 | 99,545 |
| 2 | A | when a mirror domain expired | ru | no | y | 1 | 0 | 48,678 | y | 1 | 0 | 48,678 |
| 3 | A | the item limit of one bet | en | no | y | 1 | 2 | 98,787 | y | 1 | 2 | 98,826 |
| 4 | A | the cause of a delay between game rounds, and the round length | en | no | y | 1 | 4 | 101,861 | y | 1 | 6 | 129,934 |
| 5 | A | a coefficient of a balance rule | en | no | y | 1 | 2 | 99,123 | y | 1 | 2 | 99,104 |
| 6 | B, tabletop app (198) | how much shop food heals, and whether in combat | ru | yes | y | 0 | 2 | 73,870 | y | 0 | 1 | 48,927 |
| 7 | B | starting money of a player | en | no | y | 1 | 3 | 101,213 | y | 1 | 2 | 100,258 |
| 8 | B | the level cap of the first world | ru | no | y | 1 | 1 | 74,651 | y | 1 | 0 | 49,253 |
| 9 | B | the renderer's frame-rate target | ru | yes | y | 0 | 1 | 48,889 | y | 0 | 1 | 48,889 |
| 10 | C, game design (156) | the price of opening a genre | en | yes | y | 0 | 2 | 71,856 | y | 0 | 2 | 71,878 |
| 11 | C | an exponent of the review score | en | no | y | 1 | 3 | 123,136 | y | 1 | 3 | 98,906 |
| 12 | D, strategy design (33) | the starting population of a state | en | yes | y | 0 | 1 | 43,334 | y | 0 | 1 | 43,334 |
| 13 | D | the horizon a prototype world is judged over | ru | yes | y | 0 | 1 | 43,454 | y | 0 | 1 | 43,429 |
| 14 | E, community bots (21) | why some server features are missing | ru | yes | y | 0 | 1 | 42,195 | y | 0 | 1 | 42,195 |
| 15 | F, backend (19) | what a user field is for and whether logic may use it | en | yes | y | 0 | 1 | 42,363 | y | 0 | 1 | 42,363 |

Correct: 15/15 with the search by meaning, 15/15 without it; the model is the default of the signed-in login (the script does not record it), cost $1.58 for the first round and $0.43 for the second (the second reads the prompt cache the first wrote). "In MEMORY.md" is whether the owner's own `MEMORY.md` of that project lists the answering note; peak context per question was 21–27k tokens in both rounds.

What it shows: on real notes at 40k the answer was found every time, with at most one `memory_search` call. Where `MEMORY.md` listed the note (7 questions) Claude read it directly without searching; otherwise it searched once with English keywords, also for the Russian questions, which is why the search by meaning made no difference here: Claude translates before it searches, and FTS finds English keywords. The search by meaning matters where the query keeps the user's words (the Russian recall above, 0% to 76%) and for notes written in another wording than the question. The FTS-only reference on the generated 100k vault is the Claude eval of S2 in `2026-11-12-memory-scale.md` (three runs, 44 of 45 found). Each question was asked once per mode; with this few runs a one-question difference would be noise.

## Caveats

- The in-process write bench of the scale spec reported a burst stall of 32–58 ms at 100k for S4; a real server process shows 430–440 ms in every run. The process here also runs the journal, chat, tools and the WebSocket, and the client's requests are real HTTP requests; which of them holds the loop was not profiled.
- "Search finds every needle" polls 28 searches every 250 ms, so it is late by up to one poll, and at S0 the polling searches themselves are slow (each could trigger a sync).
- The start stall window opens at the first `/health`, so work done before the server listens (the S0 and S1 second starts) is not in the stall rows; it shows in "server up, 2nd start".
- S0 and S1 have no snapshot. Their "second start" rereads every file with a warm OS file cache; it is shown separately and never as "warm".
- Recall uses the eval vault's needle notes and their probe sets; the vault is generated, so recall on real notes is the Claude eval below.
- The search-by-meaning numbers at 100k are from a 20k vault. Brute force over vectors grows linearly; the S4 `topLater` reads 10,000 rows per event-loop turn.
- One machine, three runs each, other sessions active (load average 0.8–1.7); differences under about 15% are within noise.
