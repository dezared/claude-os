// Search of notes by meaning: the embedding model and the status of GET /api/memory/semantic.

// A multilingual sentence-embedding model with an ONNX export for transformers.js, pinned to a revision. It maps a Russian
// question close to the English note that answers it. `bytes` is what the q8 download takes from that revision (measured).
export const SEMANTIC_MODEL = {
  id: 'multilingual-e5-small',
  repo: 'Xenova/multilingual-e5-small',
  revision: '761b726dd34fb83930e26aab4e9ac3899aa1fa78',
  bytes: 135_392_016,
  dims: 384,
} as const;

export interface SemanticStatus {
  state: 'off' | 'downloading' | 'ready'; // of the model
  enabled: boolean; // the user's toggle; on by default once the model is downloaded
  model: string;
  modelBytes: number; // download size
  diskBytes: number; // what is in `dir` now
  downloaded: number | null; // while downloading
  dir: string;
  error: string | null;
  indexed: number; // notes with a vector
  total: number; // notes search covers
  indexBytes: number; // the vectors in memory
}
