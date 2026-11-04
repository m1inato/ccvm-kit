// 项目页右侧面板：链路 / 连接 / 检查。只显示脚本给出的结论和原话。
import { useEffect, useState } from 'react';
import { latestChecks } from '../../core/checks';
import { CHECK_GROUPS, checkLabel, LEAK_IDS, MATRIX, matrixDone, mergeChecks } from '../../core/report';
import { relativeTime } from '../../core/status';
import type { CoreConnection, Level, Snapshot } from '../../core/types';
import { act, errorText, useApp } from '../api';
import { Dot, levelOf, RebaselineFlow } from './common';

type Tab = 'chain' | 'conn' | 'checks';

export function RightPanel({ snap }: { snap: Snapshot }) {
  const [tab, setTab] = useState<Tab>('chain');
  return (
    <aside className="panel">
      <div className="panel-tabs">
        {(
          [
            ['chain', '链路'],
            ['conn', '连接'],
            ['checks', '检查'],
          ] as [Tab, string][]
        ).map(([id, label]) => (
          <button key={id} className={`tab ${tab === id ? 'active' : ''}`} onClick={() => setTab(id)}>
            {label}
          </button>
        ))}
      </div>
      <div className="panel-body">
        {tab === 'chain' && <ChainPanel snap={snap} />}
        {tab === 'conn' && <ConnectionsPanel snap={snap} />}
        {tab === 'checks' && <ChecksPanel snap={snap} />}
      </div>
    </aside>
  );
}

function fmtTime(at?: number): string {
  if (!at) return '—';
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function leakLine(snap: Snapshot, now: number): string {
  const leak = snap.lastLeak;
  if (!leak) return '还没有做过断流测试';
  const v = leak.values;
  const capture = latestChecks(leak.checks);
  const counted = capture.get('leak.capture_control')?.ok && capture.has('leak.capture_bypass');
  return counted
    ? `上次断流测试 ${relativeTime(leak.at, now)}：经专用入口 ${v.capture_control ?? '?'} 个包，旁路 ${v.capture_bypass ?? '?'} 个${leak.ok ? '' : '（未通过）'}`
    : `上次断流测试 ${relativeTime(leak.at, now)}：没有通过（${leak.reason ?? '抓包结果不可信'}）`;
}

function ChainPanel({ snap }: { snap: Snapshot }) {
  const { now, run } = useApp();
  const merged = mergeChecks([snap.lastQuick, snap.lastFull]);
  const st = (id: string): Level => levelOf(merged.get(id)?.ok);
  const why = (id: string) => merged.get(id)?.msg;
  const running = snap.vm.status === 'Running';
  const busy = snap.jobs.some((j) => j.state === 'running' && ['leaktest', 'setup', 'vm-start', 'vm-stop'].includes(j.kind));
  const egressChanged = snap.issues.find((i) => i.kind === 'egress_changed');
  const ip = snap.egress.vm ?? snap.egress.baseline ?? '?';
  const nodeName = snap.settings.egressMode === 'builtin' ? snap.core?.node?.name : snap.settings.nodeName;
  const rows: { label: string; sub: string; level: Level; note?: string }[] = [
    { label: 'cc 用户', sub: '无 sudo，没有代理变量', level: st('cc.no_sudo'), note: merged.has('cc.no_sudo') ? why('cc.no_sudo') : '完整验收里检查' },
    {
      label: 'Mac 文件夹',
      sub: snap.shares.applied.length
        ? `共享 ${snap.shares.applied.length} 个 · 读写（VM 里在 /home/cc/mac）`
        : '不共享：VM 里没有 Mac 的文件夹',
      level: st('lima.effective_config'),
      note: why('lima.effective_config'),
    },
    { label: 'sb-tun', sub: 'sing-box TUN，所有 TCP 与 DNS 进 TUN', level: st('vm.tun_up'), note: why('vm.tun_up') },
    { label: '防火墙', sub: '主规则；TUN 停了也不会直连', level: st('vm.firewall_main_rules'), note: why('vm.firewall_main_rules') },
    {
      label: '专用入口 127.0.0.1:17897',
      sub: snap.settings.egressMode === 'builtin'
        ? `自带核心 · 只听回环${snap.core?.iface ? ` · 绑定 ${snap.core.iface}` : ''}`
        : 'Clash Verge · 只听回环',
      level: st('listener.loopback_only'),
      note: why('listener.loopback_only'),
    },
    {
      label: `节点${nodeName ? ` · ${nodeName}` : ''}`,
      sub: 'Mac 专用入口的出口 = 基线',
      level: st('egress.host_matches_baseline'),
      note: why('egress.host_matches_baseline'),
    },
    { label: `出口 ${ip}`, sub: 'VM 的出口 = 基线', level: st('egress.vm_matches_baseline'), note: why('egress.vm_matches_baseline') },
  ];
  const headline = snap.level === 'error' ? snap.headline : snap.level === 'ok' ? '受保护' : snap.headline;
  return (
    <>
      <div className="col" style={{ gap: 4 }}>
        <h2 className={snap.level === 'error' ? 'err-text' : snap.level === 'ok' ? 'ok-text' : ''}>{headline}</h2>
        <p className="small muted">
          {snap.level === 'ok'
            ? `这台 VM 里的 Claude、git、npm 都只经 ${ip} 出去，和你记住的出口一致。VM 自己连不到你的 Mac。${snap.shares.applied.length ? `你共享的 ${snap.shares.applied.length} 个 Mac 文件夹 VM 可以读写。` : ''}`
            : snap.detail}
        </p>
      </div>
      {egressChanged && (
        <div className="callout err col">
          <span>核实：Mac 专用入口和 VM 的出口一致，连接都走选定节点，才更新基线；不一致就保持阻断。</span>
          <RebaselineFlow compact />
        </div>
      )}
      <div className="chain">
        {rows.map((r) => (
          <div className="chain-row" key={r.label} title={r.note}>
            <Dot level={r.level} />
            <div className="label">
              <b>{r.label}</b>
              <div>{r.sub}</div>
            </div>
            <span className={`status ${r.level}`}>{r.level === 'ok' ? '正常' : r.level === 'error' ? '异常' : '未知'}</span>
          </div>
        ))}
      </div>
      <p className="tiny faint">
        上次检查 {fmtTime(snap.lastCheckAt)} · {leakLine(snap, now)}
      </p>
      <div className="row">
        <button className="btn sm" disabled={!running || snap.checking || busy} onClick={() => run(() => act('quickCheck'))}>
          {snap.checking ? '检查中…' : '现在检查'}
        </button>
        <button className="btn sm" disabled={!running || busy} onClick={() => run(() => act('leaktest'), '断流测试已开始（约 30 秒，期间 VM 断网）')}>
          断流测试
        </button>
      </div>
    </>
  );
}

function ConnectionsPanel({ snap }: { snap: Snapshot }) {
  const { go } = useApp();
  if (snap.settings.egressMode === 'builtin' && snap.core?.service.running) return <CoreConnections snap={snap} />;
  return (
    <>
      <div className="row">
        <Dot level="idle" />
        <h3>{snap.settings.egressMode === 'builtin' ? '出口核心没有在运行' : '未连接（可选）'}</h3>
      </div>
      <p className="small muted">
        {snap.settings.egressMode === 'builtin'
          ? '核心运行时，这里直接经本机 socket 读它的连接。'
          : '用 Clash Verge 时，连接列表要读它的外部控制器（还没做）；App 只读，不改它的配置。改用自带核心可以直接看。'}
      </p>
      <div className="callout small">
        也可以在 Clash Verge 的「连接」里核对：每条来自 VM 的连接都应是 <code>cc-vm-in → CC-VM-FIXED → {snap.settings.nodeName || '你的节点'}</code>。
      </div>
      <button className="btn sm" onClick={() => go('/settings/egress')}>
        网络出口设置
      </button>
    </>
  );
}

function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 ** 2).toFixed(1)} MB`;
}

/** 自带核心的实时连接：按目标汇总，核对每条都只经过选定节点 */
function CoreConnections({ snap }: { snap: Snapshot }) {
  const [conns, setConns] = useState<CoreConnection[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      act('coreConnections')
        .then((c) => alive && (setConns(c), setErr(null)))
        .catch((e) => alive && setErr(errorText(e)));
    void load();
    const t = setInterval(load, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);
  const node = snap.core?.node?.name ?? '';
  if (err) return <p className="small err-text">读不到核心的连接：{err}</p>;
  if (!conns) return <p className="small muted">读取中…</p>;
  const groups = new Map<string, { total: number; count: number; chains: Set<string> }>();
  for (const c of conns) {
    const key = c.host || c.destination || '?';
    const g = groups.get(key) ?? { total: 0, count: 0, chains: new Set<string>() };
    g.total += c.upload + c.download;
    g.count += 1;
    g.chains.add(c.chains.join(' → ') || '（无）');
    groups.set(key, g);
  }
  const offPath = conns.filter((c) => c.chains.length !== 1 || c.chains[0] !== node);
  const rows = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  return (
    <>
      <p className={`small ${offPath.length ? 'err-text' : 'muted'}`}>
        {conns.length === 0
          ? '现在没有连接。'
          : offPath.length
            ? `${offPath.length} 条连接没有只经过选定节点，请检查核心配置。`
            : `现在 ${conns.length} 条连接，全部经过选定节点「${node}」出去，没有直连。`}
      </p>
      <div className="chain">
        {rows.slice(0, 40).map(([dest, g]) => {
          const ok = g.chains.size === 1 && g.chains.has(node);
          return (
            <div className="chain-row" key={dest} title={[...g.chains].join('\n')}>
              <Dot level={ok ? 'ok' : 'error'} />
              <div className="label">
                <b className="mono" style={{ fontSize: 12 }}>{dest}</b>
                <div>
                  {g.count} 条 · {bytes(g.total)}
                </div>
              </div>
              <span className={`status ${ok ? 'ok' : 'error'}`}>{ok ? '节点' : '异常'}</span>
            </div>
          );
        })}
      </div>
      <p className="tiny faint">VM 先经 DoH 解析再按 IP 转发，所以这里只看得到 IP。显示域名需要把 VM 内 DNS 改成 FakeIP 并重新验收。</p>
    </>
  );
}

function ChecksPanel({ snap }: { snap: Snapshot }) {
  const { now, run } = useApp();
  const merged = mergeChecks([snap.lastQuick, snap.lastFull]);
  const all = [...merged.values()];
  const failed = all.filter((c) => !c.ok).length;
  const running = snap.vm.status === 'Running';
  const busy = snap.jobs.some((j) => j.state === 'running' && ['check-full', 'leaktest', 'setup'].includes(j.kind));
  const leak = snap.lastLeak ? latestChecks(snap.lastLeak.checks) : new Map();
  const matrix = matrixDone(snap);
  const doneCount = matrix.filter((m) => m.done).length;
  return (
    <>
      <div className="col" style={{ gap: 2 }}>
        <h2 className={failed ? 'err-text' : all.length ? 'ok-text' : ''}>
          {!all.length ? '还没有检查结果' : failed ? `${failed} 项没有通过` : `${all.length} 项都通过了`}
        </h2>
        <p className="tiny faint">
          快速检查 {relativeTime(snap.lastQuick?.at, now)} · 完整验收 {relativeTime(snap.lastFull?.at, now)}
        </p>
      </div>
      {CHECK_GROUPS.map((g) => {
        const items = g.ids.filter((id) => merged.has(id) || g.ids.length < 8);
        if (!items.length) return null;
        return (
          <div key={g.title}>
            <div className="group-title">{g.title}</div>
            <div className="check-list">
              {items.map((id) => {
                const c = merged.get(id);
                return (
                  <div className="check-item" key={id} title={id}>
                    <Dot level={levelOf(c?.ok)} />
                    <div className="grow">
                      <div>{checkLabel(id)}</div>
                      {c && !c.ok && <div className="why err-text">{c.msg}</div>}
                      {!c && <div className="why">未检查（完整验收里有）</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
      <div>
        <div className="group-title">断流测试</div>
        <p className="small muted" style={{ marginBottom: 4 }}>
          {leakLine(snap, now)}
        </p>
        <div className="check-list">
          {LEAK_IDS.filter((id) => leak.has(id)).map((id) => {
            const c = leak.get(id);
            return (
              <div className="check-item" key={id} title={id}>
                <Dot level={levelOf(c?.ok)} />
                <div className="grow">
                  <div>{checkLabel(id)}</div>
                  {c && !c.ok && <div className="why err-text">{c.msg}</div>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <div className="row">
          <div className="group-title grow">验收矩阵</div>
          <span className="tiny faint">
            {doneCount}/{MATRIX.length}
          </span>
        </div>
        <div className="progress" style={{ margin: '4px 0 6px' }}>
          <div style={{ width: `${(doneCount / MATRIX.length) * 100}%` }} />
        </div>
        <div className="check-list">
          {MATRIX.map((m) => {
            const done = matrix.find((x) => x.id === m.id)?.done ?? false;
            return (
              <label className="check-item" key={m.id} title={m.how} style={{ cursor: m.auto ? 'default' : 'pointer' }}>
                <input
                  type="checkbox"
                  checked={done}
                  disabled={!!m.auto}
                  onChange={(e) => run(() => act('setMatrix', m.id, e.target.checked))}
                />
                <div className="grow">
                  <div>{m.label}</div>
                  <div className="why">{m.auto ? `${m.how}（自动）` : m.how}</div>
                </div>
              </label>
            );
          })}
        </div>
      </div>
      <div className="row wrap">
        <button className="btn sm" disabled={!running || busy} onClick={() => run(() => act('fullCheck'), '完整验收已在后台开始')}>
          完整验收
        </button>
        <button className="btn sm" disabled={!running || busy} onClick={() => run(() => act('leaktest'), '断流测试已开始（约 30 秒，期间 VM 断网）')}>
          断流测试
        </button>
        <button className="btn sm" onClick={() => run(() => act('exportReport'))}>
          导出为 Markdown
        </button>
      </div>
    </>
  );
}
