import { fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { SessionInfo } from '@/lib/types';
import { Tag } from './admin/parts';

/** The row's stripe: only what works on Claude OS itself stands out, the rest is ordinary work. */
export function sessionStripe(s: Pick<SessionInfo, 'rootFolder' | 'serviceFolder' | 'osChanges' | 'project'>, repoProject?: string | null): string {
  if (s.rootFolder) return 'session-stripe session-stripe-root';
  if (s.serviceFolder) return 'session-stripe session-stripe-service';
  return (repoProject && s.project === repoProject) || s.osChanges ? 'session-stripe session-stripe-os' : '';
}

/** Where a session ran inside Claude OS and which level of it it changed. Absent for every other session. */
export function SessionTags({ s, repoProject }: { s: Pick<SessionInfo, 'rootFolder' | 'serviceFolder' | 'osChanges' | 'project'>; repoProject?: string | null }) {
  const changes = s.osChanges;
  return (
    <>
      {s.rootFolder && <Tag tone="accent" title={t('session.rootTagTitle')}>{t('session.rootTag')}</Tag>}
      {s.serviceFolder && <Tag tone="service" title={t('session.serviceTagTitle')}>{t('session.serviceTag')}</Tag>}
      {!s.rootFolder && !s.serviceFolder && !!repoProject && s.project === repoProject && <Tag tone="warn" title={t('session.osTagTitle')}>{t('session.osTag')}</Tag>}
      {!!changes?.user && <Tag tone="ok" title={t('session.levelUserTitle', { n: fmtInt(changes.user) })}>{t('session.levelUser')} {fmtInt(changes.user)}</Tag>}
      {!!changes?.root && <Tag tone="warn" title={t('session.levelRootTitle', { n: fmtInt(changes.root) })}>{t('session.levelRoot')} {fmtInt(changes.root)}</Tag>}
    </>
  );
}
