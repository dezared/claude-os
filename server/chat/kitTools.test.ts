// The kit tools of a work tab over the real plan store: the summary Claude reads, and no apply the card did not approve.
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { KIT_APPLY_TOOL } from '../../shared/projectKit.ts';
import type { ChatApi } from '../context.ts';
import { makeKit } from '../memory/testkit.ts';
import { copyFixture } from '../tools/kitFixtures.ts';
import { createProjectKit } from '../tools/projectKit.ts';
import { kitTools, NOT_APPROVED } from './kitTools.ts';

const KIT = { id: 'project-kit', dir: join(import.meta.dirname, '..', '..', 'plugins', 'project-kit', 'kit'), version: '1.0.0' };
const dirs: string[] = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));

function setup(gate: (root: string) => Promise<string> = async () => 'gate: green') {
  const root = copyFixture('go');
  const kit = makeKit({ projectForCwd: () => 'proj' });
  dirs.push(root, kit.base);
  // The card of a kit_apply call waits in tab-1 while the user looks at it.
  let cardPlan = '';
  const pendingPermission = (requestId: string) => (requestId === 'card' ? { tool: KIT_APPLY_TOOL, input: { planId: cardPlan } } : null);
  kit.ctx.chat = { tabInfo: () => ({ cwd: root, project: 'proj', kind: 'work' }), get: () => ({ pendingPermission }) } as unknown as ChatApi;
  kit.ctx.kit = createProjectKit(kit.ctx, () => KIT, gate);
  const [planTool, applyTool] = kitTools(kit.ctx, 'tab-1');
  const approve = (planId: string, shownPlan = planId) => {
    cardPlan = shownPlan;
    return kit.app.inject({ method: 'POST', url: `/api/project-kit/plans/${planId}/approve`, payload: { requestId: 'card' } });
  };
  return { root, kit, approve, plan: () => call(planTool, {}), apply: (planId: string) => call(applyTool, { planId }) };
}

type KitTool = ReturnType<typeof kitTools>[number];
async function call(t: KitTool, args: Record<string, unknown>) {
  const r = await (t.handler as (a: unknown, extra: unknown) => ReturnType<KitTool['handler']>)(args, {});
  return { text: r.content.map((c) => ('text' in c ? c.text : '')).join(''), isError: r.isError === true };
}

const planIdOf = (text: string) => /^plan (\S+):/.exec(text)?.[1] ?? '';

test('kit_plan returns a summary and kit_apply refuses a plan the card did not approve', async () => {
  const { root, approve, plan, apply } = setup();
  const summary = await plan();
  assert.equal(summary.isError, false);
  assert.match(summary.text, /^plan \S+: install kit 1\.0\.0 in /);
  assert.match(summary.text, /^add \d+:$/m);
  assert.match(summary.text, /^ {2}\.claude\/kit\/kit\.json$/m);
  const planId = planIdOf(summary.text);

  // Bypass or auto mode: no card was shown, so nothing approved the plan, and the answer says how to get one.
  assert.deepEqual(await apply(planId), { text: NOT_APPROVED, isError: true });
  assert.match(NOT_APPROVED, /ask the user to switch this tab to the Default mode/);
  assert.equal(existsSync(join(root, '.claude')), false);

  // A request to the approve route counts only for the plan the open card shows.
  assert.equal((await approve(planId, 'another-plan')).statusCode, 403);
  assert.deepEqual(await apply(planId), { text: NOT_APPROVED, isError: true });
  await approve(planId);
  const done = await apply(planId);
  assert.equal(done.isError, false);
  assert.match(done.text, /^\d+ files written\ngate: green$/);
  assert.deepEqual(await apply(planId), { text: 'no such plan; call kit_plan again', isError: true });

  const again = await plan();
  assert.match(again.text, /^plan \S+: update kit 1\.0\.0 in .+\nnothing to do$/);
});

test('kit_apply clips the gate output to 60 lines', async () => {
  const { approve, plan, apply } = setup(async () => Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n'));
  const planId = planIdOf((await plan()).text);
  await approve(planId);
  const lines = (await apply(planId)).text.split('\n');
  assert.equal(lines.length, 61);
  assert.equal(lines[59], 'line 59');
  assert.equal(lines[60], '(41 more lines: run node .claude/kit/gate.mjs in the project to see them all)');
});

test('kit tools without the kit engine say so', async () => {
  const kit = makeKit();
  dirs.push(kit.base);
  const [planTool] = kitTools(kit.ctx, 'tab-1');
  assert.deepEqual(await call(planTool, {}), { text: 'the project kit is not available', isError: true });
});
