// 设置：网络出口 / VM / 检查与提醒 / 共享文件夹 / 通用。
import { useEffect, useState } from 'react';
import { latestChecks } from '../../core/checks';
import { relativeTime } from '../../core/status';
import type { CliStatus, Settings } from '../../core/types';
import { act, errorText, useApp } from '../api';
import { Badge, gib, Item, Section, Segmented, Toggle } from '../components/common';
import { CoreDetails, CoreSetup, CoreStatusLine } from '../components/EgressCore';

const TABS: [string, string][] = [
  ['egress', '网络出口'],
  ['vm', 'VM'],
  ['checks', '检查与提醒'],
  ['shares', '共享文件夹'],
  ['general', '通用'],
];

export function SettingsPage({ tab }: { tab: string }) {
  const { go } = useApp();
  return (
    <>
      <nav className="sidebar">
        {TABS.map(([id, label]) => (
          <button key={id} className={`nav-item ${tab === id ? 'active' : ''}`} onClick={() => go(`/settings/${id}`)}>
            {label}
          </button>
        ))}
      </nav>
      <main className="main">
        {tab === 'egress' && <Egress />}
        {tab === 'vm' && <Vm />}
        {tab === 'checks' && <Checks />}
        {tab === 'shares' && <Shares />}
        {tab === 'general' && <General />}
      </main>
    </>
  );
}

function useSave() {
  const { run } = useApp();
  return (patch: Partial<Settings>, ok?: string) => run(() => act('updateSettings', patch), ok);
}

// ---------------------------------------------------------------- 网络出口
function Egress() {
  const { snap, run } = useApp();
  const mode = snap.settings.egressMode;
  return (
    <div className="page">
      <h1>网络出口</h1>
      <Section title="出网方式" hint="VM 只连 Mac 上的 127.0.0.1:17897。两种方式对 VM 一样，切换时会短暂断网，之后自动检查。">
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
          <CoreStatusLine snap={snap} />
          <CoreSetup snap={snap} />
          <CoreDetails snap={snap} />
        </>
      ) : (
        <ClashVergeEgress />
      )}
    </div>
  );
}

function ClashVergeEgress() {
  const { snap, now, run } = useApp();
  const save = useSave();
  const [node, setNode] = useState(snap.settings.nodeName);
  const [err, setErr] = useState<string | null>(null);
  const quick = snap.lastQuick;
  const listener = quick ? latestChecks(quick.checks).get('listener.loopback_only') : undefined;

  const copy = async () => {
    const r = await run(() => act('clashScript', node));
    if (!r?.ok || !r.script) return setErr(r?.error ?? '生成失败');
    setErr(null);
    await save({ nodeName: node.trim() });
    await run(() => act('copyText', r.script!), '已复制扩展脚本');
  };

  return (
    <>
      <Section title="状态">
        <Item label="专用入口">
          <Badge level={listener ? (listener.ok ? 'ok' : 'error') : 'idle'}>{listener ? (listener.ok ? '只听回环' : listener.msg) : '还没检查'}</Badge>
        </Item>
        <Item
          label="出口"
          value={
            <>
              <span className="mono">{snap.egress.host ?? '—'}</span>
              {quick ? ` · ${relativeTime(quick.at, now)}${quick.ok ? '检查通过' : '检查未通过'}` : ''}
            </>
          }
        />
      </Section>

      <Section title="扩展脚本" hint="在 Clash Verge 的订阅卡片上右键 → 扩展脚本，粘贴并保存，再重新激活订阅。换节点等于换出口，核实后在首页更新基线。">
        <Item label="节点">
          <input className="input" style={{ width: 300 }} value={node} onChange={(e) => setNode(e.target.value)} placeholder="和 Clash Verge 里显示的一致" />
          <button className="btn sm primary" disabled={!node.trim()} onClick={copy}>
            复制脚本
          </button>
        </Item>
        {err && <Item label={<span className="small err-text">{err}</span>} />}
      </Section>

      <VergeController />
    </>
  );
}

/** Clash Verge 外部控制器（可选）：「连接」面板只读它 */
function VergeController() {
  const { snap, run } = useApp();
  const cc = snap.clashController;
  const [address, setAddress] = useState(cc.address || '127.0.0.1:9097');
  const [secret, setSecret] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async () => {
    const ok = await run(() => act('setClashController', { address: address.trim(), ...(secret ? { secret } : {}) }), '已保存');
    if (ok) setSecret('');
  };
  const test = async () => {
    setResult(null);
    try {
      const v = await act('testClashController');
      setResult({ ok: true, text: `已连接 · ${v.version}` });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
  };
  return (
    <Section
      title="外部控制器"
      hint="可选。填上后，项目页「连接」会列出来自 VM 的连接并核对链路。只读，只连本机。Clash Verge 默认没开，要在它的设置里打开并设一个密钥。"
    >
      <Item label="地址">
        <input className="input mono" style={{ width: 220 }} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="127.0.0.1:9097" spellCheck={false} />
      </Item>
      <Item label="密钥">
        <input
          className="input mono"
          style={{ width: 220 }}
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={cc.secretSet ? '已设置' : ''}
          autoComplete="off"
        />
      </Item>
      <div className="item foot">
        {result && <span className={`note ${result.ok ? 'ok-text' : 'err-text'}`}>{result.text}</span>}
        {cc.address && (
          <button className="btn sm ghost" onClick={() => run(() => act('setClashController', { address: '', secret: null }), '已停用')}>
            停用
          </button>
        )}
        <button className="btn sm" disabled={!cc.address} onClick={() => void test()}>
          测试连接
        </button>
        <button className="btn sm primary" onClick={() => void save()}>
          保存
        </button>
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- VM
function Vm() {
  const { snap, run, go } = useApp();
  const save = useSave();
  const [name, setName] = useState(snap.settings.vmName);
  const [home, setHome] = useState(snap.settings.limaHome);
  const vm = snap.vm;
  const pkg = snap.vmPackages;
  const dirty = name !== snap.settings.vmName || home !== snap.settings.limaHome;
  const running = vm.status === 'Running';
  return (
    <div className="page">
      <h1>VM</h1>
      <Section title="这台 VM">
        <Item label="状态">
          <Badge level={running ? 'ok' : 'idle'}>{running ? '运行中' : vm.status}</Badge>
        </Item>
        <Item label="资源" value={`${vm.cpus ?? '?'} vCPU · ${gib(vm.memoryBytes)} 内存 · ${gib(vm.diskBytes)} 磁盘`} />
        <Item label="系统" value={`Ubuntu 24.04 · ${vm.arch ?? 'aarch64'}`} />
        {pkg.level !== undefined && (
          <Item label="版本" value={pkg.needsUpgrade ? `${pkg.level} → ${pkg.target}` : `${pkg.level}`}>
            {pkg.needsUpgrade && (
              <button className="btn sm primary" onClick={() => run(async () => { const id = await act('vmUpgrade'); if (id) go(`/jobs/${id}`); })}>
                更新 VM
              </button>
            )}
          </Item>
        )}
      </Section>

      <Section title="位置" hint="更换实例名或目录不会迁移 VM。状态目录可以选命令行套件的 state，让 App 和脚本共用一份出口基线。">
        <Item label="实例名">
          <input className="input" style={{ width: 280 }} value={name} onChange={(e) => setName(e.target.value)} />
        </Item>
        <Item label="Lima 目录">
          <input className="input mono" style={{ width: 280 }} value={home} onChange={(e) => setHome(e.target.value)} />
        </Item>
        <Item label="状态目录" value={<span className="mono ellipsis" style={{ maxWidth: 260, display: 'inline-block' }}>{snap.settings.stateDir}</span>}>
          <button className="btn sm" onClick={() => run(() => act('chooseStateDir'))}>
            选择…
          </button>
        </Item>
        {dirty && (
          <div className="item foot">
            <button className="btn sm primary" onClick={() => save({ vmName: name.trim(), limaHome: home.trim() }, '已保存')}>
              保存
            </button>
          </div>
        )}
      </Section>

      <Section title="维护">
        <Item label="管理员 shell" hint="有 sudo，只用于系统维护。不要在这里运行 Claude。">
          <button className="btn sm danger" disabled={!running} onClick={() => run(() => act('openAdminShell'))}>
            打开
          </button>
        </Item>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- 检查与提醒
function Checks() {
  const { snap, run } = useApp();
  const save = useSave();
  return (
    <div className="page">
      <h1>检查与提醒</h1>
      <Section title="检查" hint="Mac 唤醒、切换网络后会立即检查。结论超过 2.5 个间隔没有更新时，状态变灰。">
        <Item label="快速检查">
          <select className="input" value={snap.settings.checkIntervalMin} onChange={(e) => save({ checkIntervalMin: Number(e.target.value) })}>
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                每 {m} 分钟
              </option>
            ))}
          </select>
        </Item>
      </Section>
      <Section title="提醒" hint="只有出错会主动打扰你：系统通知一次，同一个问题恢复前不再通知。">
        <Item label="桌面胶囊">
          <Toggle checked={snap.settings.showCapsule} onChange={(v) => save({ showCapsule: v })} />
        </Item>
        <Item label="Claude 做完了" hint="在 VM 里装一个 Claude 改不了的 hook，只记事件类型、时间和工作目录，不记对话内容。同一项目 5 分钟内只提醒一次。">
          <Toggle
            checked={snap.settings.hooksEnabled}
            disabled={snap.vm.status !== 'Running'}
            onChange={(v) => void run(() => act('setHooks', v), v ? '已开启，新开的 Claude 会话生效' : '已关闭')}
          />
        </Item>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- 共享文件夹
function Shares() {
  const { snap, run, go } = useApp();
  const s = snap.settings;
  const sh = snap.shares;
  const busy = snap.jobs.find((j) => j.state === 'running' && j.kind === 'shares');
  const applied = (p: string) => sh.applied.find((a) => a.path === p);
  const status = (p: string) => {
    if (sh.problems[p]) return <span className="badge error" title={sh.problems[p]}>不能共享</span>;
    const a = applied(p);
    if (!a) return <span className="badge warn">未应用</span>;
    if (a.mounted === false) return <Badge level="error">没挂上</Badge>;
    return <span className="value mono">{a.view}</span>;
  };
  const note = sh.needsRetry ? '上次没有应用好' : sh.pendingApply ? '有改动未应用' : '';
  return (
    <div className="page">
      <h1>共享文件夹</h1>
      <div className="callout warn">
        VM 可以读写这些文件夹，包括脚本和 <code>.git/hooks</code>；之后在 Mac 上运行它们，等于以你的权限执行。
      </div>
      <Section>
        <Item label="允许 VM 访问共享文件夹">
          <Toggle checked={s.sharesEnabled} onChange={(v) => run(() => act('setSharesEnabled', v))} />
        </Item>
      </Section>
      <Section
        title="文件夹"
        hint="VM 里在 /home/cc/mac/<名字>。家目录本身、~/Library、~/.ssh 等敏感位置和 CCVM 自己的目录不能共享。"
        aside={
          <button className="btn sm ghost" onClick={() => run(() => act('addSharedFolder'))}>
            添加…
          </button>
        }
      >
        {s.sharedFolders.length === 0 && <Item label={<span className="muted">没有共享的文件夹</span>} />}
        {s.sharedFolders.map((p) => (
          <Item key={p} label={<span className="mono ellipsis" title={p}>{p}</span>}>
            {status(p)}
            <button className="btn sm ghost" onClick={() => run(() => act('removeSharedFolder', p))}>
              移除
            </button>
          </Item>
        ))}
        <div className="item foot">
          {note && <span className="note">{note}</span>}
          <button
            className="btn sm primary"
            disabled={!(sh.pendingApply || sh.needsRetry) || !!busy || snap.vm.status === 'Missing'}
            onClick={() => run(async () => {
              const id = await act('applyShares');
              if (id) go(`/jobs/${id}`);
            })}
          >
            {busy ? '正在应用…' : sh.needsRetry ? '重新应用并重启 VM' : '应用并重启 VM'}
          </button>
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------- 通用
function CliItem() {
  const { run } = useApp();
  const [st, setSt] = useState<CliStatus | null>(null);
  useEffect(() => {
    void run(() => act('cliStatus')).then((s) => s && setSt(s));
  }, [run]);
  const install = async () => {
    const s = await run(() => act('installCli'), '已安装 ccvm');
    if (s) setSt(s);
  };
  const foreign = !!st?.installed && !st.generated;
  return (
    <>
      <Item label={<>命令行 <code>ccvm</code></>} hint="任意终端里：ccvm 进入 cc，ccvm <项目> 新建会话，ccvm -a <会话> 接回。都会先经过检查。">
        {foreign ? (
          <span className="badge error" title={`${st?.path} 不是 CCVM 生成的，不会覆盖`}>已有同名文件</span>
        ) : st?.generated ? (
          <span className="value">已安装</span>
        ) : (
          <button className="btn sm" onClick={() => void install()}>
            安装
          </button>
        )}
      </Item>
      {st?.generated && !st.onPath && (
        <Item label={<span className="small">把 <code>~/.local/bin</code> 加到 PATH（写进 ~/.zshrc）</span>}>
          <button className="btn sm ghost" onClick={() => run(() => act('copyText', st.hint), '已复制')}>
            复制命令
          </button>
        </Item>
      )}
    </>
  );
}

function General() {
  const { snap, go, run } = useApp();
  const save = useSave();
  const build = snap.kitBuild;
  return (
    <div className="page">
      <h1>通用</h1>
      <Section>
        <Item label="登录时启动">
          <Toggle checked={snap.settings.launchAtLogin} onChange={(v) => save({ launchAtLogin: v })} />
        </Item>
        <Item label="外观">
          <Segmented
            value={snap.settings.theme}
            options={[
              ['system', '自动'],
              ['light', '浅色'],
              ['dark', '深色'],
            ]}
            onChange={(v) => save({ theme: v })}
          />
        </Item>
      </Section>
      <Section title="终端">
        <Item label="外部终端" hint={snap.settings.terminalApp === 'Ghostty' ? 'Ghostty 需要 1.3.0 或更新；第一次会请求「自动化」权限。' : undefined}>
          <select className="input" value={snap.settings.terminalApp} onChange={(e) => save({ terminalApp: e.target.value as Settings['terminalApp'] })}>
            <option value="Terminal">终端</option>
            <option value="iTerm">iTerm</option>
            <option value="Ghostty">Ghostty</option>
          </select>
        </Item>
        <CliItem />
      </Section>
      <Section>
        <Item label="验收记录">
          <button className="btn sm" onClick={() => run(() => act('exportReport'))}>
            导出…
          </button>
        </Item>
        <Item label="欢迎页">
          <button className="btn sm" onClick={() => go('/welcome')}>
            打开
          </button>
        </Item>
      </Section>
      <p className="version">
        CCVM {snap.appVersion} · 套件 {snap.kitVersion}
        {build ? ` · ${build.commit}${build.dirty ? '+' : ''}` : ''}
      </p>
    </div>
  );
}
