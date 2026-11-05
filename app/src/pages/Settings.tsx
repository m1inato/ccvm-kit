// 设置：网络出口 / VM / 检查与提醒 / 共享文件夹 / Mac 执行 / 通用。
import { useEffect, useState } from 'react';
import { latestChecks } from '../../core/checks';
import { relativeTime } from '../../core/status';
import type { CliStatus, Settings } from '../../core/types';
import { act, errorText, useApp } from '../api';
import { Dot, gib, Toggle } from '../components/common';
import { CoreDetails, CoreSetup, CoreStatusLine } from '../components/EgressCore';

const TABS: [string, string][] = [
  ['egress', '网络出口'],
  ['vm', 'VM'],
  ['checks', '检查与提醒'],
  ['shares', '共享文件夹'],
  ['exec', 'Mac 执行'],
  ['general', '通用'],
];

export function SettingsPage({ tab }: { tab: string }) {
  const { go } = useApp();
  return (
    <>
      <nav className="sidebar">
        <div className="tiny faint" style={{ padding: '0 10px 6px' }}>
          设置
        </div>
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
        {tab === 'exec' && <Exec />}
        {tab === 'general' && <General />}
      </main>
    </>
  );
}

function useSave() {
  const { run } = useApp();
  return (patch: Partial<Settings>, ok?: string) => run(() => act('updateSettings', patch), ok);
}

function Egress() {
  const { snap, run } = useApp();
  const mode = snap.settings.egressMode;
  const choose = (m: Settings['egressMode']) => {
    if (m !== mode) void run(() => act('setEgressMode', m));
  };
  return (
    <div className="settings-section">
      <div>
        <h1>网络出口</h1>
        <p className="small muted">VM 只认 Mac 上的 127.0.0.1:17897，不关心对面是谁。两种方式对 VM 完全一样；切换后会自动检查一遍。</p>
      </div>
      <div className="row" style={{ alignItems: 'stretch' }}>
        <div className={`card radio-card grow ${mode === 'builtin' ? 'selected' : ''}`} onClick={() => choose('builtin')}>
          <span className={`radio ${mode === 'builtin' ? 'on' : ''}`} />
          <div className="col" style={{ gap: 2 }}>
            <b>CCVM 自带核心</b>
            <span className="small muted">贴订阅链接、选一个节点。和日常 Clash Verge 完全独立：它怎么切模式、开不开虚拟网卡、关没关，都不影响 VM。</span>
            <span className="chip accent" style={{ alignSelf: 'flex-start' }}>推荐</span>
          </div>
        </div>
        <div className={`card radio-card grow ${mode === 'clash-verge' ? 'selected' : ''}`} onClick={() => choose('clash-verge')}>
          <span className={`radio ${mode === 'clash-verge' ? 'on' : ''}`} />
          <div className="col" style={{ gap: 2 }}>
            <b>使用我的 Clash Verge</b>
            <span className="small muted">扩展脚本加一个专用入口，固定走选定节点，优先于规则 / 全局 / 直连模式。Clash Verge 关了 VM 就断网。</span>
          </div>
        </div>
      </div>
      {mode === 'builtin' ? (
        <>
          <CoreStatusLine snap={snap} />
          <CoreSetup snap={snap} />
          <CoreDetails snap={snap} />
          <LatencyUrl />
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
  const [preview, setPreview] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const quick = snap.lastQuick;
  const listener = quick ? latestChecks(quick.checks).get('listener.loopback_only') : undefined;

  useEffect(() => {
    if (!node.trim()) return setPreview(null);
    void act('clashScript', node).then((r) => {
      if (r.ok && r.script) {
        const lines = r.script.split('\n');
        const i = lines.findIndex((l) => l.startsWith('const NODE'));
        setPreview(`${lines[i]}\n// …其余 ${lines.length - 1} 行与 config/clash-verge-script.js 相同`);
        setErr(null);
      } else {
        setPreview(null);
        setErr(r.error ?? null);
      }
    });
  }, [node]);

  const copy = async () => {
    const r = await run(() => act('clashScript', node));
    if (!r?.ok || !r.script) return setErr(r?.error ?? '生成失败');
    await save({ nodeName: node.trim() });
    await run(() => act('copyText', r.script!), '已复制扩展脚本：到 Clash Verge 粘贴并保存');
  };

  return (
    <>
      <div className="card pad row small">
        <Dot level={listener ? (listener.ok ? 'ok' : 'error') : 'idle'} />
        <span className="grow">
          Clash Verge 专用入口 127.0.0.1:17897 · {listener ? (listener.ok ? '只听回环' : listener.msg) : '还没检查'}
        </span>
        <span className="muted">
          {snap.egress.host ? `出口 ${snap.egress.host} · ` : ''}
          {quick ? `${relativeTime(quick.at, now)}检查${quick.ok ? '通过' : '未通过'}` : ''}
        </span>
      </div>

      <div className="card pad col">
        <h2>扩展脚本</h2>
        <div className="field">
          <label>节点（和 Clash Verge 里显示的一致）</label>
          <input className="input" value={node} onChange={(e) => setNode(e.target.value)} placeholder="例如：示例节点 · 东京 01" />
        </div>
        <div className="row">
          <span className="small muted grow">在 Clash Verge 的订阅卡片上右键 → 扩展脚本，粘贴，保存，再重新激活订阅。</span>
          <button className="btn primary" disabled={!node.trim()} onClick={copy}>
            复制脚本
          </button>
        </div>
        {err && <span className="small err-text">{err}</span>}
        {preview && <div className="code">{preview}</div>}
        <p className="tiny faint">换节点等于换出口：保存脚本后检查会发现出口变了，核实后在首页点「就用新的出口」更新基线。App 不会悄悄换节点，也不写 Clash Verge 的配置文件。</p>
      </div>

      <VergeController />
      <div className="callout warn">这个方式下，Clash Verge 关闭时 VM 会断网（不会改走直连）。</div>
    </>
  );
}

/** Clash Verge 外部控制器（可选）：只读连接列表。密钥存钥匙串，界面上只显示「已设置」 */
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
      setResult({ ok: true, text: `连上了：Clash 内核 ${v.version}` });
    } catch (err) {
      setResult({ ok: false, text: errorText(err) });
    }
  };
  return (
    <div className="card pad col">
      <div className="row">
        <h2 className="grow">控制接口（可选）</h2>
        <span className={`status ${cc.address ? 'ok' : 'idle'}`}>
          <Dot level={cc.address ? 'ok' : 'idle'} />
          {cc.address ? `已填 ${cc.address}` : '未连接'}
        </span>
      </div>
      <p className="small muted">
        填上 Clash Verge 的外部控制器后，项目页「连接」会列出来自 VM 的连接，并核对每条是不是只经过 CC-VM-FIXED 和你的节点。App 只读（只发 GET），不改 Clash Verge 的任何设置。
        Clash Verge Rev 2.5.10 默认关闭外部控制器：在它的设置里打开、设一个密钥，再填到这里。
      </p>
      <div className="row">
        <span className="small" style={{ width: 48 }}>地址</span>
        <input className="input mono grow" value={address} onChange={(e) => setAddress(e.target.value)} placeholder="127.0.0.1:9097" spellCheck={false} />
      </div>
      <div className="row">
        <span className="small" style={{ width: 48 }}>密钥</span>
        <input
          className="input mono grow"
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={cc.secretSet ? '已设置（不显示）；要换就重新填' : '外部控制器的密钥'}
          autoComplete="off"
        />
      </div>
      <div className="row wrap">
        <button className="btn sm primary" onClick={() => void save()}>
          保存
        </button>
        <button className="btn sm" disabled={!cc.address} onClick={() => void test()}>
          测试连接
        </button>
        {cc.secretSet && (
          <button className="btn sm ghost" onClick={() => run(() => act('setClashController', { address: cc.address, secret: null }), '已清除密钥')}>
            清除密钥
          </button>
        )}
        {cc.address && (
          <button className="btn sm ghost" onClick={() => run(() => act('setClashController', { address: '', secret: null }), '已停用')}>
            停用
          </button>
        )}
      </div>
      {result && <p className={`small ${result.ok ? 'ok-text' : 'err-text'}`}>{result.text}</p>}
      <span className="tiny faint">只接受 127.0.0.1:端口 或 localhost:端口。密钥只存在钥匙串里，不写日志、不进导出的验收记录。VM 连不到这个端口（完整验收的 bypass.mac_port_9097 / 9090 一直在核对）。</span>
    </div>
  );
}

function Vm() {
  const { snap, run } = useApp();
  const save = useSave();
  const [name, setName] = useState(snap.settings.vmName);
  const [home, setHome] = useState(snap.settings.limaHome);
  const vm = snap.vm;
  const dirty = name !== snap.settings.vmName || home !== snap.settings.limaHome;
  return (
    <div className="settings-section">
      <div>
        <h1>VM</h1>
        <p className="small muted">App 只调用 limactl（start / stop / list / shell），永远带专用 LIMA_HOME；不写 Lima 目录，不提供共享文件夹和端口转发。</p>
      </div>
      <div className="card pad col">
        <div className="kv">
          <span>状态</span>
          <span>{vm.status}</span>
          <span>资源</span>
          <span>
            {vm.cpus ?? '?'} vCPU · {gib(vm.memoryBytes)} 内存 · {gib(vm.diskBytes)} 磁盘
          </span>
          <span>系统</span>
          <span>Ubuntu 24.04 ARM64 · {vm.arch ?? 'aarch64'}</span>
        </div>
        <p className="tiny faint">调整 CPU、内存：停机后按 Lima 文档修改实例配置，再跑一次完整验收。App 不改 Lima 目录。</p>
      </div>
      <div className="card pad col">
        <div className="field">
          <label>实例名</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>专用 Lima 目录（LIMA_HOME）</label>
          <input className="input mono" value={home} onChange={(e) => setHome(e.target.value)} />
        </div>
        <div className="field">
          <label>状态目录（出口基线 expected-ip.txt 所在）</label>
          <div className="row">
            <input className="input mono grow" value={snap.settings.stateDir} readOnly />
            <button className="btn" onClick={() => run(() => act('chooseStateDir'))}>
              选择…
            </button>
          </div>
          <span className="tiny faint">可以选命令行套件的 state 目录，让 App 和脚本共用同一份基线。更换实例名或目录不会迁移 VM。</span>
        </div>
        <div className="row">
          <span className="spacer" />
          <button className="btn primary" disabled={!dirty} onClick={() => save({ vmName: name.trim(), limaHome: home.trim() }, '已保存，正在重新检查')}>
            保存
          </button>
        </div>
      </div>
      <div className="card pad row">
        <div className="grow">
          <b>管理员 shell</b>
          <p className="small muted">有 sudo，只用于系统维护。不要在这里运行 Claude。</p>
        </div>
        <button className="btn danger" disabled={vm.status !== 'Running'} onClick={() => run(() => act('openAdminShell'))}>
          打开管理员 shell
        </button>
      </div>
    </div>
  );
}

function Checks() {
  const { snap, run } = useApp();
  const save = useSave();
  return (
    <div className="settings-section">
      <div>
        <h1>检查与提醒</h1>
        <p className="small muted">只有「出错」会主动打扰你：系统通知一次、胶囊字幕、首页提示卡。同一个问题只通知一次，恢复后再发生才再通知。</p>
      </div>
      <div className="card pad">
        <div className="setting-row">
          <span className="grow">快速检查间隔</span>
          <select className="input" value={snap.settings.checkIntervalMin} onChange={(e) => save({ checkIntervalMin: Number(e.target.value) })}>
            {[5, 10, 15, 30, 60].map((m) => (
              <option key={m} value={m}>
                每 {m} 分钟
              </option>
            ))}
          </select>
        </div>
        <div className="setting-row">
          <span className="grow">
            显示桌面胶囊
            <div className="tiny faint">平时只占一条；做完或出问题时弹一句字幕</div>
          </span>
          <Toggle checked={snap.settings.showCapsule} onChange={(v) => save({ showCapsule: v })} />
        </div>
        <div className="setting-row">
          <span className="grow">
            「Claude 做完了」提醒
            <div className="tiny faint">
              在 VM 里装一个 Claude Code hook（root 所有的 managed-settings，Claude 改不了）。只记录事件类型、时间、工作目录和截断的通知文字，不记对话内容；同一项目 5 分钟内只弹一次字幕。和网络隔离无关。
            </div>
          </span>
          <Toggle
            checked={snap.settings.hooksEnabled}
            disabled={snap.vm.status !== 'Running'}
            onChange={(v) => void run(() => act('setHooks', v), v ? '已开启：新开的 Claude 会话生效' : '已关闭')}
          />
        </div>
      </div>
      <div className="callout small">
        Mac 唤醒、切换网络后会立即检查。检查结果超过 2.5 个间隔没有更新时，状态变灰，不会继续显示「受保护」。
      </div>
    </div>
  );
}

function Exec() {
  return (
    <div className="settings-section">
      <div>
        <h1>Mac 执行</h1>
        <p className="small muted">让 Claude 在 Mac 上跑 Xcode 构建等命令（每条都要你批准）。这是 M5，还没有实现。</p>
      </div>
      <div className="callout warn">
        设计里还有一个未解决的问题：被批准的命令（例如 xcodebuild test）会运行 VM 里写出的代码，而专用账户 ccvm-bot 在 Mac 上的网络不受限，可以绕过固定节点直接出网，也能连到 Mac 本机的 7897、9090 等端口。补上之前不会启用这个功能，详见设计方案。
      </div>
    </div>
  );
}

/** 测延迟的地址：和 Clash Verge 用同一个才对得上数字 */
function LatencyUrl() {
  const { snap } = useApp();
  const save = useSave();
  const [url, setUrl] = useState(snap.settings.latencyTestUrl);
  const dirty = url.trim() !== snap.settings.latencyTestUrl;
  return (
    <div className="card pad col">
      <h2>测延迟</h2>
      <div className="row">
        <input className="input grow mono" value={url} onChange={(e) => setUrl(e.target.value)} spellCheck={false} />
        <button className="btn sm" disabled={!dirty} onClick={() => save({ latencyTestUrl: url.trim() }, '已保存测试地址')}>
          保存
        </button>
      </div>
      <span className="tiny faint">
        想和 Clash Verge 的数字对得上，就填它设置里的同一个测试地址。只接受 http:// 或 https://，不能带账号密码。
        测的时候开着「统一延迟」（不计建连和握手），每个节点先热身一次再取第二次的结果，超时 5 秒。
      </span>
    </div>
  );
}

/** 共享文件夹（读写）：设计降级，见 docs/desktop-app.md。改动都要「应用并重启 VM」才生效 */
function Shares() {
  const { snap, run, go } = useApp();
  const s = snap.settings;
  const sh = snap.shares;
  const busy = snap.jobs.find((j) => j.state === 'running' && j.kind === 'shares');
  const appliedOf = (p: string) => sh.applied.find((a) => a.path === p);
  const view = (p: string) => appliedOf(p)?.view;
  return (
    <div className="settings-section">
      <div>
        <h1>共享文件夹</h1>
        <p className="small muted">
          让 VM 读写你在 Mac 上选定的具体文件夹。VM 里在 <code>/home/cc/mac/&lt;名字&gt;</code>。网络隔离不变，状态仍然是「受保护」，顶栏会常驻「共享 N 个文件夹 · 读写」。
        </p>
      </div>
      <div className="callout warn col" style={{ gap: 6 }}>
        <b>共享是读写的，这会削弱隔离</b>
        <span>· VM 里的程序（包括 Claude）可以修改这些文件夹里的任何文件，包括脚本、<code>.git/hooks</code>、<code>package.json</code> 里的 scripts。之后在 Mac 上运行它们，就等于以你的权限执行。</span>
        <span>· 这些文件夹的内容可以经固定出口发出去。</span>
        <span>· 家目录本身、<code>~/Library</code>、<code>~/.ssh</code> 这类敏感位置，以及 CCVM 自己的目录，不能共享。</span>
        <span>· 应用时会重启 VM，正在运行的 tmux 会话（包括 Claude）会被中断。</span>
      </div>
      <div className="card pad">
        <div className="setting-row">
          <span className="grow">允许 VM 访问共享文件夹</span>
          <Toggle checked={s.sharesEnabled} onChange={(v) => run(() => act('setSharesEnabled', v))} />
        </div>
        {s.sharedFolders.length === 0 && <p className="small muted" style={{ padding: '10px 0' }}>还没有选文件夹。</p>}
        {s.sharedFolders.map((p) => (
          <div className="setting-row" key={p} style={{ alignItems: 'flex-start' }}>
            <div className="grow col" style={{ gap: 2 }}>
              <span className="mono" style={{ wordBreak: 'break-all' }}>{p}</span>
              {sh.problems[p] ? (
                <span className="tiny err-text">不能共享：{sh.problems[p]}</span>
              ) : appliedOf(p)?.mounted === false ? (
                <span className="tiny err-text">VM 里没有挂上：{view(p)} 现在是空的。点「重新应用」再试一次</span>
              ) : view(p) ? (
                <span className="tiny muted">VM 里：<code>{view(p)}</code></span>
              ) : (
                <span className="tiny muted">还没应用</span>
              )}
            </div>
            <button className="btn sm ghost" onClick={() => run(() => act('removeSharedFolder', p))}>
              移除
            </button>
          </div>
        ))}
        <div className="row" style={{ paddingTop: 10 }}>
          <button className="btn sm" onClick={() => run(() => act('addSharedFolder'))}>
            添加文件夹…
          </button>
          <span className="spacer" />
          {sh.pendingApply && <span className="tiny" style={{ color: 'var(--warn)' }}>有改动还没应用</span>}
          {sh.needsRetry && <span className="tiny err-text">上次没有应用好，或者有文件夹在 VM 里没挂上</span>}
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
      </div>
      {sh.applied.length > 0 && (
        <p className="tiny faint">
          当前已应用：{sh.applied.map((a) => `${a.path} → ${a.view}`).join('；')}
        </p>
      )}
    </div>
  );
}

/** 命令行入口 ccvm：任意终端里 Cmd+T 后输入 ccvm 就能进 VM */
function CliRow() {
  const { run } = useApp();
  const [st, setSt] = useState<CliStatus | null>(null);
  useEffect(() => {
    void run(() => act('cliStatus')).then((s) => s && setSt(s));
  }, [run]);
  const install = async () => {
    const s = await run(() => act('installCli'), '已生成 ccvm');
    if (s) setSt(s);
  };
  return (
    <div className="setting-row" style={{ alignItems: 'flex-start' }}>
      <div className="grow col" style={{ gap: 4 }}>
        <span>
          命令行入口 <code>ccvm</code>
        </span>
        <span className="tiny muted">
          在任意终端里：<code>ccvm</code> 进入 cc，<code>ccvm 项目</code> 新建会话，<code>ccvm -a 会话</code> 接回会话。都会先经过检查。
        </span>
        {st?.installed && !st.generated && <span className="tiny err-text">{st.path} 已存在，而且不是 CCVM 生成的，App 不会覆盖它。</span>}
        {st?.generated && <span className="tiny muted">已安装：{st.path}（设置变了会自动更新）</span>}
        {st?.generated && !st.onPath && (
          <span className="tiny">
            <code>~/.local/bin</code> 不在 PATH 里。把这一行加到 <code>~/.zshrc</code>：<code className="mono">{st.hint}</code>{' '}
            <a onClick={() => run(() => act('copyText', st.hint), '已复制')}>复制</a>
          </span>
        )}
      </div>
      <button className="btn sm" disabled={!!st?.installed && !st.generated} onClick={() => void install()}>
        {st?.generated ? '重新生成' : '安装命令行入口 ccvm'}
      </button>
    </div>
  );
}

function General() {
  const { snap, go, run } = useApp();
  const save = useSave();
  return (
    <div className="settings-section">
      <h1>通用</h1>
      <div className="card pad">
        <div className="setting-row">
          <span className="grow">登录时启动</span>
          <Toggle checked={snap.settings.launchAtLogin} onChange={(v) => save({ launchAtLogin: v })} />
        </div>
        <div className="setting-row">
          <span className="grow">用哪个终端打开 cc</span>
          <select className="input" value={snap.settings.terminalApp} onChange={(e) => save({ terminalApp: e.target.value as Settings['terminalApp'] })}>
            <option value="Terminal">终端（Terminal）</option>
            <option value="iTerm">iTerm</option>
            <option value="Ghostty">Ghostty（1.3.0 或更新）</option>
          </select>
        </div>
        {snap.settings.terminalApp === 'Ghostty' && (
          <p className="tiny muted" style={{ padding: '0 0 10px' }}>
            经 AppleScript 让 Ghostty 新开窗口。第一次会弹出「自动化」权限请求：允许 CCVM 控制 Ghostty。
          </p>
        )}
        <CliRow />
        <div className="setting-row">
          <span className="grow">外观</span>
          <select className="input" value={snap.settings.theme} onChange={(e) => save({ theme: e.target.value as Settings['theme'] })}>
            <option value="system">跟随系统</option>
            <option value="dark">深色</option>
            <option value="light">浅色</option>
          </select>
        </div>
        <div className="setting-row">
          <span className="grow">验收记录</span>
          <button className="btn sm" onClick={() => run(() => act('exportReport'))}>
            导出为 Markdown
          </button>
        </div>
        <div className="setting-row">
          <span className="grow">欢迎页</span>
          <button className="btn sm" onClick={() => go('/welcome')}>
            重新打开
          </button>
        </div>
      </div>
      <p className="tiny faint">
        App {snap.appVersion} · 套件 {snap.kitVersion}
        {snap.kitBuild
          ? ` · 提交 ${snap.kitBuild.commit}${snap.kitBuild.dirty ? '（构建时有未提交的改动）' : ''} · 构建于 ${snap.kitBuild.built.slice(0, 16).replace('T', ' ')}`
          : ' · 从源码运行'}
      </p>
    </div>
  );
}
