// Lanes for the log, newest commit first. Pure: the log only draws it.
export interface GraphEdge { from: number; to: number; }
export interface GraphRow { lane: number; top: GraphEdge[]; bottom: GraphEdge[]; width: number; }

export function buildGraph(commits: { hash: string; parents: string[] }[]): GraphRow[] {
  const lanes: (string | null)[] = [];
  const free = () => {
    const i = lanes.indexOf(null);
    return i === -1 ? lanes.length : i;
  };
  return commits.map((c) => {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) lane = free();
    const top: GraphEdge[] = [];
    lanes.forEach((h, i) => {
      if (h !== null) top.push({ from: i, to: h === c.hash ? lane : i });
    });
    lanes.forEach((h, i) => {
      if (h === c.hash) lanes[i] = null;
    });
    lanes[lane] = null;

    const bottom: GraphEdge[] = [];
    lanes.forEach((h, i) => {
      if (h !== null) bottom.push({ from: i, to: i });
    });
    c.parents.forEach((p, k) => {
      let to = lanes.indexOf(p);
      if (to === -1) {
        to = k === 0 ? lane : free();
        lanes[to] = p;
      }
      bottom.push({ from: lane, to });
    });
    bottom.sort((a, b) => a.from - b.from || a.to - b.to);
    const width = Math.max(lane, ...top.flatMap((e) => [e.from, e.to]), ...bottom.flatMap((e) => [e.from, e.to])) + 1;
    return { lane, top, bottom, width };
  });
}
