// 工作区首页：项目是主角。保护状态只在顶栏、标题下一行和右下角圆环；出事时才出现提示卡。
import { useEffect, useState } from 'react';
import { gitUrlProblem } from '../../core/parsers';
import { duration, relativeTime } from '../../core/status';
import type { Issue, JobSummary, Project, Snapshot } from '../../core/types';
import { act, useApp } from '../api';
import { Dot, gib, RebaselineFlow, Ring } from '../components/common';

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
          <div className="grow">
            <h1>工作区</h1>
            <Subtitle snap={snap} now={now} count={projects.length} />
          </div>
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
          <div className="callout warn row" style={{ marginBottom: 16 }}>
            <span className="grow">还没有部署 VM。按欢迎页的 3 步完成：接上出口、准备 VM、登录 Claude。</span>
            <button className="btn sm primary" onClick={() => go('/welcome')}>
              打开欢迎页
            </button>
          </div>
        )}

        <CloneBar disabled={!running} />

        <div className="filters">
          {(
            [
              ['all', '全部'],
              ['running', '运行中'],
              ['dirty', '有改动'],
              ['idle', '空闲'],
            ] as [Filter, string][]
          ).map(([id, label]) => (
            <button key={id} className={`tab ${filter === id ? 'active' : ''}`} onClick={() => setFilter(id)}>
              {label}
            </button>
          ))}
          <span className="spacer" />
          <input className="input" style={{ width: 220, height: 28 }} placeholder="搜索项目、分支…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>

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
            {!running ? 'VM 没有运行。启动后这里会列出 VM 里 ~/work 下的项目。' : projects.length ? '没有符合条件的项目。' : '还没有项目。粘贴一个 Git 地址开始。'}
          </div>
        )}
      </main>
      <Ring snap={snap} />
    </>
  );
}

function IssueActions({ issue }: { issue: Issue }) {
  const { snap, go, run } = useApp();
  const firstProject = snap.projects[0]?.name;
  const chain = (
    <button className="btn sm" onClick={() => go(`/project/${encodeURIComponent(firstProject ?? '')}`)} disabled={!firstProject}>
      查看链路
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

function Subtitle({ snap, now, count }: { snap: Snapshot; now: number; count: number }) {
  const parts = [`共 ${count} 个项目`];
  if (snap.level === 'error' && snap.issues[0]?.kind === 'egress_changed') {
    parts.push(`出口 ${snap.egress.vm ?? snap.egress.host} · 和基线不一致`);
  } else if (snap.level === 'ok' || snap.level === 'busy') {
    if (snap.egress.vm ?? snap.egress.baseline) parts.push(`出口 ${snap.egress.vm ?? snap.egress.baseline}（和基线一致）`);
  } else {
    parts.push(snap.headline);
  }
  parts.push(snap.checking ? '正在检查' : `${relativeTime(snap.lastCheckAt, now)}检查过`);
  return <p className={`small ${snap.level === 'error' ? 'err-text' : 'muted'}`}>{parts.join(' · ')}</p>;
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
    <div className="card">
      <div className="clone">
        <input
          className={`input ${problem ? 'invalid' : ''}`}
          placeholder="粘贴 Git 仓库地址，例如 git@github.com:you/my-api.git"
          value={url}
          disabled={disabled}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <button className="btn primary" disabled={disabled || !url.trim() || !!problem} onClick={submit}>
          克隆
        </button>
      </div>
      <p className="tiny faint" style={{ padding: '0 12px 10px' }}>
        {problem ?? '项目放在 VM 的 ~/work，克隆在 VM 里以 cc 身份完成，代码不经过 Mac。私有仓库请先在 VM 的 cc 用户里配置 gh auth 或 SSH 密钥。'}
      </p>
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
        <div className="grow">
          <div className="ellipsis" style={{ fontWeight: 600 }}>
            {p.name}
          </div>
          <div className="tiny faint mono">~/work/{p.name}</div>
        </div>
      </div>
      <div className="row wrap small">
        <span className="chip mono">{p.branch}</span>
        <span className="muted">{p.dirty ? `${p.dirty} 个未提交改动` : '干净'}</span>
        {p.ahead > 0 && <span className="muted">领先 {p.ahead}</span>}
        {p.behind > 0 && <span className="muted">落后 {p.behind}</span>}
      </div>
      <div className="tiny faint ellipsis" title={p.subject}>
        上次提交 {relativeTime(p.updated * 1000, now)}
        {p.subject ? ` · ${p.subject}` : ''}
      </div>
      <div className="row">
        {p.claudeSessions > 0 ? (
          <span className="status busy">
            <Dot level="busy" />
            Claude 运行中 · {duration(p.claudeSince, now)}
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
