// Runs the kit's Clash Verge script against synthetic subscriptions.
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const src = fs.readFileSync(process.argv[2], "utf8");
function load(node) {
  const code = src.replace(/^const NODE = .*;$/m, "const NODE = " + JSON.stringify(node) + ";");
  const ctx = {}; vm.createContext(ctx); vm.runInContext(code + "\nthis.main = main;", ctx);
  return (cfg) => JSON.parse(JSON.stringify(ctx.main(JSON.parse(JSON.stringify(cfg)), "test")));
}
const NODE = "🇯🇵 东京 01 | IEPL [x1.5] (Netflix)+?";
const base = {
  "mixed-port": 7897, "socks-port": 7898,
  proxies: [
    { name: NODE, type: "vless", server: "a.example", port: 443 },
    { name: NODE + " 2", type: "trojan", server: "b.example", port: 443 },
    { name: "直连伪节点", type: "direct" },
  ],
  "proxy-groups": [{ name: "自动选择", type: "url-test", proxies: [NODE, NODE + " 2"] }],
  listeners: [{ name: "keep-me", type: "socks", port: 7999, listen: "127.0.0.1" }],
  rules: ["MATCH,自动选择"],
};
let n = 0; const t = (name, fn) => { fn(); n++; console.log("PASS", name); };

t("inline 订阅：生成组与监听，其他配置不变", () => {
  const out = load(NODE)(base);
  const g = out["proxy-groups"].find((x) => x.name === "CC-VM-FIXED");
  assert.deepStrictEqual(Object.keys(g).sort(), ["empty-fallback", "filter", "include-all", "name", "type"].sort());
  assert.strictEqual(g["empty-fallback"], "REJECT");
  const l = out.listeners.find((x) => x.name === "cc-vm-in");
  assert.deepStrictEqual(l, { name: "cc-vm-in", type: "mixed", listen: "127.0.0.1", port: 17897, udp: false, proxy: "CC-VM-FIXED" });
  assert.ok(out.listeners.find((x) => x.name === "keep-me"));
  assert.deepStrictEqual(out.rules, base.rules);
  assert.deepStrictEqual(out.proxies, base.proxies);
  assert.strictEqual(out["mixed-port"], 7897);
});
t("filter 只精确匹配目标节点（含 emoji、空格和正则元字符）", () => {
  const re = new RegExp(load(NODE)(base)["proxy-groups"].at(-1).filter, "u");
  const hits = base.proxies.map((p) => p.name).filter((s) => re.test(s));
  assert.deepStrictEqual(hits, [NODE]);
  assert.ok(!re.test("前缀" + NODE));
});
t("重复应用幂等", () => { const f = load(NODE); assert.deepStrictEqual(f(f(base)), f(base)); });
t("provider 订阅（无 inline 节点）放行", () => {
  const out = load("JP-01")({ "mixed-port": 7897, "proxy-providers": { sub: { type: "http", url: "https://x" } }, "proxy-groups": [], rules: [] });
  assert.ok(out["proxy-groups"].find((x) => x.name === "CC-VM-FIXED"));
});
const throws = (name, node, cfg, re) => t(name, () => assert.throws(() => load(node)(cfg), re));
throws("未修改 NODE → 报错", "REPLACE_WITH_EXACT_NODE_NAME", base, /NODE/);
throws("NODE 是策略组 → 报错", "自动选择", base, /策略组/);
throws("NODE 是内置策略 → 报错", "DIRECT", base, /内置/);
throws("NODE 是 direct 类型伪节点 → 报错", "直连伪节点", base, /direct/);
throws("节点不存在且无 provider → 报错", "不存在", base, /找不到/);
throws("与 mixed-port 冲突 → 报错", NODE, { ...base, "mixed-port": 17897 }, /冲突/);
throws("与其他 listener 端口冲突 → 报错", NODE, { ...base, listeners: [{ name: "x", type: "socks", port: 17897 }] }, /占用/);
throws("节点名含反引号 → 报错", "a`b", base, /反引号/);

// Clash Verge Rev 2.5.10 在脚本之后执行 cleanup_proxy_groups：只会修剪 use/proxies 里不存在的名字。
t("CVR cleanup_proxy_groups 不会改动 CC-VM-FIXED（组内无 use/proxies 字段）", () => {
  const g = load(NODE)(base)["proxy-groups"].at(-1);
  assert.ok(!("use" in g) && !("proxies" in g));
});
console.log(`${n} tests passed`);
