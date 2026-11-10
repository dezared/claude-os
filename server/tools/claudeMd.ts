// The CLAUDE.md files as files: where they are, what they say, edits with a diff and a backup.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ClaudeMdFile, ClaudeMdReport } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { backupFile, httpError, safely, sha256, unifiedDiff } from '../memory/util.ts';

export function createClaudeMd(ctx: Ctx) {
  const projectRoot = (key: string) => safely(() => ctx.journal.listProjects(true), []).find((p) => p.key === key)?.root ?? null;

  function pathFor(scope: unknown, project?: string | null): string | null {
    if (scope === 'global') return join(ctx.paths.claudeDir, 'CLAUDE.md');
    if (scope === 'root') return join(ctx.paths.root, 'CLAUDE.md');
    if (scope === 'project' && project) {
      const root = projectRoot(project);
      return root ? join(root, 'CLAUDE.md') : null;
    }
    return null;
  }

  function file(scope: ClaudeMdFile['scope'], path: string): ClaudeMdFile {
    const content = safely(() => readFileSync(path, 'utf8'), null);
    return {
      scope, path, exists: content !== null, content: content ?? '', version: sha256(content ?? ''),
      updatedAt: content === null ? null : safely(() => statSync(path).mtimeMs, null),
    };
  }

  function report(project: string | null): ClaudeMdReport {
    const files = [file('global', pathFor('global')!), file('root', pathFor('root')!)];
    const projectPath = project ? pathFor('project', project) : null;
    if (projectPath) files.push(file('project', projectPath));
    return { files };
  }

  function required(scope: unknown, project: unknown): { path: string; scope: ClaudeMdFile['scope'] } {
    const path = pathFor(scope, typeof project === 'string' ? project : null);
    if (!path) throw httpError(400, 'unknown file');
    return { path, scope: scope as ClaudeMdFile['scope'] };
  }

  function preview(body: { scope?: unknown; project?: unknown; content?: unknown }): { diff: string } {
    if (typeof body.content !== 'string') throw httpError(400, 'content is required');
    const { path, scope } = required(body.scope, body.project);
    return { diff: unifiedDiff(file(scope, path).content, body.content, 'CLAUDE.md') };
  }

  function save(body: { scope?: unknown; project?: unknown; content?: unknown; version?: unknown }): ClaudeMdFile {
    if (typeof body.content !== 'string') throw httpError(400, 'content is required');
    const { path, scope } = required(body.scope, body.project);
    const before = file(scope, path);
    if (body.version !== before.version) throw httpError(409, 'the file changed on disk: reload it');
    if (before.exists) backupFile(ctx.paths.data, path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body.content);
    ctx.audit('claude-md.update', path, unifiedDiff(before.content, body.content, 'CLAUDE.md'));
    return file(scope, path);
  }

  return { report, pathFor, preview, save };
}
