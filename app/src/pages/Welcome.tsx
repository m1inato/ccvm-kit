// 欢迎页：3 步，每步自己检测、做完自动变绿；随时可以「以后再说」。
// 1 接上出口 → 2 后台准备 VM → 3 在 VM 里装 Claude Code 并登录。
import { useEffect, useState } from 'react';
import { latestChecks } from '../../core/checks';
import type { CheckRecord, JobSummary, Snapshot } from '../../core/types';
import { act, usePoll, useApp } from '../api';
import { Dot, Hint, levelOf } from '../components/common';
import { Logo } from '../components/Icon';
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

function Head({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="welcome-head">
      <Logo size={72} />
      <h1>{title}</h1>
      {sub && <p>{sub}</p>}
    </div>
  );
}

function Detect({ rec, id, label }: { rec?: CheckRecord; id: string; label: string }) {
  const c = rec ? latestChecks(rec.checks).get(id) : undefined;
  return (
    <div className="check-item">
      <Dot level={levelOf(c?.ok)} />
      <span className="grow">{label}</span>
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
  const choose = (m: typeof mode) => {
    if (m !== mode) void run(() => act('setEgressMode', m));
  };

  return (
    <>
      <Head title="欢迎使用 CCVM" sub="给 Claude Code 一台走代理的 VM" />
      <div className="options">
        <div className={`card option ${mode === 'builtin' ? 'selected' : ''}`} onClick={() => choose('builtin')}>
          <b>CCVM 自带核心</b>
          <span className="muted">贴订阅链接，选一个节点</span>
          <span className="chip accent">推荐</span>
        </div>
        <div className={`card option ${mode === 'clash-verge' ? 'selected' : ''}`} onClick={() => choose('clash-verge')}>
          <b>我的 Clash Verge</b>
          <span className="muted">粘贴一次扩展脚本</span>
        </div>
      </div>

      {mode === 'builtin' ? <BuiltinSteps ready={ready} /> : <ClashVergeSteps ready={ready} />}

      <div className="steps">
        <div className="step">
          <span className={`step-num ${ready ? 'done' : ''}`}>✓</span>
          <div className="grow col" style={{ gap: 2 }}>
            <div className="check-item">
              <Dot level={levelOf(lima?.ok)} />
              <span className="grow">{lima ? (lima.ok ? `Lima ${rec?.values.lima_version ?? ''}` : 'Lima 未安装或过旧：brew install lima') : 'Lima'}</span>
            </div>
            <Detect rec={rec} id="host.proxy" label="代理入口 127.0.0.1:17897 能出网" />
          </div>
        </div>
      </div>

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
            </>
          )}
        </div>
      </div>
      <div className="step">
        <span className={`step-num ${core?.node ? 'done' : installed ? 'current' : ''}`}>2</span>
        <div className="grow col">
          <div>贴订阅链接，选一个具体节点</div>
          {installed && <CoreSetup snap={snap} compact />}
          {core?.node && !ready && <span className="small muted">正在确认…</span>}
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
          <div className="row" style={{ gap: 6 }}>
            填一个具体节点的名称
            <Hint text="和 Clash Verge 里显示的完全一致（保留 emoji 和空格）。要一个具体节点，不能是策略组。" />
          </div>
          <div className="row">
            <input className="input grow" value={node} placeholder="例如：示例节点 · 东京 01" onChange={(e) => { setNode(e.target.value); setCopied(false); }} />
            <button className="btn primary" disabled={!node.trim()} onClick={copy}>
              {copied ? '已复制' : '复制扩展脚本'}
            </button>
          </div>
          {scriptErr && <span className="small err-text">{scriptErr}</span>}
        </div>
      </div>
      <div className="step">
        <span className={`step-num ${ready ? 'done' : copied ? 'current' : ''}`}>2</span>
        <div className="grow">
          <span className="row" style={{ gap: 6, display: 'inline-flex' }}>
            在 Clash Verge 的订阅卡片上右键 → <b>扩展脚本</b>，粘贴，保存，再重新激活订阅
            <Hint text="已有 main() 时：保留原来的 main，把 config = ccvmPatch(config); 加到 return 前，删掉脚本末尾的 main()。" />
          </span>
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
  ['setup.proxy', '确认代理入口'],
  ['setup.vm', '创建 VM（首次要下载约 600 MB 的 Ubuntu 镜像）'],
  ['setup.install', '安装 sing-box 和防火墙，创建 cc 用户'],
  ['setup.verify', '检查网络'],
];

function StepVm({ onLater }: { onLater: () => void }) {
  const { snap, go, run } = useApp();
  const job: JobSummary | undefined = snap.jobs.find((j) => j.kind === 'setup');
  const running = job?.state === 'running';
  const vmReady = snap.vm.status === 'Running' && !!snap.lastCheck?.ok;
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
      <Head title={done ? 'VM 已经准备好' : running ? '正在准备 VM' : '准备 VM'} sub={running ? '可以先关掉这个窗口，做完会提醒你' : undefined} />
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
        {job?.state === 'failed' && <div className="callout err">{job.reason}</div>}
        {job && (
          <a className="small" onClick={() => setShowLog(!showLog)}>
            {showLog ? '收起日志' : '查看日志'}
          </a>
        )}
        {showLog && <pre className="log">{log || '（还没有输出）'}</pre>}
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
        sub="最后在 VM 里装 Claude Code 并登录"
      />
      <div className="steps">
        <div className="step">
          <span className="step-num done">1</span>
          <div className="grow row">
            <span className="grow">打开 cc 用户的终端</span>
            <button className="btn sm" disabled={snap.vm.status !== 'Running'} onClick={() => run(() => act('openTerminal'))}>
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
            <span className={`state ${installed ? 'ok' : ''}`}>
              <Dot level={installed ? 'ok' : 'idle'} />
              {installed ? `已检测到 Claude Code ${snap.claude.version ?? ''}` : '安装后这里会自动检测到'}
            </span>
            <label className="row small">
              <input type="checkbox" checked={confirmed} onChange={(e) => run(() => act('updateSettings', { claudeLoginConfirmed: e.target.checked }))} />
              我已经在终端里登录了
            </label>
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
