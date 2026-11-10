import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// A set of names the type system cannot tie to the places that must mention them (files, prompt references).
export type Touchpoint = {
  name: string;
  source: string;
  memberRegex: string; // capture group 1 of every match (flags gm) in `source` is a member
  registries?: string[]; // files that must mention every member
  fileExists?: string; // path template with {member} that must exist
  reverseDir?: string; // every *.md stem in this folder must be a member
};

export type TouchpointFs = { read(path: string): string | null; list(dir: string): string[] };

const REPO = fileURLToPath(new URL('..', import.meta.url));

export const realFs: TouchpointFs = {
  read: (path) => {
    try {
      return readFileSync(join(REPO, path), 'utf8');
    } catch {
      return null;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(join(REPO, dir));
    } catch {
      return [];
    }
  },
};

export function readTouchpoints(): Touchpoint[] {
  return JSON.parse(readFileSync(join(REPO, 'docs/rules/touchpoints.json'), 'utf8'));
}

export function touchpointGaps(entries: Touchpoint[], fs: TouchpointFs): string[] {
  const gaps: string[] = [];
  for (const t of entries) {
    const text = fs.read(t.source);
    if (text === null) {
      gaps.push(`${t.name}: source ${t.source} not found`);
      continue;
    }
    // An empty match means the regex drifted from the source, not that the set is empty.
    const members = [...text.matchAll(new RegExp(t.memberRegex, 'gm'))].map((m) => m[1]);
    if (!members.length) gaps.push(`${t.name}: no members match ${t.memberRegex} in ${t.source}`);
    for (const registry of t.registries ?? []) {
      const body = fs.read(registry);
      if (body === null) gaps.push(`${t.name}: registry ${registry} not found`);
      else for (const m of members) if (!body.includes(m)) gaps.push(`${t.name}: ${m} is missing from ${registry}`);
    }
    if (t.fileExists) {
      for (const m of members) {
        const path = t.fileExists.replaceAll('{member}', m);
        if (fs.read(path) === null) gaps.push(`${t.name}: ${m} has no ${path}`);
      }
    }
    if (t.reverseDir) {
      for (const file of fs.list(t.reverseDir)) {
        const stem = file.slice(0, -3);
        if (file.endsWith('.md') && !members.includes(stem)) gaps.push(`${t.name}: ${t.reverseDir}/${file} has no member in ${t.source}`);
      }
    }
  }
  return gaps;
}

function main() {
  const gaps = touchpointGaps(readTouchpoints(), realFs);
  for (const gap of gaps) console.log(gap);
  if (gaps.length) {
    console.error(`check:touchpoints: ${gaps.length} gap(s)`);
    process.exitCode = 1;
    return;
  }
  console.log('check:touchpoints: clean');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
