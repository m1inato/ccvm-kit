// 从检查记录推出四种状态与问题列表。只用脚本给出的检查 id 和原话，不自己重新判断网络。
import { latestChecks } from './checks';
import type { CheckRecord, CoreStatus, Issue, JobSummary, Level, VmInfo } from './types';

/** 这些检查失败不算「出错」，而是还没准备好（灰点） */
const NOT_READY = new Set(['vm.running', 'vm.exists', 'baseline.present']);

export function newestCheck(quick?: CheckRecord, full?: CheckRecord): CheckRecord | undefined {
  if (!quick) return full;
  if (!full) return quick;
  return full.at >= quick.at ? full : quick;
}

/** 一次检查记录 → 出错项。同一类问题合并成一条，标题是给人看的一句话。 */
export function issuesFromCheck(rec: CheckRecord | undefined): Issue[] {
  if (!rec || rec.ok) return [];
  const checks = latestChecks(rec.checks);
  const failed = [...checks.values()].filter((c) => !c.ok);
  if (failed.some((c) => NOT_READY.has(c.id))) return [];
  const v = rec.values;
  const issues: Issue[] = [];
  const has = (id: string) => failed.some((c) => c.id === id);
  const msg = (id: string) => failed.find((c) => c.id === id)?.msg ?? '';
  const handled = new Set<string>();

  if (has('lima.no_global_config') || has('lima.effective_config')) {
    const id = has('lima.no_global_config') ? 'lima.no_global_config' : 'lima.effective_config';
    issues.push({ key: `lima_config:${id}`, kind: 'lima_config', title: 'Lima 配置不安全', detail: msg(id), checkId: id });
    handled.add('lima.no_global_config').add('lima.effective_config');
  }
  if (has('listener.loopback_only')) {
    issues.push({
      key: 'listener_down',
      kind: 'listener_down',
      title: '专用入口不可用',
      detail: msg('listener.loopback_only'),
      checkId: 'listener.loopback_only',
    });
    handled.add('listener.loopback_only');
  }
  if (has('vm.firewall_main_rules') || has('vm.firewall_active')) {
    issues.push({
      key: 'lockdown',
      kind: 'lockdown',
      title: '防火墙处于锁定模式',
      detail: 'VM 现在断网，只能登录修复。在管理员 shell 里查看 journalctl -u ccvm-firewall。',
      checkId: 'vm.firewall_main_rules',
    });
    handled.add('vm.firewall_main_rules').add('vm.firewall_active');
  }
  if (has('vm.tun_up')) {
    issues.push({
      key: 'tun_down',
      kind: 'tun_down',
      title: 'TUN 停了',
      detail: 'VM 现在断网；防火墙还在，不会改走直连。在管理员 shell 里查看 journalctl -u ccvm-tun。',
      checkId: 'vm.tun_up',
    });
    handled.add('vm.tun_up').add('vm.egress_reachable').add('egress.vm_matches_baseline');
  } else if (has('vm.tun_routes')) {
    // TUN 进程还在，路由没了：多半是系统更新重启了 networkd。看门狗会在 30 秒内重启 TUN
    issues.push({
      key: 'tun_down:routes',
      kind: 'tun_down',
      title: 'TUN 的路由丢了',
      detail: 'TUN 还在运行，但策略路由没了（常见于系统更新重启了网络服务），流量进不了 TUN：VM 现在断网，防火墙还在，不会改走直连。看门狗会在 30 秒内重启 TUN；没有看门狗的旧 VM 先在首页「更新 VM」，或者停止再启动 VM。',
      checkId: 'vm.tun_routes',
    });
    handled.add('vm.tun_routes').add('vm.egress_reachable').add('egress.vm_matches_baseline');
  }

  const hostBad = has('egress.host_matches_baseline');
  // TUN 停了时 VM 出口必然不对，那是 TUN 的问题，不再另报一次
  const vmBad = has('egress.vm_matches_baseline') && !handled.has('egress.vm_matches_baseline');
  if (hostBad || vmBad) {
    const baseline = v.baseline ?? '';
    const host = v.host_egress ?? '';
    const vm = v.vm_egress ?? '';
    if (hostBad && !host && !issues.some((i) => i.kind === 'listener_down')) {
      issues.push({
        key: 'listener_down:unreachable',
        kind: 'listener_down',
        title: '专用入口不通',
        detail: '经 127.0.0.1:17897 拿不到出口：出口核心停了、节点不可用，或 Clash Verge 没在运行。VM 现在断网。',
        checkId: 'egress.host_matches_baseline',
      });
    } else if ((vmBad && vm) || (hostBad && host)) {
      const now = vmBad && vm ? vm : host;
      const who = vmBad && vm ? 'VM' : 'Mac 专用入口';
      issues.push({
        key: `egress_changed:${now}`,
        kind: 'egress_changed',
        title: '出口变了',
        detail: `${who}现在走 ${now}，不是记住的 ${baseline || '基线'}。核实之前，不会打开新的 Claude 会话。`,
        checkId: vmBad ? 'egress.vm_matches_baseline' : 'egress.host_matches_baseline',
        data: { baseline, host, vm },
      });
    }
    handled.add('egress.host_matches_baseline').add('egress.vm_matches_baseline');
  }

  for (const c of failed) {
    if (handled.has(c.id)) continue;
    issues.push({ key: `check_failed:${c.id}`, kind: 'check_failed', title: '检查未通过', detail: c.msg, checkId: c.id });
  }
  if (!issues.length) {
    // 没有任何失败项却不是通过：脚本没跑完、没输出或输出看不懂
    issues.push({
      key: 'check_incomplete',
      kind: 'check_incomplete',
      title: '检查没有跑完',
      detail: rec.reason ?? '结果不确定，按失败处理',
    });
  }
  return issues;
}

export function issuesFromLeak(rec: CheckRecord | undefined): Issue[] {
  if (!rec || rec.ok) return [];
  // 断流测试没通过，就不能确认 TUN 停了也不会泄漏：普通检查通过代替不了它。修好之后要重新做一次才解除
  return [{
    key: 'leak_failed',
    kind: 'leak_failed',
    title: '断流测试没有通过',
    detail: `${rec.reason ?? '查看检查面板'}。在这之前不开新会话；问题修好之后（快速检查恢复正常也一样），重新做一次断流测试，通过了才会解除。`,
  }];
}

/** 自带核心模式下的问题。核心停了 VM 就断网（不会直连），所以这些都算「出错」。 */
export function issuesFromCore(core: CoreStatus | undefined): Issue[] {
  if (!core) return [];
  if (!core.mihomo.path) {
    return [{ key: 'core_missing', kind: 'core_missing', title: '找不到 mihomo', detail: '自带核心需要 Homebrew 的 mihomo：在终端运行 brew install mihomo，装好后会自动检测到。' }];
  }
  if (!core.mihomo.versionOk) {
    return [{ key: `core_missing:version:${core.mihomo.version}`, kind: 'core_missing', title: 'mihomo 版本太旧', detail: `当前 ${core.mihomo.version ?? '未知'}，需要 ≥ 1.19.0：brew upgrade mihomo` }];
  }
  if (core.pending) {
    const pinned = core.node?.name ?? '';
    return [{
      key: `node_changed:${core.pending.kind}:${core.pending.at}`,
      kind: 'node_changed',
      title: '选定节点变了',
      detail: core.pending.kind === 'missing'
        ? `订阅里已经没有「${pinned}」。VM 已断网；请换一个节点，换节点等于换出口。`
        : `「${pinned}」的地址、端口或密码变了。VM 已断网，确认后才会用新的节点信息。`,
      data: { node: pinned, kind: core.pending.kind },
    }];
  }
  if (!core.node) return []; // 还没选节点：属于没设置好，不算出错
  if (core.stopped) {
    return [{ key: `core_down:${core.stopped.reason}`, kind: 'core_down', title: '出口核心停了', detail: `${core.stopped.detail}。VM 现在断网，不会改走直连。` }];
  }
  if (!core.service.running) {
    return [{
      key: 'core_down:crashed',
      kind: 'core_down',
      title: '出口核心停了',
      detail: `launchd 会自动拉起它，拉起之前 VM 断网${core.service.lastExit ? `（上次退出码 ${core.service.lastExit}）` : ''}。一直起不来时查看核心日志。`,
    }];
  }
  if (core.listenerOwned === false && core.portBusy) {
    return [{ key: 'core_conflict', kind: 'core_conflict', title: '专用入口被别的程序占着', detail: '127.0.0.1:17897 不是自带核心在听（多半是 Clash Verge 里的 CCVM 扩展脚本）。在 Clash Verge 里移除扩展脚本后重启核心。' }];
  }
  return [];
}

export interface LevelInput {
  issues: Issue[];
  vm: VmInfo;
  lastCheck?: CheckRecord;
  jobs: JobSummary[];
  intervalMin: number;
  now: number;
}

/** 有这些后台任务在跑时显示「进行中」 */
const BUSY_KINDS = new Set(['setup', 'leaktest', 'clone', 'vm-start', 'vm-stop', 'check-full']);

export function deriveLevel(input: LevelInput): { level: Level; headline: string; detail: string } {
  const { issues, vm, lastCheck, jobs, now } = input;
  const running = jobs.filter((j) => j.state === 'running' && BUSY_KINDS.has(j.kind));
  if (issues.length) {
    const first = issues[0];
    return { level: 'error', headline: first.title, detail: first.detail };
  }
  if (running.length) {
    return { level: 'busy', headline: running[0].title, detail: running[0].step ?? '后台任务进行中' };
  }
  if (vm.status === 'Missing') return { level: 'idle', headline: '还没部署', detail: '打开欢迎页，按 3 步完成部署' };
  if (vm.status !== 'Running') {
    return { level: 'idle', headline: 'VM 没有运行', detail: vm.error ?? `当前状态：${vm.status}` };
  }
  if (!lastCheck) return { level: 'idle', headline: '等待检查', detail: '还没有检查结果' };
  const notReady = lastCheck.checks.find((c) => !c.ok && NOT_READY.has(c.id));
  if (notReady) return { level: 'idle', headline: '还没准备好', detail: notReady.msg };
  if (!lastCheck.ok) return { level: 'error', headline: '检查没有通过', detail: lastCheck.reason ?? '' };
  // 过期的结论不能继续显示为绿：超过 2.5 个检查间隔就变灰
  const staleAfter = Math.max(1, input.intervalMin) * 60_000 * 2.5;
  if (now - lastCheck.at > staleAfter) return { level: 'idle', headline: '需要重新检查', detail: '上次检查已经过去太久' };
  const ip = lastCheck.values.vm_egress || lastCheck.values.baseline || '';
  return { level: 'ok', headline: '受保护', detail: ip ? `出口 ${ip}，和基线一致` : '和基线一致' };
}

/** 同一个问题只通知一次；消失后再出现才再通知 */
export class AlertTracker {
  private active = new Set<string>();

  update(issues: Issue[]): Issue[] {
    const fresh = issues.filter((i) => !this.active.has(i.key));
    this.active = new Set(issues.map((i) => i.key));
    return fresh;
  }

  resolved(issues: Issue[]): string[] {
    const keys = new Set(issues.map((i) => i.key));
    return [...this.active].filter((k) => !keys.has(k));
  }
}

/** 同一个键在窗口期内只放行一次（「做完了」字幕：同一项目 5 分钟内一次） */
export class Throttle {
  private last = new Map<string, number>();
  constructor(private windowMs: number) {}
  allow(key: string, now: number): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < this.windowMs) return false;
    this.last.set(key, now);
    return true;
  }
}

export function relativeTime(at: number | undefined, now: number): string {
  if (!at) return '从未';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return '刚刚';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} 分钟前`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} 小时前`;
  return `${Math.round(h / 24)} 天前`;
}

export function duration(sinceSec: number, nowMs: number): string {
  if (!sinceSec) return '';
  const total = Math.max(0, Math.floor(nowMs / 1000 - sinceSec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  return h ? `${h}:${String(m).padStart(2, '0')}` : `${m} 分钟`;
}
