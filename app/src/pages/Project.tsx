// 项目页：左边是这个项目在 VM 里的 tmux 会话，右边是内嵌终端（按会话分标签）。
// 关标签只是断开，会话和里面的 Claude 继续在 VM 里跑；结束会话要单独确认。
import { useEffect, useReducer, useRef, useState } from 'react';
import { relativeTime } from '../../core/status';
import { act, errorText, useApp } from '../api';
import { Dot } from '../components/common';
import { Icon } from '../components/Icon';
import { detachTerm, getTerm, openTerm, renameTerm, subscribe, termsOf, type TermEntry } from '../terms';

export function ProjectPage({ name }: { name: string }) {
  const { snap, now, go, run } = useApp();
  const [active, setActive] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const areaRef = useRef<HTMLDivElement>(null);
  useEffect(() => subscribe(rerender), []);

  const p = snap.projects.find((x) => x.name === name);
  // 没有 tmux 时新会话开不起来（接回已有会话不受影响）
  const noTmux = snap.vmPackages.tmuxInstalled === false;
  const running = snap.vm.status === 'Running';
  // 最近有动静的在最上面
  const vmSessions = snap.sessions.filter((s) => s.project === name).sort((a, b) => (b.activity || b.created) - (a.activity || a.created));
  const local = termsOf(name);
  const tabs = [...new Set([...local.map((t) => t.session), ...vmSessions.map((s) => s.name)])];
  const current = active && tabs.includes(active) ? active : local[0]?.session ?? null;

  const open = async (mode: 'new' | 'attach', session?: string) => {
    if (!areaRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const entry = await openTerm(name, mode, session, areaRef.current);
      setActive(entry.session);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const [renaming, setRenaming] = useState<{ from: string; to: string } | null>(null);
  // 回车之后输入框失焦还会再触发一次：同一次编辑只提交一次
  const committing = useRef<string | null>(null);
  const commitRename = async () => {
    if (!renaming || committing.current === renaming.from) return;
    committing.current = renaming.from;
    const { from, to } = renaming;
    const name2 = to.trim();
    setRenaming(null);
    if (!name2 || name2 === from) {
      committing.current = null;
      return;
    }
    const ok = await run(() => act('renameSession', from, name2));
    if (ok) {
      renameTerm(from, name2);
      if (active === from) setActive(name2);
    }
    committing.current = null;
  };
  const select = (session: string) => {
    const t = getTerm(session);
    if (t && t.state !== 'closed') setActive(session);
    else void open('attach', session);
  };

  return (
    <div className="col grow" style={{ minHeight: 0, gap: 0 }}>
      <div className="project-head">
        <button className="icon-btn" title="返回" onClick={() => go('/')}>
          <Icon name="back" size={16} />
        </button>
        <h1 className="ellipsis">{name}</h1>
        {p && <span className="chip mono">{p.branch}</span>}
        {p && p.dirty > 0 && <span className="chip warn">{p.dirty} 个改动</span>}
        <span className="spacer" />
        <button className="btn" disabled={!running} onClick={() => go(`/files/${encodeURIComponent(`/home/cc/work/${name}`)}`)}>
          <Icon name="folder" size={15} />
          文件
        </button>
        <button className="btn" disabled={noTmux || !running} onClick={() => run(() => act('openTerminal', name))}>
          <Icon name="external" size={15} />
          外部终端
        </button>
      </div>
      <div className="project-page">
        <aside className="sessions">
          <div className="side-title">
            会话 <span className="faint">{vmSessions.length || ''}</span>
          </div>
          {vmSessions.length === 0 && <div className="tiny muted">没有会话</div>}
          {vmSessions.map((s) => {
            const t = getTerm(s.name);
            const here = !!t && t.state === 'open';
            return (
              <div key={s.name} className={`session ${current === s.name ? 'active' : ''}`} onClick={() => select(s.name)}>
                <div className="row small">
                  <Dot level={s.command === 'claude' ? 'busy' : 'idle'} />
                  {renaming?.from === s.name ? (
                    <input
                      className="input mono grow"
                      autoFocus
                      value={renaming.to}
                      maxLength={64}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setRenaming({ from: s.name, to: e.target.value.replace(/[^A-Za-z0-9_-]/g, '') })}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void commitRename();
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      onBlur={() => void commitRename()}
                      style={{ height: 22, padding: '0 6px' }}
                    />
                  ) : (
                    <span
                      className="mono grow ellipsis"
                      title="双击改名"
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        committing.current = null;
                        setRenaming({ from: s.name, to: s.name });
                      }}
                    >
                      {s.name}
                    </span>
                  )}
                </div>
                <div className="tiny muted">
                  {s.command === 'claude' ? 'Claude' : s.command || 'shell'} · {relativeTime((s.activity || s.created) * 1000, now)}
                  {here ? ' · 在这里' : s.attached ? ' · 别处接入' : ''}
                </div>
              </div>
            );
          })}
          <button className="btn sm" disabled={noTmux || !running || busy} onClick={() => open('new')}>
            <Icon name="plus" size={14} />
            新会话
          </button>
          {current && vmSessions.some((s) => s.name === current) && (
            <button
              className="btn sm danger"
              onClick={async () => {
                const ok = await run(() => act('killSession', current));
                if (ok) {
                  await detachTerm(current);
                  setActive(null);
                }
              }}
            >
              结束会话
            </button>
          )}
        </aside>

        <section className="col grow" style={{ minHeight: 0, gap: 10 }}>
          {snap.vmPackages.tmuxInstalled === false && (
            <div className="banner">
              <span className="title grow">VM 里没有 tmux</span>
              <button className="btn sm" onClick={() => go('/')}>
                更新 VM
              </button>
            </div>
          )}
          <div className="term-wrap">
            <div className="term-tabs">
              {tabs.map((t) => {
                const entry = getTerm(t);
                return (
                  <button key={t} className={`term-tab ${current === t ? 'active' : ''}`} onClick={() => select(t)}>
                    <Dot level={entry?.state === 'open' ? 'ok' : entry?.state === 'connecting' ? 'busy' : 'idle'} />
                    <span className="mono">{t}</span>
                    {entry && entry.state !== 'closed' && (
                      <span
                        className="x"
                        title="断开（会话继续运行）"
                        onClick={(e) => {
                          e.stopPropagation();
                          void detachTerm(t);
                        }}
                      >
                        ×
                      </span>
                    )}
                  </button>
                );
              })}
              <button className="term-tab" disabled={noTmux || !running || busy} onClick={() => open('new')} title="新会话">
                <Icon name="plus" size={14} />
              </button>
            </div>
            <div className="term-area" ref={areaRef}>
              {current && getTerm(current) ? (
                <TermView entry={getTerm(current)!} area={areaRef} />
              ) : (
                <div className="term-empty">
                  <div className="col" style={{ alignItems: 'center' }}>
                    {busy && <span className="muted">正在连接…</span>}
                    {error && <span className="small err-text">{error}</span>}
                    {!busy && (
                      <button className="btn lg primary" disabled={noTmux || !running} onClick={() => open('new')}>
                        <Icon name="terminal" size={16} />
                        新会话
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          {error && current && <p className="small err-text">{error}</p>}
        </section>

      </div>
    </div>
  );
}

/** 把已有的 xterm 挂到终端区，跟着容器大小调整 */
function TermView({ entry, area }: { entry: TermEntry; area: React.RefObject<HTMLDivElement | null> }) {
  useEffect(() => {
    const host = area.current;
    if (!host) return;
    if (entry.el.parentElement !== host) host.appendChild(entry.el);
    entry.el.style.display = '';
    const fit = () => {
      try {
        entry.fit.fit();
      } catch {
        /* 尺寸为 0 时忽略 */
      }
    };
    fit();
    entry.term.focus();
    const ro = new ResizeObserver(fit);
    ro.observe(host);
    return () => {
      ro.disconnect();
      entry.el.style.display = 'none'; // 切到别的标签：藏起来，不断开
    };
  }, [entry, area]);
  return null;
}
