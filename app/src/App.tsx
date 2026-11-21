import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { applyTermTheme, isLightTheme } from './terms';
import { act, Ctx, errorText, useApp, useNow, useRoute, useSnapshot, type AppCtx } from './api';
import type { Snapshot } from '../core/types';
import { Dot, Toast } from './components/common';
import { Icon, Logo, type IconName } from './components/Icon';
import { FilesPage } from './pages/Files';
import { CapsulePage } from './pages/Capsule';
import { JobsPage } from './pages/Jobs';
import { NetworkPage } from './pages/Network';
import { PortsPage } from './pages/Ports';
import { ProjectPage } from './pages/Project';
import { SettingsPage } from './pages/Settings';
import { WelcomePage } from './pages/Welcome';
import { WorkspacePage } from './pages/Workspace';

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

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), toast.kind === 'ok' ? 3000 : 8000);
    return () => clearTimeout(t);
  }, [toast]);

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
  if (page === 'welcome') {
    return (
      <Ctx.Provider value={ctx}>
        <div className="app">
          <WelcomePage step={Number(arg) || 1} />
        </div>
        {toast && <Toast text={toast.text} kind={toast.kind} onClose={() => setToast(null)} />}
      </Ctx.Provider>
    );
  }

  let body: ReactNode;
  let nav = 'projects';
  switch (page) {
    case 'project':
      body = <ProjectPage name={decodeURIComponent(arg ?? '')} />;
      break;
    case 'network':
      body = <NetworkPage />;
      nav = 'network';
      break;
    case 'ports':
      body = <PortsPage tab={arg} />;
      nav = 'ports';
      break;
    case 'settings':
      body = <SettingsPage tab={arg || 'vm'} />;
      nav = 'settings';
      break;
    case 'jobs':
      body = <JobsPage focus={arg} />;
      nav = 'jobs';
      break;
    case 'files':
      body = <FilesPage path={arg ? decodeURIComponent(arg) : '/home/cc/work'} />;
      nav = 'files';
      break;
    default:
      body = <WorkspacePage />;
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className="app">
        <Sidebar snap={snap} nav={nav} go={go} />
        <main className="main">
          <div className="main-top">
            <TopActions snap={snap} />
          </div>
          {body}
        </main>
      </div>
      {toast && <Toast text={toast.text} kind={toast.kind} onClose={() => setToast(null)} />}
    </Ctx.Provider>
  );
}

function Sidebar({ snap, nav, go }: { snap: Snapshot; nav: string; go: (to: string) => void }) {
  const runningJobs = snap.jobs.filter((j) => j.state === 'running').length;
  const items: [string, string, IconName, string, number | undefined][] = [
    ['projects', '项目', 'layers', '/', snap.projects.length || undefined],
    ['network', '网络', 'globe', '/network', undefined],
    ['ports', '端口', 'plug', '/ports', snap.ports.forwards.filter((f) => f.state === 'open').length || undefined],
    ['files', '文件', 'folder', '/files', undefined],
    ['jobs', '任务', 'list', '/jobs', runningJobs || undefined],
    ['settings', '设置', 'settings', '/settings', undefined],
  ];
  return (
    <nav className="sidebar">
      <div className="sidebar-top" />
      <a className="brand" onClick={() => go('/')}>
        <Logo size={42} />
        <b>CCVM</b>
      </a>
      {items.map(([id, label, icon, to, count]) => (
        <button key={id} className={`nav-item ${nav === id ? 'active' : ''}`} onClick={() => go(to)}>
          <Icon name={icon} size={18} />
          {label}
          {count !== undefined && <span className="count">{count}</span>}
        </button>
      ))}
      <div className="sidebar-foot">
        <NetCard snap={snap} onClick={() => go('/network')} />
        <VmLine snap={snap} />
      </div>
    </nav>
  );
}

/** 侧栏底部的网络状态：代理通着就是绿的 */
function NetCard({ snap, onClick }: { snap: Snapshot; onClick: () => void }) {
  const ip = snap.level === 'ok' ? snap.egress.vm ?? snap.egress.host : undefined;
  const via = snap.settings.egressMode === 'builtin' ? snap.core?.node?.name ?? '自带核心' : 'Clash Verge';
  return (
    <div className={`net-card ${snap.level === 'error' ? 'error' : ''}`} onClick={onClick} title={snap.detail}>
      <div className="net-head">
        <Dot level={snap.level} />
        <span className="ellipsis">{snap.headline}</span>
      </div>
      <div className="net-meta">
        {ip && <span className="net-ip">{ip}</span>}
        <span>{snap.checking ? '正在检查…' : via}</span>
      </div>
    </div>
  );
}

function VmLine({ snap }: { snap: Snapshot }) {
  const { run, go } = useApp();
  const vm = snap.vm;
  const running = vm.status === 'Running';
  const busy = snap.jobs.some((j) => j.state === 'running' && ['vm-start', 'vm-stop', 'setup', 'shares', 'vm-upgrade'].includes(j.kind));
  return (
    <div className="vm-line">
      <Dot level={running ? 'ok' : busy ? 'busy' : 'idle'} />
      <span className="grow ellipsis">
        {vm.name} · {vm.status === 'Missing' ? '未部署' : running ? '运行中' : busy ? '处理中' : '已停止'}
      </span>
      {vm.status === 'Missing' ? (
        <button className="icon-btn" title="开始部署" onClick={() => go('/welcome')}>
          <Icon name="play" size={14} />
        </button>
      ) : (
        <button className="icon-btn" title={running ? '停止 VM' : '启动 VM'} disabled={busy} onClick={() => run(() => act(running ? 'vmStop' : 'vmStart'))}>
          <Icon name={running ? 'power' : 'play'} size={14} />
        </button>
      )}
    </div>
  );
}

function TopActions({ snap }: { snap: Snapshot }) {
  const { run } = useApp();
  const light = snap.settings.theme === 'light' || (snap.settings.theme === 'system' && isLightTheme());
  return (
    <>
      <button className="icon-btn" title="立即检查" disabled={snap.checking || snap.vm.status !== 'Running'} onClick={() => run(() => act('quickCheck'))}>
        <Icon name="refresh" size={16} />
      </button>
      <button className="icon-btn" title={light ? '深色' : '浅色'} onClick={() => run(() => act('updateSettings', { theme: light ? 'dark' : 'light' }))}>
        <Icon name={light ? 'moon' : 'sun'} size={16} />
      </button>
    </>
  );
}
