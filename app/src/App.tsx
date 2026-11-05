import { useCallback, useEffect, useState } from 'react';
import { applyTermTheme } from './terms';
import { Ctx, errorText, useNow, useRoute, useSnapshot, type AppCtx } from './api';
import { SharesBadge, StatusPill, Toast } from './components/common';
import { FilesPage } from './pages/Files';
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

  // 主题：深色 / 浅色写在 data-theme 上；跟随系统时去掉，交给 prefers-color-scheme
  const theme = snap?.settings.theme ?? 'system';
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
    applyTermTheme();
    const mq = window.matchMedia('(prefers-color-scheme: light)');
    mq.addEventListener('change', applyTermTheme);
    return () => mq.removeEventListener('change', applyTermTheme);
  }, [theme]);

  const isCapsule = route.startsWith('/capsule');
  document.documentElement.classList.toggle('capsule-window', isCapsule);
  if (!snap) return null;
  const ctx: AppCtx = { snap, now, go, run };
  if (isCapsule) {
    return (
      <Ctx.Provider value={ctx}>
        <CapsulePage notice={toast?.kind === 'error' ? toast.text : undefined} onCloseNotice={() => setToast(null)} />
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
    case 'files':
      body = <FilesPage path={arg ? decodeURIComponent(arg) : '/home/cc/work'} />;
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
            {jobsRunning.length > 0 && snap.level !== 'busy' && (
              <button className="btn sm ghost" onClick={() => go('/jobs')} title="后台任务">
                <span className="dot busy" />
                {jobsRunning[0].title}
                {jobsRunning.length > 1 ? ` 等 ${jobsRunning.length} 项` : ''}
              </button>
            )}
            <StatusPill snap={snap} onClick={() => go(snap.level === 'error' ? '/' : '/jobs')} />
            <SharesBadge snap={snap} onClick={() => go('/settings/shares')} />
            <button className="btn sm ghost" title="VM 里的文件" disabled={snap.vm.status !== 'Running'} onClick={() => go('/files')}>
              文件
            </button>
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
