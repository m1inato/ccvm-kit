// 验收记录导出为 Markdown。只写检查 id、结论、脚本原话和出口 IP；不写订阅、凭据或本机路径。
import { latestChecks } from './checks';
import type { CheckRecord, Snapshot } from './types';

/** 检查面板的分组与简短名称（说明以脚本原话为准） */
export const CHECK_GROUPS: { title: string; ids: string[] }[] = [
  {
    title: 'Mac 与 Lima',
    ids: ['host.macos_arm64', 'lima.version', 'lima.no_global_config', 'lima.effective_config', 'listener.loopback_only', 'egress.host_matches_baseline'],
  },
  {
    title: 'VM 网络',
    ids: [
      'vm.firewall_active', 'vm.firewall_main_rules', 'vm.tun_up', 'vm.tun_routes', 'vm.egress_reachable', 'egress.vm_matches_baseline',
      'vm.nftables_masked', 'vm.resolv_static', 'vm.ipv6_off', 'vm.no_host_mounts', 'vm.dns_doh', 'vm.anthropic_reachable',
    ],
  },
  { title: '工作用户 cc', ids: ['cc.no_priv_groups', 'cc.no_sudo', 'cc.no_proxy_env'] },
  {
    title: '绕过尝试',
    ids: ['bypass.cc_listener', 'bypass.root_listener', 'bypass.mac_port_7897', 'bypass.mac_port_7890', 'bypass.mac_port_9097', 'bypass.mac_port_9090', 'bypass.lan'],
  },
];

export const LEAK_IDS = [
  'leak.precheck', 'leak.capture_control', 'leak.capture_bypass', 'leak.fw_persists', 'leak.tun_down_ipv4', 'leak.tun_down_ipv6',
  'leak.tun_down_dns', 'leak.tun_down_udp_dns', 'leak.tun_down_root_direct', 'leak.tun_down_root_listener', 'leak.tun_restored',
];

const LABELS: Record<string, string> = {
  'host.macos_arm64': 'Apple Silicon 原生终端',
  'lima.version': 'Lima ≥ 2.1',
  'lima.no_global_config': 'Lima 目录里没有全局覆盖配置',
  'lima.effective_config': 'VM 无额外网络，挂载只有允许的共享',
  'listener.loopback_only': '专用入口只听回环',
  'egress.host_matches_baseline': 'Mac 专用入口出口 = 基线',
  'egress.host_reachable': '经专用入口能出网',
  'egress.host_matches_vm': 'Mac 与 VM 出口一致',
  'baseline.present': '有出口基线',
  'vm.running': 'VM 运行中',
  'vm.exists': 'VM 存在',
  'vm.firewall_active': '防火墙服务运行中',
  'vm.firewall_main_rules': '主规则（不是锁定模式）',
  'vm.tun_up': 'TUN 运行中',
  'vm.tun_routes': 'TUN 策略路由在',
  'vm.egress_reachable': 'cc 经 TUN 出网',
  'egress.vm_matches_baseline': 'VM 出口 = 基线',
  'vm.nftables_masked': '通用 nftables 已屏蔽',
  'vm.resolv_static': 'DNS 指向 TUN',
  'vm.ipv6_off': 'IPv6 已关闭',
  'vm.no_host_mounts': '没有未经允许的宿主目录挂载',
  'vm.dns_doh': 'DNS 经 DoH',
  'vm.anthropic_reachable': 'api.anthropic.com 可达',
  'cc.no_priv_groups': 'cc 不在特权组',
  'cc.no_sudo': 'cc 没有 sudo',
  'cc.no_proxy_env': 'cc 没有代理变量',
  'bypass.cc_listener': 'cc 直连专用入口被拒',
  'bypass.root_listener': 'root 直连专用入口被拒',
  'bypass.mac_port_7897': 'Mac :7897 不可达',
  'bypass.mac_port_7890': 'Mac :7890 不可达',
  'bypass.mac_port_9097': 'Mac :9097 不可达',
  'bypass.mac_port_9090': 'Mac :9090 不可达',
  'bypass.lan': '局域网不可达',
  'leak.precheck': 'TUN 正常时可出网',
  'leak.capture_control': '抓包正向对照 > 0',
  'leak.capture_bypass': '旁路包 = 0',
  'leak.fw_persists': '停 TUN 后防火墙仍在',
  'leak.tun_down_ipv4': '停 TUN：IPv4 直连阻断',
  'leak.tun_down_ipv6': '停 TUN：IPv6 直连阻断',
  'leak.tun_down_dns': '停 TUN：DNS 阻断',
  'leak.tun_down_udp_dns': '停 TUN：UDP DNS 阻断',
  'leak.tun_down_root_direct': '停 TUN：root 直连阻断',
  'leak.tun_down_root_listener': '停 TUN：root 经入口阻断',
  'leak.tun_restored': 'TUN 恢复',
  'rebaseline.confirmed': '基线已更新',
  'claude.installed': 'Claude Code 已安装',
};

/** 同一个 id 取最新那次检查的结论 */
export function mergeChecks(records: (CheckRecord | undefined)[]): Map<string, { ok: boolean; msg: string; at: number }> {
  const merged = new Map<string, { ok: boolean; msg: string; at: number }>();
  const sorted = records.filter((r): r is CheckRecord => !!r).sort((a, b) => a.at - b.at);
  for (const rec of sorted) {
    for (const c of latestChecks(rec.checks).values()) merged.set(c.id, { ok: c.ok, msg: c.msg, at: rec.at });
  }
  return merged;
}

/** 验收矩阵（docs/operations.md）。auto 的两项由检查结果决定，其余由你做完后手动勾选。 */
export const MATRIX: { id: string; label: string; how: string; auto?: (s: Snapshot) => boolean }[] = [
  { id: 'basic', label: '基础验收', how: '完整验收全部通过', auto: (s) => !!s.lastFull?.ok },
  { id: 'leak', label: '断流 / 抓包', how: '正向对照 > 0，旁路 = 0，停 TUN 后阻断', auto: (s) => !!s.lastLeak?.ok },
  { id: 'vm_restart', label: 'VM 重启', how: '停止再启动 VM，然后完整验收和断流测试' },
  { id: 'sleep', label: 'Mac 睡眠唤醒', how: '唤醒后检查，两边时间同步、出口一致' },
  { id: 'proxy_tun', label: '切换系统代理或 Mac TUN', how: '切换后检查，出口不变' },
  { id: 'clash_mode', label: '切换 Clash 规则 / 全局 / 直连', how: '切换后检查，专用入口仍走固定节点' },
  { id: 'clash_quit', label: '退出 Clash 内核', how: 'VM 内不能联网；恢复后检查通过' },
  { id: 'node_gone', label: '节点消失或改名', how: '重新应用订阅后检查：入口不可用，无法联网' },
  { id: 'wifi', label: '切换 Wi-Fi / 热点', how: '切换后出口一致或明确失败' },
  { id: 'claude', label: 'Claude 登录与真实请求', how: '登录后发一句话，在 Clash 连接里看链路' },
];

export function matrixDone(s: Snapshot): { id: string; done: boolean }[] {
  return MATRIX.map((m) => ({ id: m.id, done: m.auto ? m.auto(s) : !!s.matrix[m.id] }));
}

export function checkLabel(id: string): string {
  return LABELS[id] ?? id;
}

function fmt(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function esc(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function section(title: string, rec: CheckRecord | undefined): string[] {
  const out = [`## ${title}`, ''];
  if (!rec) return [...out, '没有记录。', ''];
  out.push(`${fmt(rec.at)} · ${rec.ok ? '通过' : '未通过'}${rec.reason ? `（${esc(rec.reason)}）` : ''}`, '');
  out.push('| 结论 | id | 项目 | 脚本原话 |', '|---|---|---|---|');
  for (const c of latestChecks(rec.checks).values()) {
    out.push(`| ${c.ok ? '✓' : '✗'} | \`${c.id}\` | ${checkLabel(c.id)} | ${esc(c.msg)} |`);
  }
  out.push('');
  return out;
}

export function reportMarkdown(snap: Snapshot, now: number): string {
  const leak = snap.lastLeak;
  const lines = [
    '# CCVM 验收记录',
    '',
    `导出时间：${fmt(now)} · 套件 ${snap.kitVersion} · App ${snap.appVersion}`,
    '',
    `- 状态：${snap.headline}`,
    `- 出口基线：${snap.egress.baseline ?? '无'}`,
    `- Mac 专用入口出口：${snap.egress.host ?? '未知'}`,
    `- VM 出口：${snap.egress.vm ?? '未知'}`,
    `- VM：${snap.vm.name} · ${snap.vm.status}`,
    `- 共享文件夹：${snap.shares.applied.length ? `${snap.shares.applied.length} 个 · 读写（${snap.shares.applied.map((s) => s.view).join('、')}）` : '无'}`,
    '',
  ];
  if (leak) {
    lines.push(`断流测试：经专用入口 ${leak.values.capture_control ?? '?'} 个包 · 旁路 ${leak.values.capture_bypass ?? '?'} 个（${leak.ok ? '通过' : '未通过'}）`, '');
  }
  lines.push(...section('完整验收', snap.lastFull), ...section('最近一次快速检查', snap.lastQuick), ...section('断流测试', leak));
  lines.push('每一项都可以在终端用同一条命令复现：`bash scripts/check.sh --json`、`bash scripts/leaktest.sh --json`。', '');
  return lines.join('\n');
}
