# Cross-check every key used in the kit's configs against field tags in upstream source at the pinned tags.
import json, re, sys, pathlib, subprocess
src, kit = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def tags(globpat, kind):
    s = set()
    for p in src.glob(globpat):
        s |= set(re.findall(kind + r':"([^",]+)', p.read_text(errors="ignore")))
    return s
def walk(o, out):
    if isinstance(o, dict):
        for k, v in o.items(): out.add(k); walk(v, out)
    elif isinstance(o, list):
        for v in o: walk(v, out)
    return out
ok = True
def report(name, used, known):
    global ok
    missing = sorted(used - known)
    print(("PASS" if not missing else "FAIL"), name, f"({len(used)} keys)", "missing: " + ", ".join(missing) if missing else "")
    ok &= not missing

sb = json.loads((kit / "config/sing-box.json").read_text())
report("sing-box 1.14.4 字段", walk(sb, set()), tags("sing-box/option/**/*.go", "json"))
# enum values
tun = (src / "sing-box/option/tun.go").read_text()
assert 'enum:"disabled,native,hijack"' in tun and 'enum:"system,gvisor,mixed"' in tun
consts = (src / "sing-box/constant/rule.go").read_text() + (src / "sing-box/constant/proxy.go").read_text() + (src / "sing-box/constant/dns.go").read_text()
for v in ["hijack-dns", "reject", "socks", "https", "tun"]:
    assert f'"{v}"' in consts, v
assert "ipv4_only" in (src / "sing-box/option/types.go").read_text() or "ipv4_only" in "".join(p.read_text() for p in (src/"sing-box/option").glob("*.go"))
print("PASS sing-box 枚举值（dns_mode=disabled, stack=system, hijack-dns/reject, socks/https/tun, ipv4_only）")

import yaml
report("Lima 2.2.1 字段", walk(yaml.safe_load((kit / "config/lima.yaml").read_text()), set()), tags("lima/pkg/limatype/*.go", "yaml"))
assert (src / "lima/templates/_images/ubuntu-24.04.yaml").exists()
print("PASS Lima 内置模板 _images/ubuntu-24.04 存在")

grp = {"name", "type", "include-all", "filter", "empty-fallback"}
report("mihomo 1.19.33 proxy-group 字段", grp, tags("mihomo/adapter/outboundgroup/parser.go", "group") | {"name", "type"})
lst = {"name", "type", "listen", "port", "udp", "proxy"}
report("mihomo 1.19.33 mixed listener 字段", lst, tags("mihomo/listener/inbound/base.go", "inbound") | tags("mihomo/listener/inbound/mixed.go", "inbound") | {"type"})
sys.exit(0 if ok else 1)
