// 主进程与界面共用的类型。界面只拿到 Snapshot，自己不做安全判断。
import type { CoreStatus, PinnedNode } from './egress';
import type { CoreConnection, NodeInfo } from './mihomo';

export type { CoreConnection, CoreStatus, NodeInfo, PinnedNode };

export type Level = 'ok' | 'busy' | 'idle' | 'error';

export interface CheckEvent {
  id: string;
  ok: boolean;
  msg: string;
}

export interface ProjectItem {
  name: string;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  updated: number;
  subject: string;
  remote: string;
  claude_sessions: number;
  claude_since: number;
}

/** cc 的一个 tmux 会话 */
export interface SessionItem {
  name: string;
  created: number;
  attached: number;
  project: string;
}

/** share.sh status 列出的一个共享文件夹（名字只由脚本算出） */
export interface ShareItem {
  path: string;
  name: string;
  mount_point: string;
  view: string;
  /** 为空表示可以共享 */
  problem: string;
}

/** files.sh list 列出的一个条目（类型字段叫 file_type：事件自己的 type 已经是 item） */
export interface FileItem {
  name: string;
  file_type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mtime: number;
}

export interface FileListing {
  /** VM 里解析后的真实路径 */
  path: string;
  entries: FileItem[];
  truncated?: number;
}

/** hook 记下的一条 Claude 事件（内容来自 VM，只用于显示） */
export interface ClaudeEvent {
  t: number;
  event: 'Stop' | 'Notification';
  project: string;
  notification: string;
  message: string;
}

export type ScriptEvent =
  | { v: 1; type: 'start'; script: string; kit: string }
  | { v: 1; type: 'step'; id: string; msg: string }
  | { v: 1; type: 'check'; id: string; ok: boolean; msg: string }
  | { v: 1; type: 'value'; key: string; value: string }
  | ({ v: 1; type: 'item'; kind: 'project' } & ProjectItem)
  | ({ v: 1; type: 'item'; kind: 'session' } & SessionItem)
  | ({ v: 1; type: 'item'; kind: 'claude_event' } & ClaudeEvent)
  | ({ v: 1; type: 'item'; kind: 'share' } & ShareItem)
  | ({ v: 1; type: 'item'; kind: 'file' } & FileItem)
  | { v: 1; type: 'log'; level: 'info' | 'warn' | 'detail'; msg: string }
  | { v: 1; type: 'error'; msg: string }
  | { v: 1; type: 'end'; ok: boolean; code: number };

/** 一次脚本运行的结论。ok 只有在 docs/events.md 的全部条件都满足时才为 true。 */
export interface RunResult {
  script: string;
  args: string[];
  startedAt: number;
  finishedAt: number;
  exitCode: number | null;
  ok: boolean;
  /** ok 为 false 时，一句话说明为什么（脚本原话优先） */
  reason?: string;
  checks: CheckEvent[];
  values: Record<string, string>;
  items: ProjectItem[];
  sessions: SessionItem[];
  claudeEvents: ClaudeEvent[];
  shares: ShareItem[];
  files: FileItem[];
  steps: { id: string; msg: string }[];
  errors: string[];
  logs: { level: string; msg: string }[];
  parseErrors: number;
  stderrTail: string;
}

/** 保存下来的一次检查（快速检查、完整验收、断流测试、部署前检查） */
export interface CheckRecord {
  kind: 'quick' | 'full' | 'leak' | 'preflight';
  at: number;
  ok: boolean;
  reason?: string;
  checks: CheckEvent[];
  values: Record<string, string>;
}

export interface Project {
  name: string;
  branch: string;
  dirty: number;
  ahead: number;
  behind: number;
  updated: number;
  subject: string;
  remote: string;
  claudeSessions: number;
  claudeSince: number;
}

export type VmStatus = 'Running' | 'Stopped' | 'Missing' | 'Unknown' | string;

export interface VmInfo {
  name: string;
  status: VmStatus;
  cpus?: number;
  memoryBytes?: number;
  diskBytes?: number;
  arch?: string;
  /** limactl 读不到时的原因 */
  error?: string;
}

export type JobKind = 'setup' | 'check-full' | 'leaktest' | 'clone' | 'vm-start' | 'vm-stop' | 'shares' | 'push' | 'pull';
export type JobState = 'running' | 'done' | 'failed' | 'cancelled';

export interface JobSummary {
  id: string;
  kind: JobKind;
  title: string;
  args: string[];
  state: JobState;
  startedAt: number;
  finishedAt?: number;
  /** 当前步骤（来自 step 事件）或进度百分比（来自 git 输出） */
  step?: string;
  stepId?: string;
  percent?: number;
  reason?: string;
  /** 结束后的完整结论；运行中为空 */
  result?: RunResult;
}

export type IssueKind =
  | 'egress_changed'
  | 'listener_down'
  | 'tun_down'
  | 'lockdown'
  | 'lima_config'
  | 'leak_failed'
  | 'check_failed'
  | 'check_incomplete'
  | 'core_missing'
  | 'core_down'
  | 'core_conflict'
  | 'node_changed';

export interface Issue {
  /** 同一个问题的稳定键；同一个键只通知一次，消失后再出现才再通知 */
  key: string;
  kind: IssueKind;
  title: string;
  detail: string;
  checkId?: string;
  data?: Record<string, string>;
}

export type EgressMode = 'clash-verge' | 'builtin';
export type TerminalApp = 'Terminal' | 'iTerm' | 'Ghostty';
export const TERMINAL_APPS: TerminalApp[] = ['Terminal', 'iTerm', 'Ghostty'];

/** 命令行入口 ~/.local/bin/ccvm 的状态 */
export interface CliStatus {
  path: string;
  /** 文件存在 */
  installed: boolean;
  /** 存在而且是 CCVM 生成的（App 会自动更新它）；存在但不是时 App 不覆盖 */
  generated: boolean;
  /** 登录 shell 的 PATH 里有它所在的目录 */
  onPath: boolean;
  /** 不在 PATH 里时，建议加到 ~/.zshrc 的一行 */
  hint: string;
}

export interface Settings {
  vmName: string;
  limaHome: string;
  stateDir: string;
  checkIntervalMin: number;
  showCapsule: boolean;
  terminalApp: TerminalApp;
  launchAtLogin: boolean;
  egressMode: EgressMode;
  /** Clash Verge 模式下专用入口固定走的节点名（不是秘密，只用来生成扩展脚本） */
  nodeName: string;
  claudeLoginConfirmed: boolean;
  welcomeDone: boolean;
  /** 「Claude 做完了」字幕：VM 里装了 managed-settings hook */
  hooksEnabled: boolean;
  /** 想共享给 VM 的 Mac 文件夹（读写）。只能经 add/removeSharedFolder 改，应用后才写进 shares.txt */
  sharedFolders: string[];
  /** 总开关「允许 VM 访问共享文件夹」。关着时应用会写空的 shares.txt */
  sharesEnabled: boolean;
}

export interface SharesState {
  /** 最近一次 share.sh status：shares.txt 里（也就是应用过的）共享 */
  applied: { path: string; name: string; view: string }[];
  /** 设置和 shares.txt 的内容不一致，需要「应用并重启 VM」 */
  pendingApply: boolean;
  /** 路径 → 不能共享的原因（脚本的结论优先，没跑过脚本的用界面即时提示） */
  problems: Record<string, string>;
}

export interface Caption {
  id: number;
  at: number;
  level: Level;
  text: string;
  /** 出错字幕一直显示到问题消失；其他字幕几秒后淡掉 */
  sticky: boolean;
  issueKey?: string;
  /** Claude 事件字幕对应的项目：胶囊上给出「回到终端」 */
  project?: string;
}

export interface Snapshot {
  level: Level;
  headline: string;
  detail: string;
  egress: { host?: string; vm?: string; baseline?: string };
  vm: VmInfo;
  lastQuick?: CheckRecord;
  lastFull?: CheckRecord;
  lastLeak?: CheckRecord;
  lastPreflight?: CheckRecord;
  /** 最近一次检查（快速或完整，取较新的） */
  lastCheckAt?: number;
  checking: boolean;
  issues: Issue[];
  newSessionsBlocked: boolean;
  jobs: JobSummary[];
  projects: Project[];
  sessions: SessionItem[];
  projectsAt?: number;
  projectsError?: string;
  claude: { installed?: boolean; version?: string; checkedAt?: number };
  /** 自带出口核心的状态（只在自带核心模式下刷新） */
  core?: CoreStatus;
  captions: Caption[];
  shares: SharesState;
  /** 手动验收矩阵：项目 id → 勾选时间 */
  matrix: Record<string, number>;
  settings: Settings;
  paths: { kit: string; state: string; baselineFile: string; jobs: string };
  kitVersion: string;
  appVersion: string;
}

/** 界面能请求的动作。主进程按白名单逐个校验参数。 */
export interface Actions {
  quickCheck(): Promise<void>;
  fullCheck(): Promise<string>;
  leaktest(): Promise<string>;
  setup(): Promise<string>;
  vmStart(): Promise<string>;
  vmStop(): Promise<string>;
  cancelJob(id: string): Promise<void>;
  jobLog(id: string): Promise<string>;
  refreshProjects(): Promise<void>;
  clone(url: string): Promise<string>;
  refreshClaude(): Promise<void>;
  preflight(): Promise<CheckRecord>;
  previewRebaseline(): Promise<RunResult>;
  acceptRebaseline(ip: string): Promise<RunResult | null>;
  openTerminal(project?: string): Promise<void>;
  openAdminShell(): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  chooseStateDir(): Promise<Settings | null>;
  clashScript(node: string): Promise<{ ok: boolean; script?: string; error?: string }>;
  copyText(text: string): Promise<void>;
  exportReport(): Promise<string | null>;
  openMain(route?: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  dismissCaption(id: number): Promise<void>;
  setMatrix(id: string, done: boolean): Promise<void>;
  /** 切换出网方式；主进程先弹系统对话框确认，取消时返回 null */
  setEgressMode(mode: EgressMode): Promise<Settings | null>;
  setSubscription(url: string): Promise<NodeInfo[]>;
  updateSubscription(): Promise<{ changed: boolean; detail?: string }>;
  /** 选定节点（或确认节点变化）；换节点时主进程会弹系统对话框，取消时返回 null */
  selectNode(name: string): Promise<PinnedNode | null>;
  restartCore(): Promise<void>;
  removeCore(): Promise<boolean>;
  clearSubscription(): Promise<void>;
  setCoreOptions(opts: { autoUpdate?: boolean; viaClashVerge?: boolean }): Promise<void>;
  coreConnections(): Promise<CoreConnection[]>;
  latencyTest(): Promise<Record<string, number | null>>;
  refreshCore(): Promise<void>;
  killSession(name: string): Promise<boolean>;
  setHooks(enabled: boolean): Promise<Settings>;
  cliStatus(): Promise<CliStatus>;
  /** 主进程弹出选文件夹的对话框；取消时返回 null */
  addSharedFolder(): Promise<Settings | null>;
  removeSharedFolder(path: string): Promise<Settings>;
  setSharesEnabled(on: boolean): Promise<Settings>;
  /** 主进程先弹系统对话框说明风险；确认后写 shares.txt 并启动后台任务（会重启 VM）。取消时返回 null */
  applyShares(): Promise<string | null>;
  listFiles(path: string): Promise<FileListing>;
  makeDir(path: string): Promise<void>;
  /** 主进程先确认（/home/cc/mac 下额外警告）；取消时返回 false */
  removePath(path: string): Promise<boolean>;
  /** 每个路径一个后台任务；返回任务 id */
  pushPaths(paths: string[], destDir: string): Promise<string[]>;
  /** 主进程弹出选文件 / 文件夹的对话框，再上传；取消时返回空数组 */
  chooseUpload(destDir: string, folders: boolean): Promise<string[]>;
  /** 主进程弹保存对话框，再启动后台任务；取消时返回 null */
  pullFile(vmPath: string): Promise<string | null>;
  /** 生成 ~/.local/bin/ccvm（0755，不需要管理员权限） */
  installCli(): Promise<CliStatus>;
}
