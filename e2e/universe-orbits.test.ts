// Satellites by state: pure code, no browser needed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SubagentInfo } from '../shared/contract.ts';
import { layoutUniverse } from '../web/src/home/universe/layout.ts';
import { advance, IDLE_PACE, orbitSession, pickOrbits, RUNNING_SUBAGENT_MS, runningSubagents, WORK_PACE } from '../web/src/home/universe/orbits.ts';
import { syntheticGraph } from './fixture-server.ts';

const NOW = 1_000_000_000;
const agent = (ago: number | null): SubagentInfo => ({ id: `a${ago}`, agentType: null, description: null, lastActivity: ago === null ? null : NOW - ago, tokens: 0 });

test('a working satellite flies clearly faster than a waiting one', () => {
  const run = (goal: number) => {
    const o = { phase: 0, pace: goal, goal };
    for (let i = 0; i < 600; i++) advance(o, 0.3, 1 / 30);
    return o.phase;
  };
  assert.ok(run(WORK_PACE) / run(IDLE_PACE) > 8, 'the difference has to be seen at a glance');
});

test('a change of pace eases and never moves the satellite', () => {
  const dt = 1 / 30;
  const o = { phase: 1.5, pace: IDLE_PACE, goal: IDLE_PACE };
  const speed = 0.3;
  for (let i = 0; i < 60; i++) advance(o, speed, dt);
  o.goal = WORK_PACE; // the session starts working
  let prev = o.phase;
  let prevPace = o.pace;
  for (let i = 0; i < 300; i++) {
    advance(o, speed, dt);
    const step = o.phase - prev;
    assert.ok(step > 0 && step <= speed * WORK_PACE * dt + 1e-9, `step ${i}: the phase jumped by ${step}`);
    assert.ok(o.pace >= prevPace, 'the pace rises without a bounce');
    assert.ok(o.pace - prevPace < 0.2, 'the pace rises smoothly');
    prev = o.phase;
    prevPace = o.pace;
  }
  assert.ok(WORK_PACE - o.pace < 0.01, 'and it settles');
  o.goal = IDLE_PACE;
  prev = o.phase;
  advance(o, speed, dt);
  assert.ok(o.phase - prev > speed * 3 * dt, 'slowing down does not stop it dead');
});

test('the direction of an orbit survives a change of pace', () => {
  const o = { phase: 0, pace: WORK_PACE, goal: IDLE_PACE };
  for (let i = 0; i < 90; i++) advance(o, -0.3, 1 / 30);
  assert.ok(o.phase < 0);
});

test('a subagent is running while its journal changed recently', () => {
  const s = { subagents: [agent(0), agent(RUNNING_SUBAGENT_MS - 1), agent(RUNNING_SUBAGENT_MS + 1), agent(null)] };
  assert.equal(runningSubagents(s, NOW), 2);
});

test('state of a session: waiting flies slowly, work flies fast, a background subagent is work', () => {
  assert.deepEqual(orbitSession({ id: 'a', status: 'idle', subagents: [] }, NOW), { id: 'a', working: false, subagents: 0 });
  assert.deepEqual(orbitSession({ id: 'b', status: 'waiting_permission', subagents: [agent(RUNNING_SUBAGENT_MS * 3)] }, NOW), { id: 'b', working: false, subagents: 0 });
  assert.deepEqual(orbitSession({ id: 'c', status: 'working', subagents: [] }, NOW), { id: 'c', working: true, subagents: 0 });
  assert.deepEqual(orbitSession({ id: 'd', status: 'idle', subagents: [agent(5000), agent(9000)] }, NOW), { id: 'd', working: true, subagents: 2 });
});

test('three satellites at most, working sessions first, in a stable order', () => {
  const one = (id: string, working: boolean) => ({ id, working, subagents: 0 });
  const picked = pickOrbits([one('d', false), one('a', false), one('c', true), one('b', false)], 3);
  assert.deepEqual(picked.map((s) => s.id), ['c', 'a', 'b']);
});

test('the core: its notes lie around the nucleus, without a drawn figure', () => {
  const graph = syntheticGraph(173, ['alpha', 'beta', 'gamma']);
  const l = layoutUniverse(graph);
  const core = l.constellations.find((c) => c.core)!;
  assert.ok(core.stars.length > 2);
  for (const i of core.stars) {
    const d = Math.hypot(l.stars[i].x - core.x, l.stars[i].z - core.z);
    assert.ok(d >= core.r * 0.41 && d <= core.r * 1.01, `a star of the core at ${d}`);
  }
  assert.ok(!l.skeleton.some(([a]) => l.stars[a].c === l.constellations.indexOf(core)), 'the core is not a constellation');
  assert.ok(l.skeleton.length > 0, 'the others still are');
});
