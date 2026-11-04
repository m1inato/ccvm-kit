// 后台任务：每个任务是一次脚本运行；App 退出后继续跑，重新打开时接回。完整日志可以随时看。
import { useEffect, useState } from 'react';
import { checkLabel } from '../../core/report';
import { relativeTime } from '../../core/status';
import type { JobSummary } from '../../core/types';
import { act, useApp } from '../api';
import { Dot } from '../components/common';

const STATE: Record<JobSummary['state'], [string, 'busy' | 'ok' | 'error' | 'idle']> = {
  running: ['进行中', 'busy'],
  done: ['完成', 'ok'],
  failed: ['失败', 'error'],
  cancelled: ['已取消', 'idle'],
};

export function JobsPage({ focus }: { focus?: string }) {
  const { snap } = useApp();
  return (
    <main className="main">
      <div className="page-head">
        <div className="grow">
          <h1>后台任务</h1>
          <p className="small muted">创建 VM、断流测试、克隆等都在后台运行；App 退出后继续，重新打开时接回。安装脚本可以重跑，所以「重试」就是再跑一次。</p>
        </div>
      </div>
      <div className="col">
        {snap.jobs.length === 0 && <div className="empty">还没有后台任务。</div>}
        {snap.jobs.map((j) => (
          <JobCard key={j.id} job={j} open={j.id === focus} />
        ))}
      </div>
    </main>
  );
}

function JobCard({ job, open: initiallyOpen }: { job: JobSummary; open: boolean }) {
  const { now, run } = useApp();
  const [open, setOpen] = useState(initiallyOpen);
  const [log, setLog] = useState('');
  const [label, level] = STATE[job.state];
  useEffect(() => {
    if (!open) return;
    const load = () => void act('jobLog', job.id).then(setLog).catch(() => undefined);
    load();
    if (job.state !== 'running') return;
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [open, job.id, job.state]);
  const failed = job.result?.checks.filter((c) => !c.ok) ?? [];
  return (
    <div className="card job">
      <div className="row">
        <Dot level={level} />
        <b>{job.title}</b>
        <span className="muted small">{label}</span>
        <span className="tiny faint">{relativeTime(job.startedAt, now)}开始</span>
        <span className="spacer" />
        {job.state === 'running' && (
          <button className="btn sm" onClick={() => run(() => act('cancelJob', job.id))}>
            取消
          </button>
        )}
        <button className="btn sm ghost" onClick={() => setOpen(!open)}>
          {open ? '收起日志' : '日志'}
        </button>
      </div>
      {job.step && <p className="small muted">{job.step}</p>}
      {job.reason && job.state !== 'done' && <p className={`small ${job.state === 'failed' ? 'err-text' : 'muted'}`}>{job.reason}</p>}
      {failed.length > 0 && (
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {failed.map((c, i) => (
            <li key={`${c.id}-${i}`}>
              <span className="err-text">{checkLabel(c.id)}</span> <span className="muted">— {c.msg}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="tiny faint mono">
        {job.args.join(' ')}
      </p>
      {open && <pre className="log">{log || '（还没有输出）'}</pre>}
    </div>
  );
}
