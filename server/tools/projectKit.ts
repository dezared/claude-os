// The project kit as the server offers it: one stored plan per project, an approval only the plan card sets,
// the apply with its stale check, the status, and the routes (ruling R4: the approval is a server-side flag).
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { promisify } from 'node:util';
import { KIT_APPLY_TOOL, type KitAnswers, type KitPlan, type KitPlanSummary, type KitStatusReport } from '../../shared/projectKit.ts';
import type { Ctx } from '../context.ts';
import { httpError, safely } from '../memory/util.ts';
import { applyKit, staleReason, type StoredPlan } from './kitApply.ts';
import { registerKitMetrics } from './kitMetrics.ts';
import { planKit, readLock } from './kitPlan.ts';
import { KIT_BUDGETS } from './kitRender.ts';

export interface KitPlanRequest { action?: 'install' | 'remove'; claudeMd?: string; rules?: Record<string, string>; answers?: KitAnswers }

export interface KitApi {
  status(): KitStatusReport;
  plan(tabId: string, input: KitPlanRequest): KitPlanSummary;
  get(planId: string): KitPlan;
  approve(planId: string, requestId: unknown): void;
  apply(planId: string): Promise<string>;
}

type ActiveKit = () => { id: string; dir: string; version: string } | null;
type Gate = (root: string) => Promise<string>;

const run = promisify(execFile);
// The gate stops its own steps at the budget; the rest covers git and the built-in checks, still below the Stop hook timeout.
export const GATE_TIMEOUT_MS = KIT_BUDGETS.stopMs + 60_000;

/** `node .claude/kit/gate.mjs` in the project; its output, red or green, is what the tab shows. */
export async function runGate(root: string): Promise<string> {
  try {
    const { stdout, stderr } = await run(process.execPath, ['.claude/kit/gate.mjs'], { cwd: root, timeout: GATE_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
    return `${stdout}${stderr}`.trim();
  } catch (err) {
    const e = err as Error & { stdout?: string; stderr?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}`.trim() || e.message;
  }
}

// The tab's folder, refused when it is the Claude OS checkout or inside it, symlinks resolved.
function projectRoot(ctx: Ctx, tabId: string): string {
  if (!ctx.chat) throw httpError(503, 'chat is not running');
  const root = safely(() => ctx.chat?.tabInfo(tabId).cwd ?? null, null);
  const real = root === null ? null : safely(() => realpathSync(root), null);
  if (root === null || real === null) throw httpError(404, 'no such tab or folder');
  const repo = realpathSync(ctx.paths.repo);
  if (real === repo || real.startsWith(`${repo}${sep}`)) throw httpError(422, 'the Claude OS folder cannot get a project kit');
  return root;
}

const summary = (plan: KitPlan): KitPlanSummary => ({ ...plan, files: plan.files.map((f) => ({ path: f.path, owner: f.owner, action: f.action, reason: f.reason })) });

function registerRoutes(ctx: Ctx, api: KitApi): void {
  ctx.app.get('/api/project-kit/status', async () => api.status());
  ctx.app.get<{ Params: { id: string } }>('/api/project-kit/plans/:id', async (req) => api.get(req.params.id));
  ctx.app.post<{ Params: { id: string }; Body: { requestId?: unknown } | null }>('/api/project-kit/plans/:id/approve', async (req) => {
    api.approve(req.params.id, req.body?.requestId);
    return { ok: true };
  });
}

function kitStatus(ctx: Ctx, kit: ReturnType<ActiveKit>): KitStatusReport {
  const projects = Object.fromEntries(ctx.journal.listProjects(true).map((p) => [p.key, readLock(p.root)?.kit ?? null]));
  return { kit: kit && { id: kit.id, version: kit.version }, projects };
}

async function applyStored(ctx: Ctx, stored: StoredPlan, gate: Gate, written: () => void): Promise<string> {
  if (stored.plan.empty) return 'nothing to do';
  try {
    const done = await applyKit(stored, { data: ctx.paths.data, audit: (a, t, d) => ctx.audit(a, t, d), gate });
    return `${done.written.length} files written${done.gate ? `\n${done.gate}` : ''}`;
  } finally {
    written();
    ctx.invalidate('projectKit');
  }
}

// Ruling R4: only the plan's own card approves it, so the request must be an open kit_apply card for this plan in its tab.
function assertCard(ctx: Ctx, stored: StoredPlan, requestId: unknown): void {
  const tabId = stored.tabId;
  const open = typeof requestId === 'string' && tabId ? safely(() => ctx.chat?.get(tabId).pendingPermission(requestId) ?? null, null) : null;
  if (open?.tool !== KIT_APPLY_TOOL || open.input.planId !== stored.plan.planId) throw httpError(403, 'only the Apply button on the open plan card approves a plan');
}

// A plan made with a kit that is no longer the enabled one is not applied.
function assertKit(kit: ReturnType<ActiveKit>, stored: StoredPlan): void {
  if (!kit) throw httpError(409, 'enable the project-kit plugin first');
  if (kit.version !== stored.plan.kit) throw httpError(409, `stale plan: the kit changed to ${kit.version}; call kit_plan again`);
}

export function createProjectKit(ctx: Ctx, activeKit: ActiveKit, gate: Gate = runGate): KitApi {
  // One plan per project: a new plan replaces the previous one.
  const plans = new Map<string, StoredPlan>();
  const dropMetrics = registerKitMetrics(ctx);
  const find = (planId: string): StoredPlan => {
    const stored = [...plans.values()].find((p) => p.plan.planId === planId);
    if (!stored) throw httpError(404, 'no such plan; call kit_plan again');
    return stored;
  };
  const api: KitApi = {
    status: () => kitStatus(ctx, activeKit()),
    plan(tabId, input) {
      const root = projectRoot(ctx, tabId);
      const kit = activeKit();
      if (!kit) throw httpError(409, 'enable the project-kit plugin first');
      const project = ctx.journal.projectForCwd(root);
      if (!project) throw httpError(422, `${root} is not a project`);
      const level = ctx.settings?.profile()?.questionLevel ?? null;
      const planned = planKit({ root, project, kit, data: ctx.paths.data, action: input.action ?? 'install', answers: input.answers ?? {}, claudeMd: input.claudeMd, rules: input.rules, level });
      plans.set(project, { ...planned, tabId });
      return summary(planned.plan);
    },
    get: (planId) => find(planId).plan,
    approve(planId, requestId) {
      const stored = find(planId);
      assertCard(ctx, stored, requestId);
      stored.plan.approved = true;
    },
    async apply(planId) {
      const stored = find(planId);
      if (!stored.plan.approved) throw httpError(403, 'not approved: only the Apply button on the plan card approves a plan');
      assertKit(activeKit(), stored);
      // Used or stale, a plan is spent: the next attempt starts from a fresh kit_plan.
      plans.delete(stored.plan.project);
      const stale = staleReason(stored.hashes, stored.plan.root);
      if (stale) throw httpError(409, stale);
      return applyStored(ctx, stored, gate, dropMetrics);
    },
  };
  registerRoutes(ctx, api);
  return api;
}
