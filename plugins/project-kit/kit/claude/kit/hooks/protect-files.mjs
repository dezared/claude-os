// PreToolUse Edit|Write: refuses edits to secrets, git internals, lockfiles, the kit itself and the paths kit.json protects.
import path from 'node:path';

// Kit modules load at run time, so a missing one is one warning line and exit 0 (fail-open), not a crash.
async function load(hook, specs) {
  try {
    return await Promise.all(specs.map((spec) => import(spec)));
  } catch (error) {
    console.log(`kit ${hook}: ${String(error?.message ?? error).replace(/\s*\n\s*/g, ' ')}`);
    return specs.map(() => ({ invoked: () => false }));
  }
}

const [{ failOpen, invoked, projectPath, projectRoot, readInput, readKit }, { matchesAny }] = await load('protect-files', ['../metrics.mjs', '../size.mjs']);

const LOCKFILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'uv.lock', 'poetry.lock', 'Pipfile.lock', 'pdm.lock', 'go.sum', 'Cargo.lock',
]);

const RULES = [
  [(parts) => parts.at(-1).startsWith('.env'), 'environment files hold secrets'],
  [(parts) => parts.includes('.git'), 'git internals'],
  [(parts) => LOCKFILES.has(parts.at(-1)), 'a lockfile; change dependencies with the package manager'],
  [(parts) => parts[0] === '.claude' && parts[1] === 'kit', 'kit files change only through a kit update in Claude OS'],
];

export function protectReason(filePath, projectDir, config) {
  const rel = projectPath(projectDir, filePath);
  if (rel === null) return null;
  const parts = rel.split(path.sep);
  const shown = parts.join('/');
  const rule = RULES.find(([test]) => test(parts));
  if (rule) return `${shown} is protected: ${rule[1]}.`;
  if (matchesAny(shown, config.protected ?? [])) return `${shown} is protected: listed in .claude/kit/kit.json (generated or kept by the user).`;
  return null;
}

async function main() {
  const input = readInput();
  const root = projectRoot(input.cwd);
  const config = readKit(root);
  const reason = protectReason(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? '', root, config);
  if (!reason) return 0;
  process.stderr.write(`protect-files: ${reason}\n`);
  return 2;
}

if (invoked(import.meta.url)) await failOpen('protect-files', main);
