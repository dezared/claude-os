import { useState } from 'react';
import { create } from 'zustand';
import { Button, Dialog } from '@/components/ui';
import { api, invalidateTopics } from '@/lib/api';
import { t } from '@/lib/i18n';
import { toast, toastError, useApp } from '@/lib/store';
import type { AgentRow, McpServer, Skill } from '@/lib/types';

type Removal = { agent: AgentRow } | { skill: Skill } | { server: string; definitions: McpServer[]; nameOf?: (key: string) => string } | null;

const useRemoval = create<{ removal: Removal; set: (r: Removal) => void }>((set) => ({ removal: null, set: (removal) => set({ removal }) }));

/** The menus live outside any component, so a dialog they open is mounted once in App. */
export const confirmRemoveSkill = (skill: Skill) => useRemoval.getState().set({ skill });
export const confirmRemoveAgent = (agent: AgentRow) => useRemoval.getState().set({ agent });
export const confirmRemoveMcp = (server: string, definitions: McpServer[], nameOf?: (key: string) => string) => useRemoval.getState().set({ server, definitions, nameOf });

const leavePage = (type: 'skill' | 'mcp' | 'agent', id: string, pane: 'skills' | 'mcp' | 'agents') => {
  const { view, go } = useApp.getState();
  if (view.kind === 'entity' && view.type === type && view.id === id) go({ kind: 'tools', pane });
};

function RemoveSkill({ skill, onClose }: { skill: Skill; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('ent.removeSkillTitle', { name: skill.name })} description={skill.isSymlink ? t('ent.removeSkillLink') : t('ent.removeSkillDesc')}>
      <code className="selectable mb-3 block rounded-md border border-line2 bg-bg p-2 font-mono text-[11.5px] wrap-anywhere text-soft">{skill.path}</code>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE', body: { confirmed: true } });
              invalidateTopics(['skills', 'overview']);
              toast(t('ent.skillRemoved', { name: skill.name }));
              leavePage('skill', skill.id, 'skills');
              onClose();
            } catch (e) {
              toastError(e);
              setBusy(false);
            }
          }}
        >
          {t('mcp.removeAction')}
        </Button>
      </div>
    </Dialog>
  );
}

function RemoveAgent({ agent, onClose }: { agent: AgentRow; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('agents.removeTitle', { name: agent.name })} description={agent.isSymlink ? t('agents.removeLink') : t('agents.removeDesc')}>
      <code className="selectable mb-3 block rounded-md border border-line2 bg-bg p-2 font-mono text-[11.5px] wrap-anywhere text-soft">{agent.path}</code>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/agents/${encodeURIComponent(agent.id)}`, { method: 'DELETE', body: { confirmed: true } });
              invalidateTopics(['agents', 'overview']);
              toast(t('agents.removed', { name: agent.name }));
              leavePage('agent', agent.id, 'agents');
              onClose();
            } catch (e) {
              toastError(e);
              setBusy(false);
            }
          }}
        >
          {t('mcp.removeAction')}
        </Button>
      </div>
    </Dialog>
  );
}

const SCOPE_LABEL = { user: 'adm.scopeGlobal', project: 'adm.scopeShared', local: 'adm.scopeLocal', plugin: 'adm.scopePlugin' } as const;

function RemoveMcp({ server, definitions, nameOf, onClose }: { server: string; definitions: McpServer[]; nameOf?: (key: string) => string; onClose: () => void }) {
  const [left, setLeft] = useState(definitions);
  const [busy, setBusy] = useState(false);
  const remove = async (s: McpServer) => {
    setBusy(true);
    try {
      await api(`/api/mcp/${encodeURIComponent(s.name)}?scope=${encodeURIComponent(s.scope)}${s.project ? `&project=${encodeURIComponent(s.project)}` : ''}`, { method: 'DELETE' });
      invalidateTopics(['mcp', 'overview']);
      toast(t('ent.mcpRemoved', { name: s.name }));
      const next = left.filter((x) => x !== s);
      setLeft(next);
      if (next.length === 0) {
        leavePage('mcp', server, 'mcp');
        onClose();
      }
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('mcp.removeTitle', { name: server })} description={t('ent.removeMcpDesc')} width={600}>
      <div className="flex flex-col gap-2">
        {left.map((s) => (
          <div key={`${s.scope}:${s.project ?? ''}`} className="flex items-center gap-3 rounded-md border border-line2 bg-bg p-2">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-soft">{t(SCOPE_LABEL[s.scope])}{s.project ? ` · ${nameOf?.(s.project) ?? s.project}` : ''}</div>
              <code className="selectable block font-mono text-[11.5px] wrap-anywhere text-muted">{s.file ?? s.summary}</code>
            </div>
            <Button variant="primary" disabled={busy} onClick={() => void remove(s)}>{t('mcp.removeAction')}</Button>
          </div>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
      </div>
    </Dialog>
  );
}

export function RemoveDialogs() {
  const removal = useRemoval((s) => s.removal);
  const close = () => useRemoval.getState().set(null);
  if (!removal) return null;
  if ('agent' in removal) return <RemoveAgent agent={removal.agent} onClose={close} />;
  return 'skill' in removal ? <RemoveSkill skill={removal.skill} onClose={close} /> : <RemoveMcp server={removal.server} definitions={removal.definitions} nameOf={removal.nameOf} onClose={close} />;
}
