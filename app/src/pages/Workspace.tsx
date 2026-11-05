// 首页：项目是主角。保护状态在顶栏；出事时才出现提示卡。
import { useEffect, useState } from 'react';
import { gitUrlProblem } from '../../core/parsers';
import { duration, relativeTime } from '../../core/status';
import type { Issue, JobSummary, Project, Snapshot } from '../../core/types';
import { act, useApp } from '../api';
import { Dot, gib, Hint, RebaselineFlow } from '../components/common';

type Filter = 'all' | 'running' | 'dirty' | 'idle';

export function WorkspacePage() {
  const { snap, now, go, run } = useApp();
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const running = snap.vm.status === 'Running';

  useEffect(() => {
    if (running) void run(() => act('refreshProjects'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  const projects = snap.projects;
  const counts = {
    all: projects.length,
    running: projects.filter((p) => p.claudeSessions > 0).length,
    dirty: projects.filter((p) => p.dirty > 0).length,
    idle: projects.filter((p) => p.claudeSessions === 0).length,
  };
  const q = query.trim().toLowerCase();
  const shown = projects
    .filter((p) => filter === 'all' || (filter === 'running' ? p.claudeSessions > 0 : filter === 'dirty' ? p.dirty > 0 : p.claudeSessions === 0))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.branch.toLowerCase().includes(q));
  const clones = snap.jobs.filter((j) => j.kind === 'clone' && (j.state === 'running' || (j.state === 'failed' && now - (j.finishedAt ?? 0) < 10 * 60_000)));

  return (
    <>
      <nav className="sidebar">
        {(
          [
            ['all', '全部项目'],
            ['running', 'Claude 运行中'],
            ['dirty', '有未提交改动'],
            ['idle', '空闲'],
          ] as [Filter, string][]
        ).map(([id, label]) => (
          <button key={id} className={`nav-item ${filter === id ? 'active' : ''}`} onClick={() => setFilter(id)}>
            {label}
            <span className="count">{counts[id]}</span>
          </button>
        ))}
        <VmBox snap={snap} />
      </nav>
      <main className="main">
        <div className="page-head">
          <h1 className="grow">项目</h1>
          <input className="input" style={{ width: 200 }} placeholder="搜索" value={query} onChange={(e) => setQuery(e.target.value)} />
          <CloneBar disabled={!running} />
        </div>

        {snap.issues.map((issue, i) => (
          <div className="alert" key={issue.key}>
            <span className="chip err">
              <Dot level="error" />
              {issue.title}
            </span>
            <span className="msg">{issue.detail}</span>
            {i === 0 && <IssueActions issue={issue} />}
          </div>
        ))}

        {snap.vm.status === 'Missing' && (
          <div className="notice">
            <span className="grow">还没有部署 VM</span>
            <button className="btn sm primary" onClick={() => go('/welcome')}>
              开始
            </button>
          </div>
        )}

        {snap.vmPackages.needsUpgrade && running && (
          <div className="notice">
            <span className="grow row" style={{ gap: 6 }}>
              VM 需要更新
              <Hint text="补装 git、tmux，并修复系统更新重启网络服务后断网的问题。不改防火墙和 sing-box 配置，完成后自动验收。" />
            </span>
            <button
              className="btn sm"
              disabled={snap.jobs.some((j) => j.state === 'running' && j.kind === 'vm-upgrade')}
              onClick={() => run(async () => {
                const id = await act('vmUpgrade');
                if (id) go(`/jobs/${id}`);
              })}
            >
              更新 VM
            </button>
          </div>
        )}


        {snap.projectsError && <p className="small err-text" style={{ marginBottom: 10 }}>读取项目失败：{snap.projectsError}</p>}

        <div className="grid">
          {shown.map((p) => (
            <ProjectCard key={p.name} p={p} snap={snap} />
          ))}
          {clones.map((j) => (
            <CloneCard key={j.id} job={j} />
          ))}
        </div>
        {!shown.length && !clones.length && (
          <div className="empty">
            {!running ? 'VM 没有运行' : projects.length ? '没有匹配的项目' : '还没有项目'}
          </div>
        )}
      </main>
    </>
  );
}

function IssueActions({ issue }: { issue: Issue }) {
  const { snap, go, run } = useApp();
  const chain = (
    <button className="btn sm" onClick={() => go('/security')}>
      查看
    </button>
  );
  switch (issue.kind) {
    case 'egress_changed':
      return (
        <div className="row">
          {chain}
          <RebaselineFlow compact />
        </div>
      );
    case 'node_changed':
      return (
        <div className="row">
          <button className="btn sm" onClick={() => go('/settings/egress')}>
            换一个节点
          </button>
          {issue.data?.kind === 'changed' && issue.data.node && (
            <button className="btn sm primary" onClick={() => run(() => act('selectNode', issue.data!.node))}>
              使用新的节点信息
            </button>
          )}
        </div>
      );
    case 'leak_failed': {
      const running = snap.vm.status === 'Running';
      const busy = snap.jobs.some((j) => j.state === 'running' && ['leaktest', 'setup', 'vm-upgrade', 'shares'].includes(j.kind));
      return (
        <div className="row">
          <button className="btn sm" onClick={() => go('/jobs')}>
            上次的结果
          </button>
          <button
            className="btn sm primary"
            disabled={!running || busy}
            title="会短暂停止 VM 里的 TUN；通过后解除对新会话的限制"
            onClick={() => run(async () => {
              const id = await act('leaktest');
              go(`/jobs/${id}`);
            })}
          >
            重新做断流测试
          </button>
        </div>
      );
    }
    case 'core_missing':
      return (
        <div className="row">
          <button className="btn sm" onClick={() => run(() => act('copyText', 'brew install mihomo'), '已复制：到终端粘贴运行')}>
            复制安装命令
          </button>
        </div>
      );
    case 'core_down':
    case 'core_conflict':
      return (
        <div className="row">
          <button className="btn sm" onClick={() => go('/settings/egress')}>
            出口设置
          </button>
          <button className="btn sm primary" onClick={() => run(() => act('restartCore'), '核心已重启，正在检查')}>
            重启核心
          </button>
        </div>
      );
    default:
      return (
        <div className="row">
          {chain}
          <button className="btn sm" onClick={() => run(() => act('openAdminShell'))}>
            管理员 shell
          </button>
        </div>
      );
  }
}

function VmBox({ snap }: { snap: Snapshot }) {
  const { run, go } = useApp();
  const vm = snap.vm;
  const busy = snap.jobs.some((j) => j.state === 'running' && ['vm-start', 'vm-stop', 'setup', 'leaktest'].includes(j.kind));
  return (
    <div className="vm-box">
      <div className="tiny faint">这台 VM</div>
      <div className="row small">
        <Dot level={vm.status === 'Running' ? 'ok' : 'idle'} />
        <span className="ellipsis">
          {vm.name} · Ubuntu 24.04
        </span>
      </div>
      {vm.status !== 'Missing' && (
        <div className="tiny muted">
          {vm.cpus ?? '?'} vCPU · {gib(vm.memoryBytes)} · {vm.status === 'Running' ? '运行中' : vm.status}
        </div>
      )}
      {vm.error && <div className="tiny err-text">{vm.error}</div>}
      {vm.status === 'Running' ? (
        <button className="btn sm" disabled={busy} onClick={() => run(() => act('vmStop'))}>
          停止 VM
        </button>
      ) : vm.status === 'Missing' ? (
        <button className="btn sm" onClick={() => go('/welcome')}>
          开始部署
        </button>
      ) : (
        <button className="btn sm" disabled={busy} onClick={() => run(() => act('vmStart'))}>
          启动 VM
        </button>
      )}
    </div>
  );
}

function CloneBar({ disabled }: { disabled: boolean }) {
  const { run } = useApp();
  const [url, setUrl] = useState('');
  const problem = url.trim() ? gitUrlProblem(url) : null;
  const submit = async () => {
    if (gitUrlProblem(url)) return;
    const id = await run(() => act('clone', url.trim()));
    if (id) setUrl('');
  };
  return (
    <div className="row" style={{ gap: 6 }}>
      <input
        className={`input mono ${problem ? 'invalid' : ''}`}
        style={{ width: 280 }}
        placeholder="克隆 Git 仓库"
        title={problem ?? '在 VM 里以 cc 身份克隆到 ~/work。私有仓库要先在 VM 的 cc 用户里配置 gh auth 或 SSH 密钥。'}
        value={url}
        disabled={disabled}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && void submit()}
      />
      <button className="btn sm primary" disabled={disabled || !url.trim() || !!problem} onClick={submit}>
        克隆
      </button>
    </div>
  );
}

function ProjectCard({ p, snap }: { p: Project; snap: Snapshot }) {
  const { go, run, now } = useApp();
  const open = () => go(`/project/${encodeURIComponent(p.name)}`);
  return (
    <div className="card project" onDoubleClick={open}>
      <div className="row">
        <div className="avatar">{p.name[0]}</div>
        <div className="grow ellipsis" style={{ fontWeight: 600 }}>
          {p.name}
        </div>
      </div>
      <div className="row wrap small">
        <span className="chip mono">{p.branch}</span>
        <span className="muted">{p.dirty ? `${p.dirty} 个未提交改动` : '干净'}</span>
        {p.ahead > 0 && <span className="muted">领先 {p.ahead}</span>}
        {p.behind > 0 && <span className="muted">落后 {p.behind}</span>}
      </div>
      <div className="small muted ellipsis" title={p.subject}>
        {p.subject || '—'} · {relativeTime(p.updated * 1000, now)}
      </div>
      <div className="row">
        {p.claudeSessions > 0 ? (
          <span className="status busy">
            <Dot level="busy" />
            Claude · {duration(p.claudeSince, now)}
          </span>
        ) : (
          <span className="status idle">
            <Dot level="idle" />
            空闲
          </span>
        )}
        <span className="spacer" />
        <button
          className="btn sm"
          disabled={snap.newSessionsBlocked || snap.vm.status !== 'Running'}
          title={snap.newSessionsBlocked ? `${snap.headline}：核实之前不打开新会话` : '在终端里以 cc 打开这个项目'}
          onClick={() => run(() => act('openTerminal', p.name))}
        >
          终端
        </button>
        <button className="btn sm primary" onClick={open}>
          打开
        </button>
      </div>
    </div>
  );
}

function CloneCard({ job }: { job: JobSummary }) {
  const { run, go } = useApp();
  const url = job.args[1] ?? '';
  const name = url.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? '';
  const failed = job.state === 'failed';
  return (
    <div className="card project">
      <div className="row">
        <div className="avatar">{name[0] ?? '?'}</div>
        <div className="grow">
          <div style={{ fontWeight: 600 }}>{name}</div>
          <div className="tiny faint mono ellipsis">{url}</div>
        </div>
      </div>
      {failed ? (
        <p className="small err-text">{job.reason}</p>
      ) : (
        <>
          <div className="row tiny muted">
            <span className="grow">克隆中 · {job.percent !== undefined ? `正在接收对象 ${job.percent}%` : '连接中'}</span>
          </div>
          <div className={`progress ${job.percent === undefined ? 'indeterminate' : ''}`}>
            <div style={{ width: `${job.percent ?? 30}%` }} />
          </div>
        </>
      )}
      <div className="row">
        <span className={`status ${failed ? 'error' : 'busy'}`}>
          <Dot level={failed ? 'error' : 'busy'} />
          {failed ? '克隆失败' : '进行中'}
        </span>
        <span className="spacer" />
        <button className="btn sm ghost" onClick={() => go(`/jobs/${job.id}`)}>
          日志
        </button>
        {!failed && (
          <button className="btn sm" onClick={() => run(() => act('cancelJob', job.id))}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}
