// Reciprocal rank fusion of the FTS hits and the hits by meaning: a note's score is the sum of 1 / (K + rank) over the
// lists it is in. Ranks, not scores: BM25 and cosine are not on one scale.
import type { SearchHit } from '../search.ts';

const K = 60; // the usual constant: a top rank in one list counts about as much as a middling rank in both

export function fuse(fts: SearchHit[], semantic: SearchHit[], limit: number): SearchHit[] {
  const score = new Map<string, number>();
  const hit = new Map<string, SearchHit>();
  for (const list of [fts, semantic]) {
    list.forEach((h, rank) => {
      score.set(h.id, (score.get(h.id) ?? 0) + 1 / (K + rank + 1));
      if (!hit.has(h.id)) hit.set(h.id, h); // the FTS one first: its snippet marks the words
    });
  }
  // Map order is first-seen order, FTS first, and sort is stable: a tie keeps the FTS hit ahead.
  return [...hit.values()].sort((a, b) => score.get(b.id)! - score.get(a.id)!).slice(0, limit);
}
