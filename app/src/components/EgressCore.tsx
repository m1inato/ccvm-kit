// 自带出口核心的界面：订阅、节点、测延迟、核心状态。设置页和欢迎页共用。
import { useState } from 'react';
import { subscriptionUrlProblem } from '../../core/mihomo';
import { relativeTime } from '../../core/status';
import type { CoreStatus, Snapshot } from '../../core/types';
import { act, useApp } from '../api';
import { Dot, Toggle } from './common';

export function coreLevel(core: CoreStatus | undefined): 'ok' | 'error' | 'idle' | 'busy' {
  if (!core) return 'idle';
  if (!core.mihomo.path || !core.mihomo.versionOk || core.pending || core.stopped) return core.node || core.pending ? 'error' : 'idle';
  if (!core.node) return 'idle';
  if (!core.service.running) return 'error';
  return core.listenerOwned === false ? 'error' : 'ok';
}

export function CoreStatusLine({ snap }: { snap: Snapshot }) {
  const { now } = useApp();
  const core = snap.core;
  const level = coreLevel(core);
  let text = '正在读取出口核心状态…';
  if (core) {
    if (!core.mihomo.path) text = '找不到 mihomo（brew install mihomo）';
    else if (!core.mihomo.versionOk) text = `mihomo ${core.mihomo.version ?? '?'} 太旧，需要 ≥ 1.19.0`;
    else if (core.pending) text = '选定节点变了，等你确认（VM 已断网）';
    else if (core.stopped) text = core.stopped.detail;
    else if (!core.node) text = '还没选节点，核心没有启动';
    else if (!core.service.running) text = '核心没有在运行（launchd 正在拉起）';
    else text = `自带核心 127.0.0.1:17897 · 只听回环 · ${core.node.name}`;
  }
  const quick = snap.lastQuick;
  return (
    <div className="card pad row small">
      <Dot level={level} />
      <span className="grow">{text}</span>
      <span className="muted">
        {snap.egress.host ? `出口 ${snap.egress.host} · ` : ''}
        {quick ? `${relativeTime(quick.at, now)}检查${quick.ok ? '通过' : '未通过'}` : ''}
      </span>
    </div>
  );
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

  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="card pad col">
        <div className="row">
          <h2 className="grow">订阅</h2>
          {sub?.set && <span className="tiny faint">存在钥匙串里，只在这台 Mac 上</span>}
        </div>
        {sub?.set && (
          <div className="row small">
            <span className="mono grow ellipsis">{sub.masked}</span>
            <button className="btn sm" disabled={!!busy} onClick={() => doing('update', () => act('updateSubscription'), '订阅已更新')}>
              {busy === 'update' ? '更新中…' : '立即更新'}
            </button>
          </div>
        )}
        <div className="row">
          <input
            className={`input grow mono ${problem ? 'invalid' : ''}`}
            placeholder={sub?.set ? '换一个订阅链接' : '粘贴订阅链接（https://…）'}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          <button
            className="btn primary"
            disabled={!url.trim() || !!problem || !!busy}
            onClick={async () => {
              const r = await doing('save', () => act('setSubscription', url.trim()));
              if (r) setUrl('');
            }}
          >
            {busy === 'save' ? '下载中…' : sub?.set ? '替换' : '保存'}
          </button>
        </div>
        {problem && <span className="small err-text">{problem}</span>}
        <span className="tiny faint">
          只支持 Clash（YAML）格式的订阅。链接里有你的账号令牌：只存钥匙串，不进 VM、不写日志和导出记录。
          {sub?.lastUpdate ? ` 上次更新 ${relativeTime(sub.lastUpdate, now)}。` : ''}
        </span>
        {sub?.error && <span className="small muted">上次更新失败：{sub.error}（核心继续用原来的节点）</span>}
        {!compact && sub && (
          <>
            <div className="setting-row">
              <span className="grow">
                每天自动更新
                <div className="tiny faint">选定节点变了或从订阅里消失：先断网，等你确认后才换</div>
              </span>
              <Toggle checked={sub.autoUpdate} onChange={(v) => run(() => act('setCoreOptions', { autoUpdate: v }))} />
            </div>
            <div className="setting-row">
              <span className="grow">
                经 Clash Verge 下载订阅
                <div className="tiny faint">直连打不开订阅时，借 Clash Verge 的 127.0.0.1:7897，只用于下载订阅文件</div>
              </span>
              <Toggle checked={sub.viaClashVerge} onChange={(v) => run(() => act('setCoreOptions', { viaClashVerge: v }))} />
            </div>
          </>
        )}
      </div>

      {nodes.length > 0 && (
        <div className="card pad col">
          <div className="row">
            <h2 className="grow">节点</h2>
            {core?.latencyAt && (
              <span className="tiny faint" title={core.latencyUrl}>
                延迟测于 {relativeTime(core.latencyAt, now)}
                {core.latencyUrl ? ` · ${core.latencyUrl} · 统一延迟：${core.latencyUnified ? '开' : '关'}` : ''}
              </span>
            )}
            <button className="btn sm" disabled={!!busy} onClick={() => doing('latency', () => act('latencyTest'))} title="临时起一个没有任何入口的核心，逐个节点访问测试地址，测完就关">
              {busy === 'latency' ? '测试中…' : '测延迟'}
            </button>
          </div>
          <div className="col" style={{ gap: 2, maxHeight: compact ? 220 : 360, overflow: 'auto' }}>
            {nodes.map((n) => {
              const ms = latency[n.name];
              return (
                <label key={n.name} className="row small node-row" style={{ cursor: 'pointer' }}>
                  <span className={`radio ${choice === n.name ? 'on' : ''}`} onClick={() => setChoice(n.name)} />
                  <span className="grow ellipsis" onClick={() => setChoice(n.name)}>
                    {n.name}
                    {pinned === n.name && (
                      <span className="chip accent" style={{ marginLeft: 6 }}>
                        已固定
                      </span>
                    )}
                  </span>
                  <span className="mono tiny faint">
                    {n.type} · {n.server}
                  </span>
                  <span className={`mono tiny ${ms === null ? 'err-text' : 'muted'}`} style={{ width: 60, textAlign: 'right' }}>
                    {ms === undefined ? '' : ms === null ? '超时' : `${ms} ms`}
                  </span>
                </label>
              );
            })}
          </div>
          <div className="row">
            <span className="tiny faint grow">
              只固定一个节点：核心只连它，其余一律拒绝；节点不在了就拒绝，不会改走直连。
            </span>
            <button
              className="btn primary"
              disabled={!choice || !!busy || (choice === pinned && !core?.pending && !core?.stopped)}
              onClick={() => doing('select', () => act('selectNode', choice))}
            >
              {busy === 'select' ? '启动中…' : core?.pending && choice === pinned ? '使用新的节点信息' : choice === pinned ? '重新启动' : pinned ? '换到这个节点' : '使用这个节点'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function CoreDetails({ snap }: { snap: Snapshot }) {
  const { run } = useApp();
  const core = snap.core;
  if (!core) return null;
  const iface = core.iface ?? '—';
  return (
    <div className="card pad col">
      <h2>核心怎么连出去</h2>
      <div className="kv">
        <span>绑定网卡</span>
        <span>
          <span className="mono">{iface}</span> · 网络切换时自动改绑，切换的几秒 VM 断网；找不到物理网卡就保持断网
        </span>
        <span>节点域名</span>
        <span>
          自己解析，用当前网卡的 DHCP DNS（<span className="mono">dhcp://{iface}</span>），不受 Clash Verge 接管 DNS 影响
        </span>
        <span>控制接口</span>
        <span>只开本机 socket，不开端口</span>
        <span>入口</span>
        <span>127.0.0.1:17897，只收 TCP；不开虚拟网卡、不设系统代理、不允许局域网</span>
        <span>核心程序</span>
        <span>
          {core.mihomo.path ? (
            <>
              <span className="mono">{core.mihomo.path}</span> · v{core.mihomo.version ?? '?'}（Homebrew）
            </>
          ) : (
            <span className="err-text">没有安装：brew install mihomo</span>
          )}
        </span>
        <span>后台服务</span>
        <span>
          launchd · {core.service.running ? `运行中（pid ${core.service.pid}）` : core.service.loaded ? '已加载，未运行' : '未加载'}；App 退出后照常工作
        </span>
      </div>
      {core.mihomo.versionChanged && (
        <div className="callout warn small">mihomo 升级到了 v{core.mihomo.version}。请重新做一次断流测试；通过后这条提示会消失。</div>
      )}
      <div className="row wrap">
        <button className="btn sm" disabled={!core.node} onClick={() => run(() => act('restartCore'), '核心已重启，正在检查')}>
          重启核心
        </button>
        <button className="btn sm danger" disabled={!core.node && !core.service.loaded} onClick={() => run(() => act('removeCore'))}>
          移除出口核心
        </button>
        <button className="btn sm ghost" disabled={!core.subscription.set} onClick={() => run(() => act('clearSubscription'))}>
          清除订阅链接
        </button>
      </div>
      <p className="tiny faint">mihomo 和 Clash Verge Rev 都是 GPL-3.0。App 只调用你用 Homebrew 装的 mihomo，不分发它。</p>
    </div>
  );
}
