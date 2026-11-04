// 欢迎页：3 步，每步自己检测、做完自动变绿；随时可以「以后再说」。
// 1 接上出口（M2 是 Clash Verge 模式；自带核心在 M3）→ 2 后台准备 VM → 3 在 VM 里装 Claude Code 并登录。
import { useEffect, useState } from 'react';
import { latestChecks } from '../../core/checks';
import type { CheckRecord, JobSummary, Snapshot } from '../../core/types';
import { act, usePoll, useApp } from '../api';
import { Dot, levelOf } from '../components/common';
import { CoreSetup } from '../components/EgressCore';

const INSTALL = 'curl -fsSL https://claude.ai/install.sh | bash -s stable';

export function WelcomePage({ step }: { step: number }) {
  const { go, run } = useApp();
  const later = () => run(async () => {
    await act('updateSettings', { welcomeDone: true });
    go('/');
  });
  return (
    <div className="welcome">
      <div className="welcome-card">
        <div className="stepper">
          {[1, 2, 3].map((n) => (
            <span key={n} className={n <= step ? 'on' : ''} />
          ))}
        </div>
        {step === 1 && <StepEgress onLater={later} />}
        {step === 2 && <StepVm onLater={later} />}
        {step === 3 && <StepClaude />}
      </div>
    </div>
  );
}

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="welcome-head">
      <div className="shield" />
      <h1>{title}</h1>
      <p className="muted small">{sub}</p>
    </div>
  );
}

function Detect({ rec, id, label, fallback }: { rec?: CheckRecord; id: string; label: string; fallback?: string }) {
  const c = rec ? latestChecks(rec.checks).get(id) : undefined;
  return (
    <div className="check-item">
      <Dot level={levelOf(c?.ok)} />
      <div className="grow">
        <div>{label}</div>
        <div className={`why ${c && !c.ok ? 'err-text' : ''}`}>{c ? c.msg : fallback ?? '检测中…'}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 1. 接上出口
function StepEgress({ onLater }: { onLater: () => void }) {
  const { snap, go, run } = useApp();
  const mode = snap.settings.egressMode;
  const rec = snap.lastPreflight;
  const lima = rec ? latestChecks(rec.checks).get('lima.version') : undefined;
  const ready = !!rec?.ok;
  usePoll(() => void act('preflight').catch(() => undefined), 4000, !ready);
  usePoll(() => void act('refreshCore').catch(() => undefined), 5000, mode === 'builtin' && !snap.core?.mihomo.path);
  const vmExistsNoBaseline = snap.vm.status !== 'Missing' && snap.vm.status !== 'Unknown' && !snap.egress.baseline;
  const choose = (m: typeof mode) => {
    if (m !== mode) void run(() => act('setEgressMode', m));
  };

  return (
    <>
      <Head title="欢迎使用 CCVM" sub="先给 VM 一个专用出口。VM 只认 Mac 上的 127.0.0.1:17897，所有流量都从这里经你选定的节点出去。" />
      <div className="options">
        <div className="card option">
          <b>Lima</b>
          <span className="muted">运行 VM · 不挂载 Mac 目录</span>
          <span className={`status ${levelOf(lima?.ok)}`}>
            <Dot level={levelOf(lima?.ok)} />
            {lima ? (lima.ok ? `已安装 ${rec?.values.lima_version ?? ''}` : '未安装或过旧：brew install lima') : '检测中'}
          </span>
        </div>
        <div className={`card option ${mode === 'builtin' ? 'selected' : ''}`} style={{ cursor: 'pointer' }} onClick={() => choose('builtin')}>
          <b>CCVM 自带核心</b>
          <span className="muted">贴订阅链接，选一个节点</span>
          <span className={`chip ${mode === 'builtin' ? 'accent' : ''}`}>{mode === 'builtin' ? '当前方式 · 推荐' : '推荐'}</span>
        </div>
        <div className={`card option ${mode === 'clash-verge' ? 'selected' : ''}`} style={{ cursor: 'pointer' }} onClick={() => choose('clash-verge')}>
          <b>我的 Clash Verge</b>
          <span className="muted">粘贴一次扩展脚本，加一个专用入口</span>
          {mode === 'clash-verge' && <span className="chip accent">当前方式</span>}
        </div>
      </div>

      {mode === 'builtin' ? <BuiltinSteps ready={ready} /> : <ClashVergeSteps ready={ready} />}

      <div className="steps">
        <div className="step">
          <span className={`step-num ${ready ? 'done' : ''}`}>✓</span>
          <div className="grow col" style={{ gap: 2 }}>
            <div>做完后这里会自动检测到</div>
            <Detect rec={rec} id="listener.loopback_only" label="专用入口只监听 127.0.0.1" fallback="还没看到 :17897 的监听" />
            <Detect rec={rec} id="egress.host_reachable" label="经专用入口能出网" />
            <Detect rec={rec} id="lima.no_global_config" label="Lima 目录里没有全局覆盖配置" />
          </div>
        </div>
      </div>

      {vmExistsNoBaseline && (
        <div className="callout warn row">
          <span className="grow">发现已有 VM「{snap.vm.name}」，但这里还没有出口基线。用过命令行套件的话，选择它的 state 目录，App 和脚本就共用同一份基线。</span>
          <button className="btn sm" onClick={() => run(() => act('chooseStateDir'))}>
            选择 state 目录
          </button>
        </div>
      )}

      <Foot snap={snap} onLater={onLater}>
        <button className="btn primary" disabled={!ready} onClick={() => go('/welcome/2')}>
          下一步
        </button>
      </Foot>
    </>
  );
}

function BuiltinSteps({ ready }: { ready: boolean }) {
  const { snap, run } = useApp();
  const core = snap.core;
  const installed = !!core?.mihomo.path && core.mihomo.versionOk;
  return (
    <div className="steps">
      <div className="step">
        <span className={`step-num ${installed ? 'done' : 'current'}`}>1</span>
        <div className="grow col">
          {installed ? (
            <span>
              已找到 mihomo v{core?.mihomo.version}（Homebrew）
            </span>
          ) : (
            <>
              <div className="row">
                <span className="grow">{core?.mihomo.path ? `mihomo ${core.mihomo.version ?? ''} 太旧，先升级` : '先用 Homebrew 装出口核心 mihomo'}</span>
                <button className="btn sm" onClick={() => run(() => act('copyText', core?.mihomo.path ? 'brew upgrade mihomo' : 'brew install mihomo'), '已复制')}>
                  复制命令
                </button>
              </div>
              <div className="code">{core?.mihomo.path ? 'brew upgrade mihomo' : 'brew install mihomo'}</div>
              <span className="tiny faint">装好后这里会自动检测到。App 用 launchd 把它作为你自己的后台服务运行，不需要管理员权限。</span>
            </>
          )}
        </div>
      </div>
      <div className="step">
        <span className={`step-num ${core?.node && !core.pending ? 'done' : installed ? 'current' : ''}`}>2</span>
        <div className="grow col">
          <div>贴订阅链接，选一个具体节点</div>
          {installed && <CoreSetup snap={snap} compact />}
          {core?.node && !ready && <span className="tiny faint">核心已经用「{core.node.name}」启动，正在确认它只监听 127.0.0.1…</span>}
        </div>
      </div>
    </div>
  );
}

function ClashVergeSteps({ ready }: { ready: boolean }) {
  const { snap, run } = useApp();
  const [node, setNode] = useState(snap.settings.nodeName);
  const [scriptErr, setScriptErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const r = await run(() => act('clashScript', node));
    if (!r) return;
    if (!r.ok || !r.script) return setScriptErr(r.error ?? '生成失败');
    setScriptErr(null);
    await run(() => act('updateSettings', { nodeName: node.trim() }));
    await run(() => act('copyText', r.script!));
    setCopied(true);
  };
  return (
    <div className="steps">
      <div className="step">
        <span className={`step-num ${node.trim() ? 'done' : 'current'}`}>1</span>
        <div className="grow col">
          <div>填一个具体节点的完整名称（和 Clash Verge 里显示的一致，保留 emoji 和空格）</div>
          <div className="row">
            <input className="input grow" value={node} placeholder="例如：示例节点 · 东京 01" onChange={(e) => { setNode(e.target.value); setCopied(false); }} />
            <button className="btn primary" disabled={!node.trim()} onClick={copy}>
              {copied ? '已复制，可以再复制' : '生成并复制扩展脚本'}
            </button>
          </div>
          {scriptErr && <span className="small err-text">{scriptErr}</span>}
          <span className="tiny faint">策略组、自动选择、负载均衡组都不行，要一个具体节点。节点名不在订阅里时，专用入口会拒绝连接，不会改走直连。</span>
        </div>
      </div>
      <div className="step">
        <span className={`step-num ${ready ? 'done' : copied ? 'current' : ''}`}>2</span>
        <div className="grow">
          在 Clash Verge 的订阅卡片上右键 → <b>扩展脚本</b>，粘贴，保存，然后重新激活订阅。
          <div className="tiny faint">已有 main() 时：保留原 main，把 <code>config = ccvmPatch(config);</code> 加到 return 前，删掉脚本末尾的 main()。</div>
        </div>
      </div>
    </div>
  );
}

function Foot({ snap, onLater, children }: { snap: Snapshot; onLater?: () => void; children: React.ReactNode }) {
  const { go } = useApp();
  return (
    <div className="welcome-foot">
      <span className="tiny faint grow">
        VM 会放在 <span className="mono">{snap.settings.limaHome}</span> ·{' '}
        <a onClick={() => go('/settings/vm')}>更改</a>
      </span>
      {onLater && (
        <button className="btn ghost" onClick={onLater}>
          以后再说
        </button>
      )}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------- 2. 准备 VM
const SETUP_STEPS: [string, string][] = [
  ['setup.listener', '确认专用入口'],
  ['setup.vm', '创建 VM（不挂载任何 Mac 目录；首次要下载约 600 MB 的 Ubuntu 镜像）'],
  ['setup.install', '安装防火墙和 sing-box，创建无 sudo 的 cc 用户'],
  ['setup.baseline', '记录出口基线'],
  ['setup.verify', '完整检查一遍，再做断流测试'],
];

function StepVm({ onLater }: { onLater: () => void }) {
  const { snap, go, run } = useApp();
  const job: JobSummary | undefined = snap.jobs.find((j) => j.kind === 'setup');
  const running = job?.state === 'running';
  const vmReady = snap.vm.status === 'Running' && !!snap.egress.baseline && !!snap.lastQuick?.ok;
  const done = job?.state === 'done' || (vmReady && !running);
  const currentIdx = running ? Math.max(0, SETUP_STEPS.findIndex(([id]) => id === job?.stepId)) : -1;
  const failedIdx = job?.state === 'failed' ? Math.max(0, SETUP_STEPS.findIndex(([id]) => id === job.result?.steps.at(-1)?.id)) : -1;
  const pct = done ? 100 : running ? Math.round(((currentIdx + 0.5) / SETUP_STEPS.length) * 100) : 0;
  const [showLog, setShowLog] = useState(false);
  const [log, setLog] = useState('');
  useEffect(() => {
    if (!showLog || !job) return;
    const load = () => void act('jobLog', job.id).then((t) => setLog(t.split('\n').slice(-40).join('\n'))).catch(() => undefined);
    load();
    const t = setInterval(load, 1500);
    return () => clearInterval(t);
  }, [showLog, job?.id]);

  return (
    <>
      <Head title={done ? 'VM 已经准备好' : running ? '正在准备 VM' : '准备 VM'} sub="在后台创建，不挂载任何 Mac 目录。可以先关掉这个窗口，做完会提醒你。" />
      <div className="card pad col">
        <div className="row small">
          <span className="grow">{done ? '全部完成' : running ? job?.step ?? '开始' : job?.state === 'failed' ? '没有完成' : '还没开始'}</span>
          <span className="muted">{pct}%</span>
        </div>
        <div className="progress">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="steps" style={{ marginTop: 6, gap: 6 }}>
          {SETUP_STEPS.map(([id, label], i) => {
            const state = done || i < currentIdx || (failedIdx >= 0 && i < failedIdx) ? 'done' : i === currentIdx ? 'current' : i === failedIdx ? 'failed' : '';
            return (
              <div className="row small" key={id}>
                <Dot level={state === 'done' ? 'ok' : state === 'current' ? 'busy' : state === 'failed' ? 'error' : 'idle'} />
                <span className={state ? '' : 'muted'}>{label}</span>
              </div>
            );
          })}
        </div>
        {job?.state === 'failed' && <div className="callout err">{job.reason}（安装可以重跑：修好原因后点「重试」）</div>}
        {job && (
          <a className="small" onClick={() => setShowLog(!showLog)}>
            {showLog ? '收起日志' : '查看日志'}
          </a>
        )}
        {showLog && <pre className="log">{log || '（还没有输出）'}</pre>}
      </div>
      <div className="callout warn">
        准备期间，VM 自己的系统流量（apt 等）暂时走 Mac 当前网络，所以现在不要登录 Claude 或放入任何凭据；做完验收后 VM 才只走专用入口。
      </div>
      <Foot snap={snap} onLater={onLater}>
        <button className="btn" onClick={() => go('/welcome/1')}>
          上一步
        </button>
        {!done && (
          <button className="btn primary" disabled={running} onClick={() => run(() => act('setup'))}>
            {job?.state === 'failed' ? '重试' : running ? '准备中…' : '开始准备'}
          </button>
        )}
        {done && (
          <button className="btn primary" onClick={() => go('/welcome/3')}>
            下一步
          </button>
        )}
      </Foot>
    </>
  );
}

// ---------------------------------------------------------------- 3. 登录 Claude
function StepClaude() {
  const { snap, go, run } = useApp();
  const installed = snap.claude.installed === true;
  const confirmed = snap.settings.claudeLoginConfirmed;
  usePoll(() => void act('refreshClaude').catch(() => undefined), 5000, !installed && snap.vm.status === 'Running');
  const finish = () =>
    run(async () => {
      await act('updateSettings', { welcomeDone: true });
      go('/');
    });
  return (
    <>
      <Head
        title="最后一步"
        sub={`VM 已经准备好${snap.egress.baseline ? `，出口 ${snap.egress.baseline}` : ''}。最后在 VM 里装 Claude Code 并登录。`}
      />
      <div className="steps">
        <div className="step">
          <span className="step-num done">1</span>
          <div className="grow row">
            <span className="grow">打开 cc 用户的终端（先经检查，再进入）</span>
            <button className="btn sm" disabled={snap.newSessionsBlocked} onClick={() => run(() => act('openTerminal'))}>
              打开终端
            </button>
          </div>
        </div>
        <div className="step">
          <span className={`step-num ${installed ? 'done' : 'current'}`}>2</span>
          <div className="grow col">
            <div className="row">
              <span className="grow">粘贴这行命令，回车（不需要 Node.js）</span>
              <button className="btn sm" onClick={() => run(() => act('copyText', INSTALL), '已复制')}>
                复制
              </button>
            </div>
            <div className="code">{INSTALL}</div>
          </div>
        </div>
        <div className="step">
          <span className={`step-num ${confirmed ? 'done' : installed ? 'current' : ''}`}>3</span>
          <div className="grow">
            运行 <code>claude</code>。VM 没有浏览器：把登录链接复制到 Mac 的浏览器里登录，再把授权码粘贴回终端。
          </div>
        </div>
        <div className="step">
          <span className={`step-num ${installed && confirmed ? 'done' : ''}`}>4</span>
          <div className="grow col" style={{ gap: 4 }}>
            <span className={`status ${installed ? 'ok' : 'idle'}`}>
              <Dot level={installed ? 'ok' : 'idle'} />
              {installed ? `已检测到 Claude Code ${snap.claude.version ?? ''}` : '安装后这里会自动检测到'}
            </span>
            <label className="row small">
              <input type="checkbox" checked={confirmed} onChange={(e) => run(() => act('updateSettings', { claudeLoginConfirmed: e.target.checked }))} />
              我已经在终端里登录了
            </label>
            <span className="tiny faint">App 不读取 VM 里的 ~/.claude，登录状态由你确认。</span>
          </div>
        </div>
      </div>
      <Foot snap={snap}>
        <button className="btn" onClick={() => go('/welcome/2')}>
          上一步
        </button>
        <button className="btn primary" onClick={finish}>
          开始使用
        </button>
      </Foot>
    </>
  );
}
