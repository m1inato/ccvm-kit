// 项目页右侧面板：链路 / 连接 / 检查。只显示脚本给出的结论和原话。
import { useEffect, useState } from 'react';
import { latestChecks } from '../../core/checks';
import { CHECK_GROUPS, checkLabel, LEAK_IDS, MATRIX, matrixDone, mergeChecks } from '../../core/report';
import { relativeTime } from '../../core/status';
import type { CoreConnection, Level, Snapshot } from '../../core/types';
import { act, errorText, useApp } from '../api';
import { Badge, Dot, formatBytes, levelOf, RebaselineFlow } from './common';

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

/** 断流测试一句话：时间 + 结论 + 抓包数 */
export function leakLine(snap: Snapshot, now: number): string {
  const leak = snap.lastLeak;
  if (!leak) return '还没做过断流测试';
  const v = leak.values;
  const capture = latestChecks(leak.checks);
  const counted = capture.get('leak.capture_control')?.ok && capture.has('leak.capture_bypass');
  const when = relativeTime(leak.at, now);
  if (!counted) return `断流测试 ${when} · 未通过`;
  return `断流测试 ${when} · ${leak.ok ? '通过' : '未通过'} · 入口 ${v.capture_control ?? '?'} / 旁路 ${v.capture_bypass ?? '?'}`;
}

function ChainPanel({ snap }: { snap: Snapshot }) {
  const { now, run } = useApp();
  const merged = mergeChecks([snap.lastQuick, snap.lastFull]);
  const st = (id: string): Level => levelOf(merged.get(id)?.ok);
  const msg = (id: string) => merged.get(id)?.msg;
  const running = snap.vm.status === 'Running';
  const busy = snap.jobs.some((j) => j.state === 'running' && ['leaktest', 'setup', 'vm-start', 'vm-stop'].includes(j.kind));
  const egressChanged = snap.issues.find((i) => i.kind === 'egress_changed');
  const ip = snap.egress.vm ?? snap.egress.baseline ?? '—';
  const nodeName = snap.settings.egressMode === 'builtin' ? snap.core?.node?.name : snap.settings.nodeName;
  const shares = snap.shares.applied.length;
  // 每一环：名称、右侧的短值、状态来自哪项检查；说明放在悬停提示里
  const rows: { label: string; value?: string; id: string; tip: string }[] = [
    { label: 'cc 用户', id: 'cc.no_sudo', tip: '没有 sudo，没有代理变量' },
    { label: 'Mac 文件夹', value: shares ? `共享 ${shares} 个` : '无', id: 'lima.effective_config', tip: shares ? 'VM 可以读写这些文件夹（/home/cc/mac）' : 'VM 里没有 Mac 的文件夹' },
    { label: 'TUN', id: 'vm.tun_up', tip: '所有 TCP 与 DNS 都进 TUN' },
    { label: '防火墙', id: 'vm.firewall_main_rules', tip: 'TUN 停了也不会改走直连' },
    { label: '专用入口', value: '127.0.0.1:17897', id: 'listener.loopback_only', tip: '只听回环' },
    { label: '节点', value: nodeName || '—', id: 'egress.host_matches_baseline', tip: 'Mac 专用入口的出口 = 基线' },
    { label: '出口', value: ip, id: 'egress.vm_matches_baseline', tip: 'VM 的出口 = 基线' },
  ];
  return (
    <>
      <div className="row">
        <Badge level={snap.level}>{snap.level === 'ok' ? '受保护' : snap.headline}</Badge>
        <span className="spacer" />
        <span className="tiny faint">{snap.lastCheckAt ? `${relativeTime(snap.lastCheckAt, now)}检查` : ''}</span>
      </div>
      {egressChanged && (
        <div className="callout err">
          <RebaselineFlow compact />
        </div>
      )}
      <div className="chain">
        {rows.map((r) => {
          const level = st(r.id);
          return (
            <div className="chain-row" key={r.label} title={msg(r.id) ?? r.tip}>
              <Dot level={level} />
              <div className="label">
                <b>{r.label}</b>
                {level === 'error' && <div className="err-text">{msg(r.id)}</div>}
              </div>
              {r.value && <span className="mono tiny muted ellipsis" style={{ maxWidth: 150 }}>{r.value}</span>}
            </div>
          );
        })}
      </div>
      <p className="tiny faint">{leakLine(snap, now)}</p>
      <div className="row">
        <button className="btn sm" disabled={!running || snap.checking || busy} onClick={() => run(() => act('quickCheck'))}>
          {snap.checking ? '检查中…' : '检查'}
        </button>
        <button className="btn sm" disabled={!running || busy} onClick={() => run(() => act('leaktest'), '断流测试已开始，期间 VM 断网约 30 秒')}>
          断流测试
        </button>
      </div>
    </>
  );
}

function ConnectionsPanel({ snap }: { snap: Snapshot }) {
  const { go } = useApp();
  if (snap.settings.egressMode === 'builtin' && snap.core?.service.running) return <CoreConnections snap={snap} />;
  if (snap.settings.egressMode === 'clash-verge' && snap.clashController.address) return <VergeConnectionsPanel snap={snap} />;
  const builtin = snap.settings.egressMode === 'builtin';
  return (
    <div className="empty small">
      <p>{builtin ? '出口核心没有在运行' : '没有连上 Clash Verge 的外部控制器'}</p>
      {!builtin && (
        <button className="btn sm" style={{ marginTop: 10 }} onClick={() => go('/settings/egress')}>
          设置…
        </button>
      )}
    </div>
  );
}

/** 每 3 秒读一次（面板开着时） */
function usePolled<T>(load: () => Promise<T>): { data: T | null; err: string | null } {
  const [data, setData] = useState<T | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      load()
        .then((d) => alive && (setData(d), setErr(null)))
        .catch((e) => alive && setErr(errorText(e)));
    void tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return { data, err };
}

/** 连接按目标汇总显示；offPath 里的连接（链路不对）标红。两种出网方式共用 */
function ConnectionList({ conns, offPath, okSummary, badSummary }: { conns: CoreConnection[]; offPath: Set<string>; okSummary: string; badSummary: string }) {
  const groups = new Map<string, { total: number; count: number; chains: Set<string>; bad: boolean }>();
  for (const c of conns) {
    const key = c.host || c.destination || '?';
    const g = groups.get(key) ?? { total: 0, count: 0, chains: new Set<string>(), bad: false };
    g.total += c.upload + c.download;
    g.count += 1;
    g.chains.add(c.chains.join(' → ') || '（无）');
    g.bad ||= offPath.has(c.id);
    groups.set(key, g);
  }
  // 有问题的排在最前面
  const rows = [...groups.entries()].sort((a, b) => Number(b[1].bad) - Number(a[1].bad) || b[1].total - a[1].total);
  return (
    <>
      <p className={`small ${offPath.size ? 'err-text' : 'muted'}`}>{conns.length === 0 ? '现在没有连接。' : offPath.size ? badSummary : okSummary}</p>
      <div className="chain">
        {rows.slice(0, 40).map(([dest, g]) => (
          <div className="chain-row" key={dest} title={[...g.chains].join('\n')}>
            <Dot level={g.bad ? 'error' : 'ok'} />
            <div className="label">
              <b className="mono" style={{ fontSize: 12 }}>{dest}</b>
              <div>
                {g.count} 条 · {formatBytes(g.total)}
                {g.bad ? ` · 链路：${[...g.chains].join('；')}` : ''}
              </div>
            </div>
            <span className={`status ${g.bad ? 'error' : 'ok'}`}>{g.bad ? '异常' : '节点'}</span>
          </div>
        ))}
      </div>
    </>
  );
}

/** 自带核心的实时连接：核对每条都只经过选定节点 */
function CoreConnections({ snap }: { snap: Snapshot }) {
  const { data: conns, err } = usePolled(() => act('coreConnections'));
  const node = snap.core?.node?.name ?? '';
  if (err) return <p className="small err-text">读不到核心的连接：{err}</p>;
  if (!conns) return <p className="small muted">读取中…</p>;
  const offPath = new Set(conns.filter((c) => c.chains.length !== 1 || c.chains[0] !== node).map((c) => c.id));
  return (
    <ConnectionList
      conns={conns}
      offPath={offPath}
      okSummary={`${conns.length} 条连接 · 全部经过「${node}」`}
      badSummary={`${offPath.size} 条连接没有只经过选定节点`}
    />
  );
}

/** Clash Verge 的连接（只读外部控制器）：只看入站 cc-vm-in，每条链路必须正好是 [节点, CC-VM-FIXED] */
function VergeConnectionsPanel({ snap }: { snap: Snapshot }) {
  const { data, err } = usePolled(() => act('clashConnections'));
  if (err) return <p className="small err-text">读不到 Clash Verge 的连接：{err}</p>;
  if (!data) return <p className="small muted">读取中…</p>;
  const node = data.node ?? '未知';
  const mismatch = data.node && snap.settings.nodeName && data.node !== snap.settings.nodeName;
  return (
    <>
      {mismatch && (
        <div className="callout warn small">
          CC-VM-FIXED 选的是「{data.node}」，设置里是「{snap.settings.nodeName}」
        </div>
      )}
      <ConnectionList
        conns={data.connections}
        offPath={new Set(data.offPath)}
        okSummary={`${data.connections.length} 条连接 · 全部经过 CC-VM-FIXED → ${node}`}
        badSummary={`${data.offPath.length} 条连接没有只经过 CC-VM-FIXED → ${node}`}
      />
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
        <p className="tiny faint" style={{ marginBottom: 4 }}>
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
                <div className="grow">{m.label}</div>
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
          导出…
        </button>
      </div>
    </>
  );
}
