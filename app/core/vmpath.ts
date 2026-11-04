// VM 路径的规则（纯函数，界面和主进程都能用）。和 files.sh 的宿主端校验一致；最终以脚本为准。

/** /home/cc 下，没有 .. 段和换行 */
export function vmPathProblem(p: string): string {
  if (/[\n\r\0]/.test(p)) return 'VM 路径里不能有换行';
  if (p !== '/home/cc' && !p.startsWith('/home/cc/')) return `只能访问 /home/cc 下面：${p}`;
  if (`${p}/`.includes('/../')) return `VM 路径里不能有 ..：${p}`;
  return '';
}

/** /home/cc/mac 下面是 Mac 上的真实文件 */
export function isMacPath(p: string): boolean {
  return p === '/home/cc/mac' || p.startsWith('/home/cc/mac/');
}
