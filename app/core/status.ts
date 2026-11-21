// 从检查记录推出状态与问题列表。只看一件事：代理通不通。代理断了 VM 自己就断网（防火墙只放行代理），
// 所以这里不拦会话，只负责告诉你现在是什么情况。
import { latestChecks } from './checks';
import type { CheckRecord, CoreStatus, Issue, JobSummary, Level, VmInfo } from './types';

export function issuesFromCheck(rec: CheckRecord | undefined): Issue[] {
  if (!rec || rec.ok) return [];
  const checks = latestChecks(rec.checks);
  const failed = [...checks.values()].filter((c) => !c.ok);
  // VM 没在运行：属于没准备好，不算出错
  if (failed.some((c) => c.id === 'vm.running' || c.id === 'vm.exists')) return [];
  const has = (id: string) => failed.some((c) => c.id === id);
  const handled = new Set(['host.proxy', 'vm.proxy', 'vm.tun', 'vm.firewall']);
  const issues: Issue[] = [];

  if (has('host.proxy')) {
    issues.push({ key: 'proxy_down', kind: 'proxy_down', title: '代理断开', detail: '127.0.0.1:17897 连不上代理，VM 已断网。代理恢复后自动连上。' });
  } else if (has('vm.tun')) {
    issues.push({ key: 'tun_down', kind: 'tun_down', title: 'VM 网络停了', detail: 'VM 里的 TUN 没有运行，VM 已断网。重启 VM 一般能恢复。' });
  } else if (has('vm.proxy')) {
    issues.push({ key: 'proxy_down:vm', kind: 'proxy_down', title: '代理断开', detail: 'VM 经代理出不去，已断网。代理恢复后自动连上。' });
  }
  if (has('vm.firewall')) {
    issues.push({ key: 'firewall', kind: 'firewall', title: '防火墙没有加载', detail: '在管理员 shell 里查看 journalctl -u ccvm-firewall，或重启 VM。' });
  }
  for (const c of failed) {
    if (!handled.has(c.id)) issues.push({ key: `check_failed:${c.id}`, kind: 'check_failed', title: '检查没有通过', detail: c.msg });
  }
  if (!issues.length) {
    issues.push({ key: 'check_incomplete', kind: 'check_incomplete', title: '检查没有跑完', detail: rec.reason ?? '没有拿到结果' });
  }
  return issues;
}

/** 自带核心模式下的问题。核心停了，代理就断了。 */
export function issuesFromCore(core: CoreStatus | undefined): Issue[] {
  if (!core) return [];
  if (!core.mihomo.path) {
    return [{ key: 'core_missing', kind: 'core_missing', title: '找不到 mihomo', detail: '在终端运行 brew install mihomo，装好后会自动检测到。' }];
  }
  if (!core.mihomo.versionOk) {
    return [{ key: `core_missing:version:${core.mihomo.version}`, kind: 'core_missing', title: 'mihomo 版本太旧', detail: `当前 ${core.mihomo.version ?? '未知'}，需要 ≥ 1.19.0：brew upgrade mihomo` }];
  }
  if (!core.node || core.stopped) return []; // 还没选节点，或者是你停的
  if (!core.service.running) {
    return [{
      key: 'core_down',
      kind: 'core_down',
      title: '出口核心停了',
      detail: `launchd 会自动拉起它${core.service.lastExit ? `（上次退出码 ${core.service.lastExit}）` : ''}。一直起不来时在设置里重启核心。`,
    }];
  }
  if (core.listenerOwned === false && core.portBusy) {
    return [{ key: 'core_conflict', kind: 'core_conflict', title: '17897 端口被占用', detail: '多半是 Clash Verge 里的 CCVM 扩展脚本。移除它后重启核心。' }];
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
const BUSY_KINDS = new Set(['setup', 'clone', 'vm-start', 'vm-stop', 'vm-upgrade', 'shares']);

export function deriveLevel(input: LevelInput): { level: Level; headline: string; detail: string } {
  const { issues, vm, lastCheck, jobs, now } = input;
  const running = jobs.filter((j) => j.state === 'running' && BUSY_KINDS.has(j.kind));
  if (issues.length) return { level: 'error', headline: issues[0].title, detail: issues[0].detail };
  if (running.length) return { level: 'busy', headline: running[0].title, detail: running[0].step ?? '' };
  if (vm.status === 'Missing') return { level: 'idle', headline: '还没部署', detail: '打开欢迎页完成部署' };
  if (vm.status !== 'Running') return { level: 'idle', headline: 'VM 已停止', detail: vm.error ?? '' };
  if (!lastCheck) return { level: 'idle', headline: '正在检查', detail: '' };
  const staleAfter = Math.max(1, input.intervalMin) * 60_000 * 2.5;
  if (now - lastCheck.at > staleAfter) return { level: 'idle', headline: '等待检查', detail: '' };
  const ip = lastCheck.values.vm_egress || lastCheck.values.host_egress || '';
  return { level: 'ok', headline: '已连接', detail: ip ? `出口 ${ip}` : '' };
}

/** 同一个问题只通知一次；消失后再出现才再通知 */
export class AlertTracker {
  private active = new Set<string>();

  update(issues: Issue[]): Issue[] {
    const fresh = issues.filter((i) => !this.active.has(i.key));
    this.active = new Set(issues.map((i) => i.key));
    return fresh;
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
