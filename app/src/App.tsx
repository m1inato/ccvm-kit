import { useCallback, useState } from 'react';
import { Ctx, errorText, useNow, useRoute, useSnapshot, type AppCtx } from './api';
import { StatusPill, Toast } from './components/common';
import { CapsulePage } from './pages/Capsule';
import { JobsPage } from './pages/Jobs';
import { ProjectPage } from './pages/Project';
import { SettingsPage } from './pages/Settings';
import { WelcomePage } from './pages/Welcome';
import { WorkspacePage } from './pages/Workspace';
import { act } from './api';

export function App() {
  const snap = useSnapshot();
  const now = useNow();
  const [route, go] = useRoute();
  const [toast, setToast] = useState<{ text: string; kind: 'error' | 'ok' } | null>(null);

  const run = useCallback<AppCtx['run']>(async (fn, okText) => {
    try {
      const result = await fn();
      if (okText) setToast({ text: okText, kind: 'ok' });
      return result;
    } catch (err) {
      setToast({ text: errorText(err), kind: 'error' });
      return undefined;
    }
  }, []);

  const isCapsule = route.startsWith('/capsule');
  document.documentElement.classList.toggle('capsule', isCapsule);
  if (!snap) return null;
  const ctx: AppCtx = { snap, now, go, run };
  if (isCapsule) {
    return (
      <Ctx.Provider value={ctx}>
        <CapsulePage />
      </Ctx.Provider>
    );
  }

  const [, page, arg] = route.split('/');
  const jobsRunning = snap.jobs.filter((j) => j.state === 'running');
  let body;
  switch (page) {
    case 'project':
      body = <ProjectPage name={decodeURIComponent(arg ?? '')} />;
      break;
    case 'welcome':
      body = <WelcomePage step={Number(arg) || 1} />;
      break;
    case 'settings':
      body = <SettingsPage tab={arg || 'egress'} />;
      break;
    case 'jobs':
      body = <JobsPage focus={arg} />;
      break;
    default:
      body = <WorkspacePage />;
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        {page !== 'welcome' && (
          <header className="topbar">
            <a className="brand" onClick={() => go('/')}>
              <span className="logo" />
              CCVM
            </a>
            <span className="spacer" />
            {jobsRunning.length > 0 && (
              <button className="btn sm ghost" onClick={() => go('/jobs')} title="后台任务">
                <span className="dot busy" />
                {jobsRunning[0].title}
                {jobsRunning.length > 1 ? ` 等 ${jobsRunning.length} 项` : ''}
              </button>
            )}
            <StatusPill snap={snap} onClick={() => go(snap.level === 'error' ? '/' : '/jobs')} />
            <button className="btn icon ghost" title="立即检查" disabled={snap.checking || snap.vm.status !== 'Running'} onClick={() => run(() => act('quickCheck'))}>
              ↻
            </button>
            <button className="btn icon ghost" title="后台任务" onClick={() => go('/jobs')}>
              ☰
            </button>
            <button className="btn icon ghost" title="设置" onClick={() => go('/settings')}>
              ⚙
            </button>
          </header>
        )}
        <div className="body">{body}</div>
      </div>
      {toast && <Toast text={toast.text} kind={toast.kind} onClose={() => setToast(null)} />}
    </Ctx.Provider>
  );
}
