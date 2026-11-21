import type { ReactNode } from 'react';
import type { Level } from '../../core/types';

export function Dot({ level }: { level: Level | 'err' }) {
  return <span className={`dot ${level}`} />;
}

export function Toggle({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function levelOf(ok: boolean | undefined): Level {
  return ok === undefined ? 'idle' : ok ? 'ok' : 'error';
}

/** 字节数 → 人看的大小 */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function gib(bytes?: number): string {
  return bytes ? `${Math.round(bytes / 1024 ** 3)} GB` : '?';
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

/** ⓘ：悬停才看得到的说明 */
export function Hint({ text }: { text: string }) {
  return (
    <i className="hint" data-tip={text} aria-label={text}>
      i
    </i>
  );
}

/** 页面大标题，下面可以跟一行统计 */
export function PageTitle({ title, stats }: { title: string; stats?: ReactNode }) {
  return (
    <>
      <div className="page-title">
        <h1>{title}</h1>
      </div>
      {stats ? <div className="stats">{stats}</div> : <div style={{ height: 22 }} />}
    </>
  );
}

/** 一组：上面一行小标题（可带右侧动作），下面是圆角列表 */
export function Section({ title, hint, aside, children }: { title?: string; hint?: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      {(title || aside) && (
        <div className="section-head">
          {title && <b>{title}</b>}
          {hint && <Hint text={hint} />}
          <span className="spacer" />
          {aside}
        </div>
      )}
      <div className="group">{children}</div>
    </section>
  );
}

/** 列表里的一行：左边名称，右边控件或值 */
export function Item({ label, hint, value, children, className }: { label: ReactNode; hint?: string; value?: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={`item ${className ?? ''}`}>
      <span className="label">
        {label}
        {hint && <Hint text={hint} />}
      </span>
      {value !== undefined && <span className="value">{value}</span>}
      {children}
    </div>
  );
}

/** 状态：一个点加一句短话 */
export function Badge({ level, children }: { level: Level | 'warn'; children: ReactNode }) {
  return (
    <span className={`badge ${level}`}>
      <Dot level={level === 'warn' ? 'busy' : level} />
      {children}
    </span>
  );
}

/** 多选一的分段控件 */
export function Segmented<T extends string>({ value, options, onChange, small }: { value: T; options: [T, string][]; onChange: (v: T) => void; small?: boolean }) {
  return (
    <div className={`seg ${small ? 'sm' : ''}`}>
      {options.map(([v, label]) => (
        <button key={v} className={v === value ? 'on' : ''} onClick={() => onChange(v)}>
          {label}
        </button>
      ))}
    </div>
  );
}
