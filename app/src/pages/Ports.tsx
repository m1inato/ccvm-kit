// 端口，两个方向：
//   VM 访问 Mac：VM 防火墙按端口放行到 192.168.5.2（= Mac 的 127.0.0.1），VM 里用 host.lima.internal:<端口>
//   Mac 访问 VM：VM 里正在监听的端口，按需经 SSH 隧道转发到 Mac 的 127.0.0.1
import { useState } from 'react';
import { relativeTime } from '../../core/status';
import type { Forward, PortItem } from '../../core/types';
import { act, useApp, usePoll } from '../api';
import { Badge, Item, PageTitle, Section, Segmented } from '../components/common';
import { Icon } from '../components/Icon';

const STATE: Record<Forward['state'], ['ok' | 'busy' | 'warn' | 'error', string]> = {
  open: ['ok', '已转发'],
  starting: ['busy', '连接中'],
  retrying: ['warn', '重连中'],
};

type Tab = 'mac' | 'vm';

export function PortsPage({ tab }: { tab?: string }) {
  const { snap, go } = useApp();
  const current: Tab = tab === 'vm' ? 'vm' : 'mac';
  const open = snap.ports.forwards.filter((f) => f.state === 'open').length;
  return (
    <div className="main-scroll narrow">
      <PageTitle
        title="端口"
        stats={
          <>
            <span>VM 能访问的 Mac 端口<b>{snap.macPorts.ports.length}</b>个</span>
            <span>转发到 Mac<b>{open}</b>个</span>
          </>
        }
      />
      <div style={{ marginBottom: 26 }}>
        <Segmented
          value={current}
          options={[
            ['mac', 'VM 访问 Mac'],
            ['vm', 'Mac 访问 VM'],
          ]}
          onChange={(t) => go(`/ports/${t}`)}
        />
      </div>
      {current === 'mac' ? <MacPortsTab /> : <VmPortsTab />}
    </div>
  );
}

// ---------------------------------------------------------------- VM 访问 Mac
function MacPortsTab() {
  const { snap, now, go, run } = useApp();
  const running = snap.vm.status === 'Running';
  usePoll(() => void act('refreshMacPorts').catch(() => undefined), 10_000, running);
  const { ports, ready, at, error } = snap.macPorts;
  const upgrading = snap.jobs.some((j) => j.state === 'running' && j.kind === 'vm-upgrade');
  return (
    <div className="page">
      {running && ready === false && (
        <div className="banner">
          <span className="title grow">VM 需要更新才能使用</span>
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
      <PortInput
        placeholder="Mac 端口，例如 5432"
        button="允许"
        disabled={!running || ready === false}
        onSubmit={(port) => run(() => act('allowMacPort', port))}
      />
      <Section
        title="VM 能访问的 Mac 端口"
        hint="VM 里用 host.lima.internal:<端口> 或 192.168.5.2:<端口>。Mac 上的服务监听 127.0.0.1 就够了。17897 留给代理。"
        aside={
          <>
            {at && <span className="tiny faint">{relativeTime(at, now)}</span>}
            <button className="icon-btn plain" title="刷新" disabled={!running} onClick={() => run(() => act('refreshMacPorts'))}>
              <Icon name="refresh" size={14} />
            </button>
          </>
        }
      >
        {!running && <Item label={<span className="muted">VM 没有运行</span>} />}
        {running && error && <Item label={<span className="small err-text">{error}</span>} />}
        {running && !error && ports.length === 0 && <Item label={<span className="muted">还没有允许的端口</span>} />}
        {running &&
          ports.map((p) => (
            <Item
              key={p.port}
              label={
                <span className="row" style={{ gap: 14, minWidth: 0 }}>
                  <span className="port-num">{p.port}</span>
                  <span className="tiny faint mono ellipsis">host.lima.internal:{p.port}</span>
                </span>
              }
            >
              {p.listening !== undefined && <Badge level={p.listening ? 'ok' : 'idle'}>{p.listening ? 'Mac 上有服务' : 'Mac 上没有服务在听'}</Badge>}
              <button className="icon-btn plain" title="不再允许" onClick={() => run(() => act('denyMacPort', p.port))}>
                <Icon name="x" size={14} />
              </button>
            </Item>
          ))}
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- Mac 访问 VM
function VmPortsTab() {
  const { snap, now, run } = useApp();
  const running = snap.vm.status === 'Running';
  usePoll(() => void act('refreshPorts').catch(() => undefined), 5000, running);
  const { items, forwards, at, error } = snap.ports;
  const listening = new Map(items.map((p) => [p.port, p]));
  const forwarded = new Set(forwards.map((f) => f.vmPort));
  const free = items.filter((p) => !forwarded.has(p.port));

  return (
    <div className="page">
      <AddForward disabled={!running} />

      {forwards.length > 0 && (
        <Section title="转发" hint="Mac 上只绑 127.0.0.1，局域网里的其他设备访问不到。App 退出时结束，下次打开自动接上。">
          {forwards.map((f) => (
            <ForwardRow key={f.vmPort} f={f} item={listening.get(f.vmPort)} known={at !== undefined} />
          ))}
        </Section>
      )}

      <Section
        title="VM 里在监听"
        aside={
          <>
            {at && <span className="tiny faint">{relativeTime(at, now)}</span>}
            <button className="icon-btn plain" title="刷新" disabled={!running} onClick={() => run(() => act('refreshPorts'))}>
              <Icon name="refresh" size={14} />
            </button>
          </>
        }
      >
        {!running && <Item label={<span className="muted">VM 没有运行</span>} />}
        {running && error && <Item label={<span className="small err-text">{error}</span>} />}
        {running && !error && free.length === 0 && <Item label={<span className="muted">{items.length ? '都已经转发了' : '没有在监听的端口'}</span>} />}
        {running &&
          free.map((p) => (
            <Item key={p.port} label={<PortLabel p={p} />}>
              <button className="btn sm" onClick={() => run(() => act('addForward', p.port))}>
                转发到 Mac
              </button>
            </Item>
          ))}
      </Section>
    </div>
  );
}

/** 一个端口号输入框加一个按钮 */
function PortInput({ placeholder, button, disabled, onSubmit }: { placeholder: string; button: string; disabled: boolean; onSubmit: (port: number) => Promise<unknown> }) {
  const [value, setValue] = useState('');
  const port = /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  const ok = Number.isInteger(port) && port >= 1 && port <= 65535;
  const submit = async () => {
    if (!ok) return;
    const r = await onSubmit(port);
    if (r) setValue('');
  };
  return (
    <div className="card hero" style={{ marginBottom: 0 }}>
      <div className="hero-row">
        <div className="search-field">
          <Icon name="plug" size={18} />
          <input
            className="input"
            placeholder={placeholder}
            inputMode="numeric"
            value={value}
            disabled={disabled}
            onChange={(e) => setValue(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </div>
        <button className="btn primary" disabled={disabled || !ok} onClick={submit}>
          {button}
        </button>
      </div>
    </div>
  );
}

function PortLabel({ p }: { p: PortItem }) {
  const loopback = p.address.startsWith('127.') || p.address === 'localhost';
  const any = !p.address || p.address === '0.0.0.0' || p.address === '*';
  return (
    <span className="row" style={{ gap: 14, minWidth: 0 }}>
      <span className="port-num">{p.port}</span>
      <span className="col" style={{ gap: 0, minWidth: 0 }}>
        <span className="ellipsis">{p.process || '系统进程'}</span>
        <span className="tiny faint ellipsis">
          {p.project ? `${p.project} · ` : ''}
          {loopback ? '只听本机' : any ? '所有地址' : p.address}
        </span>
      </span>
    </span>
  );
}

function ForwardRow({ f, item, known }: { f: Forward; item?: PortItem; known: boolean }) {
  const { run } = useApp();
  const [level, text] = STATE[f.state];
  const idle = f.state === 'open' && known && !item;
  return (
    <Item
      label={
        <span className="row" style={{ gap: 14, minWidth: 0 }}>
          <span className="port-num">{f.vmPort}</span>
          <span className="col" style={{ gap: 0, minWidth: 0 }}>
            <span className="ellipsis">{item?.process || (idle ? '没有服务在听' : 'VM')}{item?.project ? ` · ${item.project}` : ''}</span>
            <span className="tiny faint mono">localhost:{f.macPort}</span>
          </span>
        </span>
      }
    >
      <span title={f.error}>
        <Badge level={idle ? 'idle' : level}>{f.state === 'retrying' && f.error ? f.error : text}</Badge>
      </span>
      <button className="btn sm" disabled={f.state !== 'open'} onClick={() => run(() => act('openForward', f.macPort))}>
        <Icon name="external" size={13} />
        打开
      </button>
      <button className="icon-btn plain" title="停止转发" onClick={() => run(() => act('removeForward', f.vmPort))}>
        <Icon name="x" size={14} />
      </button>
    </Item>
  );
}

function AddForward({ disabled }: { disabled: boolean }) {
  const { run } = useApp();
  const [vm, setVm] = useState('');
  const [mac, setMac] = useState('');
  const num = (s: string) => (/^\d{1,5}$/.test(s) ? Number(s) : NaN);
  const ok = Number.isInteger(num(vm)) && (mac === '' || Number.isInteger(num(mac)));
  const submit = async () => {
    if (!ok) return;
    const r = await run(() => act('addForward', num(vm), mac === '' ? undefined : num(mac)));
    if (r) {
      setVm('');
      setMac('');
    }
  };
  return (
    <div className="card hero" style={{ marginBottom: 0 }}>
      <div className="hero-row">
        <div className="search-field">
          <Icon name="plug" size={18} />
          <input
            className="input"
            placeholder="VM 端口，例如 3000"
            inputMode="numeric"
            value={vm}
            disabled={disabled}
            onChange={(e) => setVm(e.target.value.replace(/\D/g, '').slice(0, 5))}
            onKeyDown={(e) => e.key === 'Enter' && void submit()}
          />
        </div>
        <input
          className="input port-mac"
          placeholder="Mac 端口（默认相同）"
          inputMode="numeric"
          value={mac}
          disabled={disabled}
          onChange={(e) => setMac(e.target.value.replace(/\D/g, '').slice(0, 5))}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        <button className="btn primary" disabled={disabled || !ok} onClick={submit}>
          转发
        </button>
      </div>
    </div>
  );
}
