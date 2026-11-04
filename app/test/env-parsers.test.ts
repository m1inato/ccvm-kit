import { describe, expect, it } from 'vitest';
import { hasProxyVariables, limaEnv, parseLoginPath, scriptEnv, shQuote, PATH_MARK_END, PATH_MARK_START } from '../core/env';
import { gitUrlProblem, isIPv4, parseLimaList, projectNameFromUrl, renderClashScript } from '../core/parsers';

const settings = { vmName: 'ccvm', limaHome: '/x/.lima-ccvm', stateDir: '/x/state' };

describe('script environment', () => {
  it('never carries proxy variables, whatever the App was started with', () => {
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7897';
    process.env.no_proxy = '*';
    const env = scriptEnv({ path: '/usr/bin:/bin', home: '/x', user: 'me', settings });
    expect(hasProxyVariables(env)).toBe(false);
    expect(hasProxyVariables(limaEnv({ path: '/usr/bin', home: '/x', user: 'me', settings }))).toBe(false);
    expect(Object.keys(env).sort()).toEqual(['CCVM_LIMA_HOME', 'CCVM_NAME', 'CCVM_STATE_DIR', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'USER']);
    expect(limaEnv({ path: '/usr/bin', home: '/x', user: 'me', settings }).LIMA_HOME).toBe('/x/.lima-ccvm');
    delete process.env.HTTPS_PROXY;
    delete process.env.no_proxy;
  });
  it('takes only PATH from the login shell output', () => {
    const out = `Welcome!\nexport HTTPS_PROXY=x\n${PATH_MARK_START}/opt/homebrew/bin:relative:/usr/bin${PATH_MARK_END}`;
    const p = parseLoginPath(out).split(':');
    expect(p[0]).toBe('/opt/homebrew/bin');
    expect(p).not.toContain('relative');
    expect(p).toContain('/bin');
    expect(new Set(p).size).toBe(p.length);
    expect(parseLoginPath(undefined)).toContain('/usr/local/bin');
  });
  it('shell-quotes paths with spaces and quotes', () => {
    expect(shQuote("/Volumes/a b/it's")).toBe(`'/Volumes/a b/it'\\''s'`);
  });
});

describe('git url', () => {
  it('accepts the three supported forms', () => {
    for (const u of ['https://github.com/you/my-api.git', 'git@github.com:you/my-api.git', 'ssh://git@example.com:2222/t/my-api'])
      expect(gitUrlProblem(u), u).toBeNull();
    expect(projectNameFromUrl('git@github.com:you/my-api.git')).toBe('my-api');
    expect(projectNameFromUrl('https://github.com/you/web-app/')).toBe('web-app');
  });
  it('rejects credentials, other transports and shell metacharacters', () => {
    for (const u of ['https://tok@github.com/a/b', 'https://u:p@github.com/a/b', 'ext::sh -c id', 'file:///etc', 'https://github.com/a/b;id', 'https://github.com/a/$(id)', '--upload-pack=x', ''])
      expect(gitUrlProblem(u), u).not.toBeNull();
  });
});

describe('lima list', () => {
  it('finds the configured instance', () => {
    const out = '{"name":"default","status":"Running"}\n{"name":"ccvm","status":"Stopped","cpus":4,"memory":6442450944,"disk":64424509440,"arch":"aarch64"}\n';
    expect(parseLimaList(out, 'ccvm')).toEqual({ name: 'ccvm', status: 'Stopped', cpus: 4, memoryBytes: 6442450944, diskBytes: 64424509440, arch: 'aarch64' });
    expect(parseLimaList(out, 'other').status).toBe('Missing');
    expect(parseLimaList('garbage', 'ccvm').status).toBe('Missing');
  });
});

describe('clash script', () => {
  const template = 'const NODE = "REPLACE_WITH_EXACT_NODE_NAME";\nconst PORT = 17897;\n';
  it('fills the node name as a JS string literal', () => {
    const r = renderClashScript(template, ' 🇯🇵 示例节点 "01" ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.script).toContain('const NODE = "🇯🇵 示例节点 \\"01\\"";');
  });
  it('refuses builtin policies, backticks and empty names', () => {
    for (const n of ['', 'DIRECT', 'reject', 'a`b', 'a\nb']) expect(renderClashScript(template, n).ok, n).toBe(false);
  });
});

it('isIPv4', () => {
  expect(isIPv4('203.0.113.7')).toBe(true);
  for (const v of ['256.1.1.1', '1.2.3', '1.2.3.4 ', '::1', undefined]) expect(isIPv4(v)).toBe(false);
});
