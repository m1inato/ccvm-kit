// 网络：代理通不通、出口 IP、出网方式（自带核心或 Clash Verge）。
import { useState } from 'react';
import { latestChecks } from '../../core/checks';
import { relativeTime } from '../../core/status';
import { act, useApp } from '../api';
import { Badge, Item, levelOf, PageTitle, Section, Segmented } from '../components/common';
import { CoreDetails, CoreSetup } from '../components/EgressCore';
import { Icon } from '../components/Icon';

const CHECKS: [string, string][] = [
  ['host.proxy', 'Mac 代理入口'],
  ['vm.proxy', 'VM 经代理出网'],
  ['vm.tun', 'VM 的 TUN'],
  ['vm.firewall', 'VM 的防火墙'],
];

export function NetworkPage() {
  const { snap, now, run } = useApp();
  const mode = snap.settings.egressMode;
  const last = snap.lastCheck;
  const checks = last ? latestChecks(last.checks) : undefined;
  const ip = snap.egress.vm ?? snap.egress.host;
  const running = snap.vm.status === 'Running';
  return (
    <div className="main-scroll narrow">
      <PageTitle title="网络" />
      <div className="page">
        <div className={`card status-hero ${snap.level}`}>
          <div className="ring">
            <Icon name={snap.level === 'error' ? 'zap' : 'globe'} size={28} />
          </div>
          <div className="grow">
            <div className="big">{snap.headline}</div>
            <div className="sub">
              {snap.level === 'ok' && ip ? (
                <>
                  出口 <span className="mono">{ip}</span>
                </>
              ) : (
                snap.detail || '—'
              )}
              {snap.lastCheckAt ? ` · ${relativeTime(snap.lastCheckAt, now)}检查` : ''}
            </div>
          </div>
          <button className="btn" disabled={snap.checking || !running} onClick={() => run(() => act('quickCheck'))}>
            <Icon name="refresh" size={14} />
            {snap.checking ? '检查中' : '检查'}
          </button>
        </div>

        {checks && running && (
          <Section title="检查" hint="代理断了时 VM 自己断网：VM 的防火墙只放行到代理入口的连接。">
            {CHECKS.map(([id, label]) => {
              const c = checks.get(id);
              return (
                <Item key={id} label={label}>
                  <Badge level={levelOf(c?.ok)}>{c ? (c.ok ? '正常' : '不通') : '—'}</Badge>
                </Item>
              );
            })}
          </Section>
        )}

        <Section title="出网方式" hint="VM 只连 Mac 上的 127.0.0.1:17897。切换时会短暂断网。">
          <Item label={mode === 'builtin' ? 'CCVM 自带核心' : '我的 Clash Verge'}>
            <Segmented
              value={mode}
              options={[
                ['builtin', '自带核心'],
                ['clash-verge', 'Clash Verge'],
              ]}
              onChange={(m) => m !== mode && void run(() => act('setEgressMode', m))}
            />
          </Item>
        </Section>

        {mode === 'builtin' ? (
          <>
            <CoreSetup snap={snap} />
            <CoreDetails snap={snap} />
          </>
        ) : (
          <ClashVergeScript />
        )}
      </div>
    </div>
  );
}

function ClashVergeScript() {
  const { snap, run } = useApp();
  const [node, setNode] = useState(snap.settings.nodeName);
  const [err, setErr] = useState<string | null>(null);
  const copy = async () => {
    const r = await run(() => act('clashScript', node));
    if (!r?.ok || !r.script) return setErr(r?.error ?? '生成失败');
    setErr(null);
    await run(() => act('updateSettings', { nodeName: node.trim() }));
    await run(() => act('copyText', r.script!), '已复制扩展脚本');
  };
  return (
    <Section title="扩展脚本" hint="在 Clash Verge 的订阅卡片上右键 → 扩展脚本，粘贴并保存，再重新激活订阅。">
      <Item label="节点">
        <input className="input" style={{ width: 300 }} value={node} onChange={(e) => setNode(e.target.value)} placeholder="和 Clash Verge 里显示的一致" />
        <button className="btn sm primary" disabled={!node.trim()} onClick={copy}>
          复制脚本
        </button>
      </Item>
      {err && <Item label={<span className="small err-text">{err}</span>} />}
    </Section>
  );
}
