// Clash Verge Rev 订阅「扩展脚本」(Script)。
// 先复制为 clash-verge-script.local.js，再在本地副本中修改 NODE。
// 若该订阅已有 main()：保留原 main，把 `config = ccvmPatch(config);` 加到原 main 的 return 之前，
// 并删除本文件末尾的 main()（整个脚本只能有一个 main）。
//
// 效果：
//   1. 新增回环监听 127.0.0.1:17897（mixed，仅 TCP），入站流量直接交给 CC-VM-FIXED，
//      不经过订阅规则，也不受「规则/全局/直连」模式影响。
//   2. CC-VM-FIXED 只包含名字与 NODE 完全相同的那个节点（普通订阅、proxy-providers 都适用）；
//      节点不存在时自动变成 REJECT，绝不会落到 DIRECT。

const NODE = "REPLACE_WITH_EXACT_NODE_NAME";

const PORT = 17897;
const GROUP = "CC-VM-FIXED";
const LISTENER = "cc-vm-in";

function ccvmPatch(config) {
  const fail = (msg) => { throw new Error("[ccvm] " + msg); };

  if (!NODE || NODE === "REPLACE_WITH_EXACT_NODE_NAME") fail("请先把 NODE 改成一个具体节点的完整名称");
  if (NODE.includes("`")) fail("节点名包含反引号，mihomo 的 filter 无法精确匹配，请换一个节点");
  if (["DIRECT", "REJECT", "REJECT-DROP", "PASS", "COMPATIBLE", "GLOBAL"].includes(NODE.toUpperCase())) {
    fail("NODE 不能是内置策略");
  }

  const groups = Array.isArray(config["proxy-groups"]) ? config["proxy-groups"] : [];
  if (groups.some((g) => g && g.name === NODE)) fail("NODE 是策略组名，必须填写具体节点");

  const inline = (Array.isArray(config.proxies) ? config.proxies : []).find((p) => p && p.name === NODE);
  if (inline && ["direct", "reject", "dns", "pass", "compatible"].includes(String(inline.type).toLowerCase())) {
    fail("NODE 指向的是 " + inline.type + " 类型，不是代理节点");
  }
  const hasProviders = config["proxy-providers"] && Object.keys(config["proxy-providers"]).length > 0;
  if (!inline && !hasProviders) fail("当前订阅里找不到节点「" + NODE + "」，检查拼写（含 emoji/空格）");

  for (const key of ["port", "socks-port", "mixed-port", "redir-port", "tproxy-port"]) {
    if (Number(config[key]) === PORT) fail("端口 " + PORT + " 与 " + key + " 冲突");
  }
  const listeners = (Array.isArray(config.listeners) ? config.listeners : []).filter((l) => l && l.name !== LISTENER);
  if (listeners.some((l) => Number(l.port) === PORT)) fail("端口 " + PORT + " 已被其他 listener 占用");

  // mihomo 使用 .NET 风格正则（regexp2）；转义元字符后做整名精确匹配
  const exact = "^" + NODE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";

  config["proxy-groups"] = groups.filter((g) => !g || g.name !== GROUP).concat([{
    name: GROUP,
    type: "select",
    "include-all": true,        // 同时搜索 proxies 与所有 proxy-providers
    filter: exact,              // 只留下同名节点
    "empty-fallback": "REJECT", // 一个都匹配不到 → REJECT（mihomo 默认是 COMPATIBLE，相当于直连）
  }]);

  config.listeners = listeners.concat([{
    name: LISTENER,
    type: "mixed",
    listen: "127.0.0.1",
    port: PORT,
    udp: false,
    proxy: GROUP,
  }]);

  return config;
}

function main(config, profileName) {
  return ccvmPatch(config);
}
