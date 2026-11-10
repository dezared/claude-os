import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './styles.css';
import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ScreenBoundary } from './components/CrashCard';
import { useApi } from './lib/api';
import { sendPendingFix, watchUncaughtErrors } from './lib/crash';
import { applyProfileLanguage, useLang } from './lib/i18n';
import { popoutRoute } from './lib/popout';
import type { SettingsView } from './lib/types';
import { connectSocket } from './lib/ws';
import { PopoutApp } from './popout/PopoutApp';

const route = popoutRoute();

// Changing the language remounts the app: strings are plain t() calls with no subscriptions.
// The outer boundary catches what lives outside the screens: the title bar, panels and dialogs.
// The UI language follows profile.language; on its own so a settings change re-renders nothing else.
function ProfileLanguage() {
  const profileLang = useApi<SettingsView>('/api/settings', ['settings']).data?.profile?.language ?? null;
  useEffect(() => applyProfileLanguage(profileLang), [profileLang]);
  return null;
}

function Root() {
  const lang = useLang((s) => s.lang);
  return (
    <>
      <ProfileLanguage />
      <ScreenBoundary resetKey={lang} where="app shell">
        {route ? <PopoutApp key={lang} route={route} /> : <App key={lang} />}
      </ScreenBoundary>
    </>
  );
}

watchUncaughtErrors();
connectSocket();
void sendPendingFix();
createRoot(document.getElementById('root')!).render(<Root />);
