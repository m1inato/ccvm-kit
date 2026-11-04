// 用桩命令代替 Mac 与 VM，驱动真实的 scripts/*.sh
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const KIT = path.resolve(__dirname, '..', '..');

const LIMACTL = String.raw`#!/bin/bash
printf '%s\n' "$*" >> "$STUB_DIR/calls.log"
status="$(cat "$STUB_DIR/vm_status" 2>/dev/null || echo Running)"
case "$1" in
  --version) echo "limactl version 2.2.1" ;;
  list)
    case "$*" in
      *--json*) [ -n "$status" ] && printf '{"name":"ccvm","status":"%s","cpus":4,"memory":6442450944,"disk":64424509440,"arch":"aarch64"}\n' "$status" ;;
      *"{{.Status}}"*) printf '%s\n' "$status" ;;
      *".Location"*) cat "$STUB_DIR/mounts" 2>/dev/null || true ;;
      *"{{len .Config.Networks}}"*) echo 0 ;;
    esac ;;
  edit) printf '%s' "$4" > "$STUB_DIR/edit" ;;
  shell)
    body="$(cat)"
    case "$body" in
      *"ccvm-shares.service"*) f=shares ;;
      *"VM 内以 cc 身份运行"*) f=workspace ;;
      *"会短暂停止 TUN"*) f=leaktest ;;
      *) f=selfcheck ;;
    esac
    [ -f "$STUB_DIR/$f.sleep" ] && sleep "$(cat "$STUB_DIR/$f.sleep")"
    [ -f "$STUB_DIR/$f.out" ] && cat "$STUB_DIR/$f.out"
    exit "$(cat "$STUB_DIR/$f.rc" 2>/dev/null || echo 0)" ;;
  start) echo Running > "$STUB_DIR/vm_status" ;;
  stop) echo Stopped > "$STUB_DIR/vm_status" ;;
  *) exit 91 ;;
esac
`;

export const SELFCHECK_OK = [
  'PASS vm.firewall_active 防火墙服务运行中',
  'PASS vm.firewall_main_rules 主防火墙规则已加载（不是锁定模式）',
  'PASS vm.tun_up TUN 服务运行中且 sb-tun 存在',
  'PASS vm.egress_reachable VM 可经 TUN 出网：203.0.113.7',
  'PASS egress.vm_matches_baseline VM 出口 = 基线 203.0.113.7',
  'EGRESS 203.0.113.7',
  '',
].join('\n');

export interface Fixture {
  root: string;
  bin: string;
  stub: string;
  data: string;
  state: string;
  set(name: string, content: string): void;
  calls(): string;
  cleanup(): void;
}

export function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ccvm-app-'));
  const bin = path.join(root, 'bin');
  const stub = path.join(root, 'stub');
  const data = path.join(root, 'data');
  const state = path.join(data, 'state');
  for (const d of [bin, stub, state]) fs.mkdirSync(d, { recursive: true });
  const write = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), body, { mode: 0o755 });
  };
  write('limactl', LIMACTL);
  write('uname', '#!/bin/bash\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; *) exit 90;; esac\n');
  write('curl', `#!/bin/bash\nprintf 'ip=%s\\n' "$(cat "${stub}/host_ip" 2>/dev/null || echo 203.0.113.7)"\n`);
  write('netstat', "#!/bin/bash\nprintf 'tcp4 0 0 127.0.0.1.17897 *.* LISTEN\\n'\n");
  fs.writeFileSync(path.join(stub, 'selfcheck.out'), SELFCHECK_OK);
  fs.writeFileSync(path.join(state, 'expected-ip.txt'), '203.0.113.7\n');
  return {
    root,
    bin,
    stub,
    data,
    state,
    set: (name, content) => fs.writeFileSync(path.join(stub, name), content),
    calls: () => {
      try {
        return fs.readFileSync(path.join(stub, 'calls.log'), 'utf8');
      } catch {
        return '';
      }
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** 桩 PATH：STUB_DIR 通过 PATH 里的脚本读取，所以也放进环境 */
export function stubEnv(f: Fixture): Record<string, string> {
  return {
    PATH: `${f.bin}:/usr/bin:/bin`,
    HOME: f.root,
    USER: 'tester',
    LANG: 'C.UTF-8',
    STUB_DIR: f.stub,
    CCVM_NAME: 'ccvm',
    CCVM_LIMA_HOME: path.join(f.root, 'lima'),
    CCVM_STATE_DIR: f.state,
  };
}

export async function waitFor<T>(fn: () => T | undefined | false, ms = 15_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 50));
  }
}
