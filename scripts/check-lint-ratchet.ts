import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type Rules = Record<string, unknown>;
type Override = { files: string[]; rules: Rules };
export type OxlintConfig = { plugins?: string[]; rules?: Rules; categories?: Rules; overrides?: Override[]; ignorePatterns?: string[] };

const CONFIG = '.oxlintrc.json';
const SEVERITY: Record<string, number> = { off: 0, allow: 0, warn: 1, error: 2, deny: 2 };
const SEVERITY_NAME = ['off', 'warn', 'error'];
// What oxlint enables when `plugins` is absent (`oxlint --print-config`); setting `plugins` replaces this set.
const DEFAULT_PLUGINS = ['unicorn', 'typescript', 'oxc'];

function severity(value: unknown): number {
  const level = Array.isArray(value) ? value[0] : value;
  if (typeof level === 'number') return level;
  return SEVERITY[String(level)] ?? 0;
}

// Numeric options of a rule: `["error", 10]` gives { max: 10 }, `["error", { max: 300 }]` gives { max: 300 }.
function limits(value: unknown): Record<string, number> {
  const found: Record<string, number> = {};
  if (!Array.isArray(value)) return found;
  value.slice(1).forEach((option, i) => {
    if (typeof option === 'number') found[i === 0 ? 'max' : String(i)] = option;
    else if (option && typeof option === 'object') {
      for (const [key, n] of Object.entries(option)) if (typeof n === 'number') found[key] = n;
    }
  });
  return found;
}

// One message per loosening of `name`: a lower severity, or a numeric option raised or dropped.
function compareRule(where: string, name: string, base: unknown, current: unknown): string[] {
  const from = severity(base);
  const to = severity(current);
  if (to < from) return [`${where}${name}: ${SEVERITY_NAME[from]} -> ${SEVERITY_NAME[to]}`];
  if (from === 0) return [];
  const now = limits(current);
  return Object.entries(limits(base))
    .filter(([key, n]) => !(key in now) || now[key] > n)
    .map(([key, n]) => `${where}${name}: ${key} ${n} -> ${now[key] ?? 'unset'}`);
}

function compareRules(where: string, base: Rules, current: Rules): string[] {
  return Object.keys(base).flatMap((name) => compareRule(where, name, base[name], current[name]));
}

// Top-level rules: a rule absent at the base is held to `error`, as in compareOverrides.
function compareTopRules(base: Rules, current: Rules): string[] {
  const names = new Set([...Object.keys(base), ...Object.keys(current)]);
  return [...names].flatMap((name) => compareRule('', name, name in base ? base[name] : 'error', current[name]));
}

function comparePlugins(base: OxlintConfig, current: OxlintConfig): string[] {
  const now = new Set(current.plugins ?? DEFAULT_PLUGINS);
  return (base.plugins ?? DEFAULT_PLUGINS).filter((name) => !now.has(name)).map((name) => `plugins: dropped ${name}`);
}

const identity = (override: Override) => [...override.files].sort().join(', ');

// An override may only keep or tighten what it had; a rule it adds is held to the base top-level value, else to `error`.
function compareOverrides(base: OxlintConfig, current: OxlintConfig): string[] {
  const before = new Map((base.overrides ?? []).map((o) => [identity(o), o.rules]));
  return (current.overrides ?? []).flatMap((override) => {
    const id = identity(override);
    const rules = before.get(id);
    if (!rules) return [`override [${id}]: new override`];
    return Object.keys(override.rules).flatMap((name) => {
      const was = name in rules ? rules[name] : (base.rules?.[name] ?? 'error');
      return compareRule(`override [${id}] `, name, was, override.rules[name]);
    });
  });
}

export function ratchetViolations(base: OxlintConfig, current: OxlintConfig): string[] {
  const ignored = new Set(base.ignorePatterns ?? []);
  return [
    ...compareTopRules(base.rules ?? {}, current.rules ?? {}),
    ...compareRules('category ', base.categories ?? {}, current.categories ?? {}),
    ...compareOverrides(base, current),
    ...comparePlugins(base, current),
    ...(current.ignorePatterns ?? []).filter((p) => !ignored.has(p)).map((p) => `ignorePatterns: new pattern ${p}`),
  ];
}

export function mergeBase(cwd: string): string {
  return execFileSync('git', ['merge-base', 'HEAD', 'main'], { cwd, encoding: 'utf8' }).trim();
}

function readBase(cwd: string, base: string): OxlintConfig | null {
  let text: string;
  try {
    text = execFileSync('git', ['show', `${base}:${CONFIG}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null; // absent at the base: nothing to ratchet against yet
  }
  return JSON.parse(text) as OxlintConfig;
}

function main() {
  const cwd = process.cwd();
  const base = mergeBase(cwd);
  const before = readBase(cwd, base);
  if (!before) {
    console.log(`check:lint-ratchet: no ${CONFIG} at ${base.slice(0, 7)}, nothing to compare`);
    return;
  }
  const violations = ratchetViolations(before, JSON.parse(readFileSync(CONFIG, 'utf8')) as OxlintConfig);
  for (const v of violations) console.log(v);
  if (violations.length) {
    console.error(`check:lint-ratchet: ${violations.length} loosening(s) of ${CONFIG} since ${base.slice(0, 7)}`);
    process.exitCode = 1;
    return;
  }
  console.log('check:lint-ratchet: clean');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
