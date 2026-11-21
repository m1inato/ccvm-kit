// 首页：项目。出问题时顶部一条提示。
import { useEffect, useState } from 'react';
import { gitUrlProblem } from '../../core/parsers';
import { duration, relativeTime } from '../../core/status';
import type { Issue, JobSummary, Project } from '../../core/types';
import { act, useApp } from '../api';
import { Dot, PageTitle, Segmented } from '../components/common';
import { Icon } from '../components/Icon';

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
  const active = projects.filter((p) => p.claudeSessions > 0).length;
  const dirty = projects.filter((p) => p.dirty > 0).length;
  const q = query.trim().toLowerCase();
  const shown = projects
    .filter((p) => filter === 'all' || (filter === 'running' ? p.claudeSessions > 0 : filter === 'dirty' ? p.dirty > 0 : p.claudeSessions === 0))
    .filter((p) => !q || p.name.toLowerCase().includes(q) || p.branch.toLowerCase().includes(q));
  const clones = snap.jobs.filter((j) => j.kind === 'clone' && (j.state === 'running' || (j.state === 'failed' && now - (j.finishedAt ?? 0) < 10 * 60_000)));
  const upgrading = snap.jobs.some((j) => j.state === 'running' && j.kind === 'vm-upgrade');

  return (
    <div className="main-scroll">
      <PageTitle
        title="项目"
        stats={
          <>
            <span>共<b>{projects.length}</b>个</span>
            <span>Claude 运行中<b>{active}</b>个</span>
            <span>有改动<b>{dirty}</b>个</span>
          </>
        }
      />

      {snap.issues.slice(0, 1).map((issue) => (
        <div className="banner error" key={issue.key}>
          <Dot level="error" />
          <span className="title">{issue.title}</span>
          <span className="msg">{issue.detail}</span>
          <IssueActions issue={issue} />
        </div>
      ))}

      {snap.vm.status === 'Missing' && (
        <div className="banner">
          <span className="title grow">还没有部署 VM</span>
          <button className="btn primary" onClick={() => go('/welcome')}>
            开始
          </button>
        </div>
      )}

      {snap.vmPackages.needsUpgrade && running && (
        <div className="banner">
          <span className="title grow">VM 需要更新</span>
          <button
            className="btn"
            disabled={upgrading}
            onClick={() => run(async () => {
              const id = await act('vmUpgrade');
              if (id) go(`/jobs/${id}`);
            })}
          >
            更新 VM
          </button>
        </div>
      )}

      <CloneCard disabled={!running} />

      <div className="toolbar">
        <Segmented
          value={filter}
          onChange={setFilter}
          options={[
            ['all', '全部'],
            ['running', '运行中'],
            ['dirty', '有改动'],
            ['idle', '空闲'],
          ]}
        />
        <span className="spacer" />
        <input className="input" placeholder="搜索项目、分支…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>

      {snap.projectsError && <p className="small err-text" style={{ marginBottom: 12 }}>读取项目失败：{snap.projectsError}</p>}

      <div className="grid">
        {clones.map((j) => (
          <CloningCard key={j.id} job={j} />
        ))}
        {shown.map((p) => (
          <ProjectCard key={p.name} p={p} />
        ))}
      </div>
      {!shown.length && !clones.length && <div className="empty">{!running ? 'VM 没有运行' : projects.length ? '没有匹配的项目' : '还没有项目'}</div>}
    </div>
  );
}

function IssueActions({ issue }: { issue: Issue }) {
  const { go, run } = useApp();
  switch (issue.kind) {
    case 'core_missing':
      return (
        <button className="btn sm" onClick={() => run(() => act('copyText', 'brew install mihomo'), '已复制')}>
          复制安装命令
        </button>
      );
    case 'core_down':
    case 'core_conflict':
      return (
        <button className="btn sm" onClick={() => run(() => act('restartCore'), '核心已重启')}>
          重启核心
        </button>
      );
    default:
      return (
        <button className="btn sm" onClick={() => go('/network')}>
          查看
        </button>
      );
  }
}

function CloneCard({ disabled }: { disabled: boolean }) {
  const { run } = useApp();
  const [url, setUrl] = useState('');
  const problem = url.trim() ? gitUrlProblem(url) : null;
  const submit = async () => {
    if (gitUrlProblem(url)) return;
    const id = await run(() => act('clone', url.trim()));
    if (id) setUrl('');
  };
  return (
    <div className="card hero">
      <div className="hero-row">
        <div className="search-field">
          <Icon name="git" size={18} />
          <input
            className={`input ${problem ? 'invalid' : ''}`}
            placeholder="粘贴 Git 仓库地址，克隆到 ~/work"
            title={problem ?? undefined}
            value={url}
            disabled={disabled}
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </div>
        <button className="btn primary" disabled={disabled || !url.trim() || !!problem} onClick={submit}>
          克隆
        </button>
      </div>
      {problem && <span className="small err-text">{problem}</span>}
    </div>
  );
}

function ProjectCard({ p }: { p: Project }) {
  const { snap, go, run, now } = useApp();
  const open = () => go(`/project/${encodeURIComponent(p.name)}`);
  const running = snap.vm.status === 'Running';
  return (
    <div className="card project" onDoubleClick={open}>
      <div className="avatar">{p.name[0]}</div>
      <div className="project-body">
        <div className="project-name ellipsis">{p.name}</div>
        <div className="project-sub ellipsis" title={p.subject}>
          {p.subject || '没有提交'} · {relativeTime(p.updated * 1000, now)}
        </div>
        <div className="row wrap" style={{ marginTop: 4 }}>
          <span className="chip mono">{p.branch}</span>
          {p.dirty > 0 && <span className="chip warn">{p.dirty} 个改动</span>}
          {p.ahead > 0 && <span className="chip">↑ {p.ahead}</span>}
          {p.behind > 0 && <span className="chip">↓ {p.behind}</span>}
        </div>
        <div className="project-foot">
          {p.claudeSessions > 0 ? (
            <span className="state busy">
              <Dot level="busy" />
              Claude · {duration(p.claudeSince, now)}
            </span>
          ) : (
            <span className="state">
              <Dot level="idle" />
              空闲
            </span>
          )}
          <span className="spacer" />
          <button className="icon-btn plain" title="在外部终端打开" disabled={!running} onClick={() => run(() => act('openTerminal', p.name))}>
            <Icon name="external" size={15} />
          </button>
          <button className="btn sm primary" onClick={open}>
            打开
          </button>
        </div>
      </div>
    </div>
  );
}

function CloningCard({ job }: { job: JobSummary }) {
  const { run, go } = useApp();
  const url = job.args[1] ?? '';
  const name = url.replace(/\/+$/, '').split(/[/:]/).pop()?.replace(/\.git$/, '') ?? '';
  const failed = job.state === 'failed';
  return (
    <div className="card project">
      <div className="avatar">{name[0] ?? '?'}</div>
      <div className="project-body">
        <div className="project-name ellipsis">{name}</div>
        <div className="project-sub mono ellipsis">{url}</div>
        {failed ? (
          <p className="small err-text">{job.reason}</p>
        ) : (
          <div className={`progress ${job.percent === undefined ? 'indeterminate' : ''}`} style={{ marginTop: 8 }}>
            <div style={{ width: `${job.percent ?? 30}%` }} />
          </div>
        )}
        <div className="project-foot">
          <span className={`state ${failed ? 'error' : 'busy'}`}>
            <Dot level={failed ? 'error' : 'busy'} />
            {failed ? '克隆失败' : job.percent !== undefined ? `克隆中 ${job.percent}%` : '克隆中'}
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
    </div>
  );
}
