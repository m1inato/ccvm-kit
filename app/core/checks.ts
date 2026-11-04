// 纯函数，界面（沙盒里的渲染进程）也会用，不能引入 Node 模块。
import type { CheckEvent } from './types';

/** 同一个 id 可能出现多次（例如 setup 内的子脚本）；取最后一次结论 */
export function latestChecks(checks: CheckEvent[]): Map<string, CheckEvent> {
  const map = new Map<string, CheckEvent>();
  for (const c of checks) {
    map.delete(c.id);
    map.set(c.id, c);
  }
  return map;
}

/** 从 git clone 等输出里取最后一个百分比 */
export function lastPercent(log: string): number | undefined {
  const matches = log.match(/(\d{1,3})%/g);
  if (!matches) return undefined;
  const n = Number(matches[matches.length - 1].replace('%', ''));
  return n >= 0 && n <= 100 ? n : undefined;
}
