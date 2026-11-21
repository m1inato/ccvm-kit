// 自带出口核心的界面：订阅、节点、核心。网络页和欢迎页共用。
import { useState } from 'react';
import { subscriptionUrlProblem } from '../../core/mihomo';
import { relativeTime } from '../../core/status';
import type { CoreStatus, Snapshot } from '../../core/types';
import { act, useApp } from '../api';
import { Badge, Item, Section, Toggle } from './common';

export function coreLevel(core: CoreStatus | undefined): 'ok' | 'error' | 'idle' {
  if (!core || !core.node) return 'idle';
  if (!core.mihomo.path || !core.mihomo.versionOk) return 'error';
  if (core.stopped) return 'idle';
  if (!core.service.running || core.listenerOwned === false) return 'error';
  return 'ok';
}

function coreText(core: CoreStatus | undefined): string {
  if (!core) return '读取中';
  if (!core.mihomo.path) return '没有安装 mihomo';
  if (!core.mihomo.versionOk) return `mihomo ${core.mihomo.version ?? '?'} 太旧`;
  if (!core.node) return '还没选节点';
  if (core.stopped) return '已停止';
  if (!core.service.running) return '没有在运行';
  if (core.listenerOwned === false) return '端口被占用';
  return '运行中';
}

/** 订阅链接 + 节点列表。compact 用在欢迎页 */
export function CoreSetup({ snap, compact }: { snap: Snapshot; compact?: boolean }) {
  const { run, now } = useApp();
  const core = snap.core;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState<'' | 'save' | 'update' | 'latency' | 'select'>('');
  const [choice, setChoice] = useState<string>(core?.node?.name ?? '');
  const problem = url.trim() ? subscriptionUrlProblem(url) : null;
  const sub = core?.subscription;
  const nodes = core?.nodes ?? [];
  const pinned = core?.node?.name;
  const latency = core?.latency ?? {};

  const doing = async <T,>(what: typeof busy, fn: () => Promise<T>, ok?: string) => {
    setBusy(what);
    try {
      return await run(fn, ok);
    } finally {
      setBusy('');
    }
  };

  const applyLabel = busy === 'select' ? '启动中…' : choice === pinned ? '重新启动' : pinned ? '切换到这个节点' : '使用这个节点';

  return (
    <>
      <Section title="订阅" hint="Clash（YAML）格式。链接只存在钥匙串里。">
        {sub?.set && (
          <Item label={<span className="mono ellipsis">{sub.masked}</span>} value={sub.lastUpdate ? `${relativeTime(sub.lastUpdate, now)}更新` : undefined}>
            <button className="btn sm" disabled={!!busy} onClick={() => doing('update', () => act('updateSubscription'), '订阅已更新')}>
              {busy === 'update' ? '更新中…' : '更新'}
            </button>
          </Item>
        )}
        <div className="item">
          <input
            className={`input grow mono ${problem ? 'invalid' : ''}`}
            placeholder={sub?.set ? '换一个订阅链接' : '粘贴订阅链接'}
            value={url}
            spellCheck={false}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            className="btn sm primary"
            disabled={!url.trim() || !!problem || !!busy}
            onClick={async () => {
              const r = await doing('save', () => act('setSubscription', url.trim()));
              if (r) setUrl('');
            }}
          >
            {busy === 'save' ? '下载中…' : sub?.set ? '替换' : '保存'}
          </button>
        </div>
        {problem && <Item label={<span className="small err-text">{problem}</span>} />}
        {sub?.error && <Item label={<span className="small err-text">上次更新失败：{sub.error}</span>} />}
        {!compact && sub?.set && (
          <>
            <Item label="每天自动更新" hint="节点的地址或密码变了会自动换上新的。">
              <Toggle checked={sub.autoUpdate} onChange={(v) => run(() => act('setCoreOptions', { autoUpdate: v }))} />
            </Item>
            <Item label="经 Clash Verge 下载" hint="直连打不开订阅时，借 Clash Verge 的 127.0.0.1:7897 下载。">
              <Toggle checked={sub.viaClashVerge} onChange={(v) => run(() => act('setCoreOptions', { viaClashVerge: v }))} />
            </Item>
          </>
        )}
      </Section>

      {nodes.length > 0 && (
        <Section
          title="节点"
          aside={
            <>
              {core?.latencyAt && <span className="tiny faint" title={core.latencyUrl}>{relativeTime(core.latencyAt, now)}测过</span>}
              <button className="btn sm ghost" disabled={!!busy} onClick={() => doing('latency', () => act('latencyTest'))}>
                {busy === 'latency' ? '测试中…' : '测延迟'}
              </button>
            </>
          }
        >
          <div className="scroll-list" style={{ maxHeight: compact ? 240 : 380, overflow: 'auto' }}>
            {nodes.map((n) => {
              const ms = latency[n.name];
              return (
                <div key={n.name} className={`item selectable ${choice === n.name ? 'on' : ''}`} onClick={() => setChoice(n.name)}>
                  <span className={`radio ${choice === n.name ? 'on' : ''}`} />
                  <span className="label">
                    <span className="ellipsis">{n.name}</span>
                    {pinned === n.name && <span className="chip accent">使用中</span>}
                  </span>
                  <span className="value mono">{n.type}</span>
                  <span className={`value mono ${ms === null ? 'err-text' : ''}`} style={{ width: 60 }}>
                    {ms === undefined ? '' : ms === null ? '超时' : `${ms} ms`}
                  </span>
                </div>
              );
            })}
          </div>
          {core?.nodeMissing && <Item label={<span className="small muted">「{pinned}」已经不在订阅里，核心继续用记下的节点信息</span>} />}
          <div className="item foot">
            <button className="btn sm primary" disabled={!choice || !!busy || (choice === pinned && !core?.stopped)} onClick={() => doing('select', () => act('selectNode', choice))}>
              {applyLabel}
            </button>
          </div>
        </Section>
      )}
    </>
  );
}

export function CoreDetails({ snap }: { snap: Snapshot }) {
  const { run } = useApp();
  const [url, setUrl] = useState(snap.settings.latencyTestUrl);
  const core = snap.core;
  if (!core) return null;
  return (
    <Section title="核心">
      <Item label="状态">
        <Badge level={coreLevel(core)}>{coreText(core)}</Badge>
      </Item>
      <Item label="程序" value={core.mihomo.path ? <span className="mono">mihomo v{core.mihomo.version ?? '?'}</span> : <span className="err-text mono">brew install mihomo</span>} />
      <Item label="测延迟地址" hint="想和 Clash Verge 的数字对得上，就填它设置里的同一个测试地址。">
        <input className="input mono" style={{ width: 300 }} value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        {url.trim() !== snap.settings.latencyTestUrl && (
          <button className="btn sm" onClick={() => void run(() => act('updateSettings', { latencyTestUrl: url.trim() }), '已保存')}>
            保存
          </button>
        )}
      </Item>
      <div className="item foot">
        <button className="btn sm ghost" disabled={!core.subscription.set} onClick={() => run(() => act('clearSubscription'))}>
          清除订阅
        </button>
        <button className="btn sm" disabled={!core.node} onClick={() => run(() => act('restartCore'), '核心已重启')}>
          重启核心
        </button>
        <button className="btn sm danger" disabled={!core.node && !core.service.loaded} onClick={() => run(() => act('removeCore'))}>
          移除核心
        </button>
      </div>
    </Section>
  );
}
