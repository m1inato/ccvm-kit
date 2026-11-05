// 假的 macOS：模拟 launchctl、scutil、lsof 和 Homebrew 的 mihomo
import type { ExecFn } from '../core/egress';

export const NWI = (iface: string) => `IPv4 network interface information\n   utun4 : flags : 0x5\n     ${iface} : flags      : 0x5 (IPv4,DNS)\n\nIPv6 network interface information\n`;

export class FakeMac {
  loaded = false;
  dnsServers = ['192.0.2.53'];
  dnsRoute: string | undefined;
  dnsRoutes: Record<string, string> = {};
  iface: string | undefined = 'en0';
  mihomo: string | undefined = '/opt/homebrew/bin/mihomo';
  version = '1.19.33';
  calls: string[] = [];
  /** 别的程序（比如没移除的 Clash Verge 扩展脚本）占着 17897。测试从不真的去连本机端口 */
  otherListener = false;
  portInUse = async (): Promise<boolean> => this.otherListener;
  exec: ExecFn = async (cmd, args) => {
    this.calls.push([cmd, ...args].join(' '));
    const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
    if (cmd === '/bin/sh') return this.mihomo ? ok(this.mihomo + '\n') : { code: 1, stdout: '', stderr: '' };
    if (cmd === this.mihomo && args[0] === '-v') return ok(`Mihomo Meta v${this.version} darwin arm64 with go1.24`);
    if (cmd === 'scutil') return this.iface ? ok(NWI(this.iface)) : ok('IPv4 network interface information\n   No IPv4 states found\n');
    if (cmd === '/usr/sbin/ipconfig') return ok(`domain_name_server (ip_mult): {${this.dnsServers.join(', ')}}`);
    if (cmd === '/sbin/route') return ok(`  interface: ${this.dnsRoutes[args[2]] ?? this.dnsRoute ?? this.iface}\n`);
    if (cmd === 'lsof') return ok('mihomo 4242 me 7u IPv4 TCP 127.0.0.1:17897 (LISTEN)');
    if (cmd === 'launchctl') {
      if (args[0] === 'print') return this.loaded ? ok('\tstate = running\n\tpid = 4242\n') : { code: 113, stdout: '', stderr: 'Could not find service' };
      if (args[0] === 'bootstrap') {
        this.loaded = true;
        return ok();
      }
      if (args[0] === 'bootout') {
        const was = this.loaded;
        this.loaded = false;
        return was ? ok() : { code: 3, stdout: '', stderr: 'No such process' };
      }
    }
    return { code: 127, stdout: '', stderr: `unexpected ${cmd}` };
  };
}

