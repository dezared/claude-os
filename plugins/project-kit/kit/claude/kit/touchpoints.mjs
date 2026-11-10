// Registries the type system cannot see, listed in <docsDir>/rules/touchpoints.json; an empty list skips the check.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { invoked, projectRoot, readKit } from './metrics.mjs';

// A Touchpoint: { name, source, memberRegex, registries?, fileExists?, reverseDir? }.
// Capture group 1 of every match (flags gm) of memberRegex in source is a member; every registry must mention
// every member; fileExists is a path template with {member}; every *.md stem in reverseDir must be a member.

export function fsAt(root) {
  return {
    read: (file) => {
      try {
        return readFileSync(path.join(root, file), 'utf8');
      } catch {
        return null;
      }
    },
    list: (dir) => {
      try {
        return readdirSync(path.join(root, dir));
      } catch {
        return [];
      }
    },
  };
}

// A missing list means no touchpoints yet; an unreadable one throws, so the gate step reports it.
export function readTouchpoints(root, config) {
  const file = path.join(root, config.docsDir, 'rules/touchpoints.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}

function registryGaps(t, members, fs) {
  return (t.registries ?? []).flatMap((registry) => {
    const body = fs.read(registry);
    if (body === null) return [`${t.name}: registry ${registry} not found`];
    return members.filter((m) => !body.includes(m)).map((m) => `${t.name}: ${m} is missing from ${registry}`);
  });
}

function fileGaps(t, members, fs) {
  if (!t.fileExists) return [];
  return members
    .map((m) => [m, t.fileExists.replaceAll('{member}', m)])
    .filter(([, file]) => fs.read(file) === null)
    .map(([m, file]) => `${t.name}: ${m} has no ${file}`);
}

function reverseGaps(t, members, fs) {
  if (!t.reverseDir) return [];
  return fs
    .list(t.reverseDir)
    .filter((file) => file.endsWith('.md') && !members.includes(file.slice(0, -3)))
    .map((file) => `${t.name}: ${t.reverseDir}/${file} has no member in ${t.source}`);
}

function entryGaps(t, fs) {
  const text = fs.read(t.source);
  if (text === null) return [`${t.name}: source ${t.source} not found`];
  const members = [...text.matchAll(new RegExp(t.memberRegex, 'gm'))].map((m) => m[1]);
  // An empty match means the regex drifted from the source, not that the set is empty.
  const drift = members.length ? [] : [`${t.name}: no members match ${t.memberRegex} in ${t.source}`];
  return [...drift, ...registryGaps(t, members, fs), ...fileGaps(t, members, fs), ...reverseGaps(t, members, fs)];
}

export const touchpointGaps = (entries, fs) => entries.flatMap((t) => entryGaps(t, fs));

function main() {
  const root = projectRoot(process.cwd());
  const gaps = touchpointGaps(readTouchpoints(root, readKit(root)), fsAt(root));
  for (const gap of gaps) console.log(gap);
  console.log(gaps.length ? `touchpoints: ${gaps.length} gap(s)` : 'touchpoints: clean');
  return gaps.length ? 1 : 0;
}

if (invoked(import.meta.url)) process.exitCode = main();
