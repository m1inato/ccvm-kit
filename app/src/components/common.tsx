import { useState, type ReactNode } from 'react';
import { relativeTime } from '../../core/status';
import type { Level, RunResult, Snapshot } from '../../core/types';
import { act, useApp } from '../api';

export function Dot({ level }: { level: Level | 'err' }) {
  return <span className={`dot ${level}`} />;
}

export function StatusText({ level, children }: { level: Level; children: ReactNode }) {
  return (
    <span className={`status ${level}`}>
      <Dot level={level} />
      {children}
    </span>
  );
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

/** 顶栏、首页共用的状态胶囊：平时安静，出错时变红 */
export function StatusPill({ snap, onClick }: { snap: Snapshot; onClick?: () => void }) {
  // 出错时只有「出口变了」才显示新的 IP；其他问题（核心停了、节点变了）VM 是断网的，不显示旧 IP
  const ip = snap.level === 'error'
    ? snap.issues[0]?.kind === 'egress_changed' ? snap.egress.vm ?? snap.egress.host : undefined
    : snap.egress.vm ?? snap.egress.baseline;
  return (
    <button className={`pill ${snap.level}`} onClick={onClick} title={snap.detail}>
      <Dot level={snap.level} />
      <span>{snap.checking ? '正在检查…' : snap.headline}</span>
      {ip && <span className="ip">{ip}</span>}
    </button>
  );
}

/** 共享文件夹开着时常驻在状态旁边：状态仍然是绿色，但 VM 能读写这些 Mac 文件夹 */
export function SharesBadge({ snap, onClick }: { snap: Snapshot; onClick?: () => void }) {
  const n = snap.shares.applied.length;
  if (!n) return null;
  return (
    <button className="share-badge" onClick={onClick} title={snap.shares.applied.map((s) => `${s.path} → ${s.view}`).join('\n')}>
      共享 {n} 个文件夹 · 读写
    </button>
  );
}

export function Ring({ snap }: { snap: Snapshot }) {
  const { now, run } = useApp();
  return (
    <button
      className={`ring ${snap.level}`}
      title={`${snap.headline} · 上次检查 ${relativeTime(snap.lastCheckAt, now)}（点击立即检查）`}
      onClick={() => run(() => act('quickCheck'))}
    />
  );
}

export function levelOf(ok: boolean | undefined): Level {
  return ok === undefined ? 'idle' : ok ? 'ok' : 'error';
}

export function gib(bytes?: number): string {
  return bytes ? `${Math.round(bytes / 1024 ** 3)} GB` : '?';
}

/** 「就用新的出口」：先测两端（等同 rebaseline.sh --dry-run），一致才给确认按钮；
 *  确认后主进程再弹系统对话框（二次确认），脚本重新测量后才写入。 */
export function RebaselineFlow({ compact }: { compact?: boolean }) {
  const { run } = useApp();
  const [phase, setPhase] = useState<'idle' | 'measuring' | 'ready' | 'mismatch' | 'failed'>('idle');
  const [res, setRes] = useState<RunResult | null>(null);
  const v = res?.values ?? {};

  const measure = async () => {
    setPhase('measuring');
    const r = await run(() => act('previewRebaseline'));
    if (!r) return setPhase('idle');
    setRes(r);
    if (r.ok) setPhase('ready');
    else if (r.checks.some((c) => c.id === 'egress.host_matches_vm' && !c.ok)) setPhase('mismatch');
    else setPhase('failed');
  };
  const accept = async () => {
    const ip = res?.values.host_egress;
    if (!ip) return;
    const r = await run(() => act('acceptRebaseline', ip));
    if (r === null) return; // 在系统对话框里取消了
    if (r && !r.ok) {
      setRes(r);
      setPhase('failed');
    } else setPhase('idle');
  };

  if (phase === 'idle')
    return (
      <button className={`btn ${compact ? 'sm' : ''} primary`} onClick={measure}>
        就用新的出口
      </button>
    );
  if (phase === 'measuring') return <span className="muted small">正在测量 Mac 与 VM 的出口…</span>;
  return (
    <div className="col" style={{ minWidth: 260 }}>
      <div className="compare">
        <span className="muted">记住的基线</span>
        <span className="mono">{v.old_baseline ?? '—'}</span>
        <span className="muted">Mac 专用入口</span>
        <span className="mono">{v.host_egress || '不通'}</span>
        <span className="muted">VM</span>
        <span className="mono">{v.vm_egress || '不通'}</span>
      </div>
      {phase === 'ready' && (
        <>
          <p className="small muted">两边一致。确认前请在 Clash Verge「连接」里核对：cc-vm-in → CC-VM-FIXED → 你选定的节点。</p>
          <div className="row">
            <button className="btn sm primary" onClick={accept}>
              确认使用 {v.host_egress}
            </button>
            <button className="btn sm ghost" onClick={() => setPhase('idle')}>
              取消
            </button>
          </div>
        </>
      )}
      {phase === 'mismatch' && <p className="small err-text">两边不一致，保持阻断。换节点或排查后再试（可能节点有多个出口，或 VM 没走专用入口）。</p>}
      {phase === 'failed' && <p className="small err-text">{res?.reason ?? '没有完成'}</p>}
      {phase !== 'ready' && (
        <button className="btn sm" onClick={measure}>
          重新测量
        </button>
      )}
    </div>
  );
}

export function Toast({ text, kind, onClose }: { text: string; kind: 'error' | 'ok'; onClose: () => void }) {
  return (
    <div className={`toast ${kind}`} role="status">
      <Dot level={kind === 'error' ? 'error' : 'ok'} />
      <span>{text}</span>
      <button className="btn sm ghost" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}
