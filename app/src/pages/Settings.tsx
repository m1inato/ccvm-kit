// 设置：VM / 提醒 / 共享文件夹 / 通用。网络出口在「网络」页。
import { useEffect, useState } from 'react';
import type { CliStatus, Settings } from '../../core/types';
import { act, useApp } from '../api';
import { Badge, gib, Item, PageTitle, Section, Segmented, Toggle } from '../components/common';

type Tab = 'vm' | 'alerts' | 'shares' | 'general';
const TABS: [Tab, string][] = [
  ['vm', 'VM'],
  ['alerts', '检查与提醒'],
  ['shares', '共享文件夹'],
  ['general', '通用'],
];

export function SettingsPage({ tab }: { tab: string }) {
  const { go } = useApp();
  const current = (TABS.some(([id]) => id === tab) ? tab : 'vm') as Tab;
  return (
    <div className="main-scroll narrow">
      <PageTitle title="设置" />
      <div style={{ marginBottom: 26 }}>
        <Segmented value={current} options={TABS} onChange={(t) => go(`/settings/${t}`)} />
      </div>
      {current === 'vm' && <Vm />}
      {current === 'alerts' && <Alerts />}
      {current === 'shares' && <Shares />}
      {current === 'general' && <General />}
    </div>
  );
}

function useSave() {
  const { run } = useApp();
  return (patch: Partial<Settings>, ok?: string) => run(() => act('updateSettings', patch), ok);
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

      <Section title="位置" hint="更换实例名或目录不会迁移 VM。状态目录可以选命令行套件的 state，让 App 和脚本共用共享文件夹设置。">
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
function Alerts() {
  const { snap, run } = useApp();
  const save = useSave();
  return (
    <div className="page">
      <Section title="检查" hint="Mac 唤醒、切换网络后会立即检查；代理断开时每 30 秒查一次，恢复了马上变绿。">
        <Item label="检查间隔">
          <select className="input" value={snap.settings.checkIntervalMin} onChange={(e) => save({ checkIntervalMin: Number(e.target.value) })}>
            {[1, 3, 5, 10, 30].map((m) => (
              <option key={m} value={m}>
                每 {m} 分钟
              </option>
            ))}
          </select>
        </Item>
      </Section>
      <Section title="提醒">
        <Item label="桌面胶囊">
          <Toggle checked={snap.settings.showCapsule} onChange={(v) => save({ showCapsule: v })} />
        </Item>
        <Item label="Claude 做完了" hint="在 VM 里装一个 hook，只记事件类型、时间和工作目录，不记对话内容。同一项目 5 分钟内只提醒一次。">
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
      <Section>
        <Item label="允许 VM 访问共享文件夹" hint="VM 可以读写这些文件夹，包括脚本和 .git/hooks。">
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
      <Item label={<>命令行 <code>ccvm</code></>} hint="任意终端里：ccvm 进入 cc，ccvm <项目> 新建会话，ccvm -a <会话> 接回。">
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
  const { snap, go } = useApp();
  const save = useSave();
  const build = snap.kitBuild;
  return (
    <div className="page">
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
