// 資源の画面のモックの中身（2026-10-09、Fork「資源の逼迫」）。本物では host が 10 秒ごとに、
// コンテナの cgroup のファイル（memory.current・memory.stat・*.pressure・pids）と /proc を直接読んで作る。
//
// 状態は `?resources-demo=<状態>` で切り替える（画面の隅のデモ用の切り替え）。

export type ResourcesDemo = "calm" | "project" | "host" | "stall";

export const RESOURCES_DEMO_STATES: ReadonlyArray<{ id: ResourcesDemo; label: string }> = [
  { id: "calm", label: "空いている" },
  { id: "project", label: "1つの Project が混んでいる" },
  { id: "host", label: "この機械全体が混んでいる" },
  { id: "stall", label: "banto 本体が止まった直後" },
];

export const GB = 1024 ** 3;
export const MB = 1024 ** 2;

/** 混み具合（PSI）。avg10＝直近10秒のうち待たされていた時間の割合（%） */
export interface Waiting {
  cpu: number;
  memory: number;
  io: number;
}

export type Busy = "calm" | "busy";

/** 内訳の1行（何がどれだけ使っているか） */
export interface Consumer {
  name: string;
  /** 補足（コマンドの頭・サブエージェントの頼んだこと） */
  detail?: string;
  bytes: number;
}

/** 内訳のまとまり。色は種類で決まる */
export interface ConsumerGroup {
  id: "modules" | "work" | "commands" | "services" | "nested";
  label: string;
  items: readonly Consumer[];
}

export interface ProjectResources {
  projectId: string;
  name: string;
  initial: string;
  busy: Busy;
  /** なぜ混んでいると判断したか（人が読む1行） */
  busyReason?: string;
  usedBytes: number;
  /** 戻せるキャッシュ（ファイルの読み込みなど。足りなくなれば捨てられる） */
  cacheBytes: number;
  limitBytes: number;
  cpuLimit: number;
  /** 直近10秒で使った CPU（コア数） */
  cpuUsed: number;
  waiting: Waiting;
  processes: number;
  processLimit: number;
  groups: readonly ConsumerGroup[];
  /** 上限に当たって止められた・断られた記録（新しい順） */
  hits: ReadonlyArray<{ at: string; what: string }>;
}

export interface HostResources {
  busy: Busy;
  busyReason?: string;
  totalBytes: number;
  cores: number;
  waiting: Waiting;
  /** この機械のメモリの使い道（Project のコンテナ・banto 本体・incusd・その他） */
  memory: ReadonlyArray<{ id: string; label: string; bytes: number; projectId?: string }>;
  /** banto 本体の止まり（新しい順） */
  stalls: ReadonlyArray<{ at: string; seconds: number }>;
}

export interface ResourcesSnapshot {
  measuredAt: string;
  host: HostResources;
  projects: readonly ProjectResources[];
}

const BANTO_GROUPS_BUSY: readonly ConsumerGroup[] = [
  {
    id: "modules",
    label: "Module",
    items: [
      { name: "subagent", bytes: 135 * MB },
      { name: "repositories", bytes: 105 * MB },
      { name: "vault-directory", bytes: 103 * MB },
      { name: "backlog", bytes: 93 * MB },
      { name: "shell", bytes: 89 * MB },
      { name: "filesystem", bytes: 76 * MB },
      { name: "service", bytes: 61 * MB },
    ],
  },
  {
    id: "work",
    label: "AI の仕事",
    items: [
      { name: "サブエージェント（Claude Code）", detail: "E2E の仕組みを見直す——Fable のレビュー", bytes: 1.9 * GB },
      { name: "サブエージェント（Claude Code）", detail: "Terminal の Module を実装する", bytes: 1.4 * GB },
      { name: "ブラウザ（Chromium）", detail: "サブエージェントが開いたもの・3 本", bytes: 0.5 * GB },
    ],
  },
  {
    id: "commands",
    label: "コマンド",
    items: [
      { name: "npx playwright test", detail: ".worktrees/e2e-parallel/banto/e2e", bytes: 2.6 * GB },
      { name: "node start-core.ts", detail: "E2E の試験用 banto", bytes: 0.4 * GB },
    ],
  },
  {
    id: "services",
    label: "Service",
    items: [
      { name: "mock", detail: "npx next dev -p 4173", bytes: 0.6 * GB },
      { name: "demo-web", detail: "python3 -m http.server 8766", bytes: 30 * MB },
    ],
  },
  {
    id: "nested",
    label: "入れ子のコンテナ",
    items: [
      { name: "banto-c7e64db6…", detail: "E2E が立てた Project のコンテナ", bytes: 0.34 * GB },
      { name: "banto-cda1a831…", detail: "E2E が立てた Project のコンテナ", bytes: 0.34 * GB },
      { name: "banto-instance-4e9d…", detail: "E2E が立てた banto 全体用のコンテナ", bytes: 0.14 * GB },
    ],
  },
];

const BANTO_GROUPS_CALM: readonly ConsumerGroup[] = [
  BANTO_GROUPS_BUSY[0]!,
  {
    id: "work",
    label: "AI の仕事",
    items: [{ name: "サブエージェント（Claude Code）", detail: "E2E の仕組みを見直す——Fable のレビュー", bytes: 0.9 * GB }],
  },
  { id: "commands", label: "コマンド", items: [] },
  BANTO_GROUPS_BUSY[3]!,
  { id: "nested", label: "入れ子のコンテナ", items: [] },
];

const HOME_GROUPS: readonly ConsumerGroup[] = [
  {
    id: "modules",
    label: "Module",
    items: [
      { name: "shell", bytes: 82 * MB },
      { name: "filesystem", bytes: 70 * MB },
      { name: "service", bytes: 58 * MB },
    ],
  },
  { id: "work", label: "AI の仕事", items: [] },
  { id: "commands", label: "コマンド", items: [] },
  {
    id: "services",
    label: "Service",
    items: [
      { name: "home-assistant", detail: "python -m homeassistant", bytes: 0.7 * GB },
      { name: "mosquitto", detail: "mosquitto -c mosquitto.conf", bytes: 12 * MB },
    ],
  },
  { id: "nested", label: "入れ子のコンテナ", items: [] },
];

const HERMES_GROUPS: readonly ConsumerGroup[] = [
  {
    id: "modules",
    label: "Module",
    items: [
      { name: "shell", bytes: 80 * MB },
      { name: "filesystem", bytes: 69 * MB },
    ],
  },
  { id: "work", label: "AI の仕事", items: [] },
  { id: "commands", label: "コマンド", items: [{ name: "python3 bench.py", detail: "--rounds 200", bytes: 3.1 * GB }] },
  { id: "services", label: "Service", items: [] },
  { id: "nested", label: "入れ子のコンテナ", items: [] },
];

function sum(groups: readonly ConsumerGroup[]): number {
  return groups.reduce((a, g) => a + g.items.reduce((b, i) => b + i.bytes, 0), 0);
}

function project(
  base: Omit<ProjectResources, "usedBytes">,
): ProjectResources {
  return { ...base, usedBytes: sum(base.groups) };
}

export function getResourcesSnapshot(demo: ResourcesDemo): ResourcesSnapshot {
  const bantoBusy = demo === "project" || demo === "host";
  const hermesBusy = demo === "host";
  const banto = project({
    projectId: "banto",
    name: "banto",
    initial: "b",
    busy: bantoBusy ? "busy" : "calm",
    busyReason: bantoBusy ? "メモリが上限の 9 割を超え、CPU の空きを待つ時間が 41%" : undefined,
    cacheBytes: bantoBusy ? 0.8 * GB : 2.1 * GB,
    limitBytes: 12.5 * GB,
    cpuLimit: 3,
    cpuUsed: bantoBusy ? 2.9 : 0.4,
    waiting: bantoBusy ? { cpu: 41, memory: 18, io: 10 } : { cpu: 2, memory: 0, io: 1 },
    processes: bantoBusy ? 1045 : 212,
    processLimit: 8192,
    groups: bantoBusy ? BANTO_GROUPS_BUSY : BANTO_GROUPS_CALM,
    hits: bantoBusy
      ? [
          { at: "10:22", what: "メモリの上限で、ブラウザ（Chromium）が止められました" },
          { at: "9:58", what: "メモリの上限で、入れ子のコンテナの node が止められました" },
        ]
      : [],
  });
  const home = project({
    projectId: "home",
    name: "自宅サーバ",
    initial: "自",
    busy: "calm",
    cacheBytes: 0.3 * GB,
    limitBytes: 12.5 * GB,
    cpuLimit: 3,
    cpuUsed: 0.1,
    waiting: { cpu: 0, memory: 0, io: 0 },
    processes: 64,
    processLimit: 8192,
    groups: HOME_GROUPS,
    hits: [],
  });
  const hermes = project({
    projectId: "hermes",
    name: "記憶の検証",
    initial: "記",
    busy: hermesBusy ? "busy" : "calm",
    busyReason: hermesBusy ? "CPU の空きを待つ時間が 33%" : undefined,
    cacheBytes: 0.2 * GB,
    limitBytes: 12.5 * GB,
    cpuLimit: 3,
    cpuUsed: hermesBusy ? 2.7 : 0.05,
    waiting: hermesBusy ? { cpu: 33, memory: 2, io: 0 } : { cpu: 0, memory: 0, io: 0 },
    processes: 41,
    processLimit: 8192,
    groups: hermesBusy ? HERMES_GROUPS : [HERMES_GROUPS[0]!, ...HERMES_GROUPS.slice(1).map((g) => ({ ...g, items: [] }))],
    hits: [],
  });

  const projects = [banto, home, hermes];
  const hostBusy = demo === "host";
  const containers = projects.map((p) => ({
    id: `p-${p.projectId}`,
    label: p.name,
    bytes: p.usedBytes,
    projectId: p.projectId,
  }));
  return {
    measuredAt: "10:41:20",
    host: {
      busy: hostBusy ? "busy" : "calm",
      busyReason: hostBusy ? "空いているメモリが 0.9 GB、CPU の空きを待つ時間が 58%" : undefined,
      totalBytes: 16 * GB,
      cores: 4,
      waiting: hostBusy ? { cpu: 58, memory: 21, io: 12 } : bantoBusy ? { cpu: 22, memory: 3, io: 4 } : { cpu: 3, memory: 0, io: 1 },
      memory: [
        ...containers,
        { id: "banto", label: "banto 本体", bytes: 0.3 * GB },
        { id: "incusd", label: "Incus", bytes: 0.4 * GB },
        { id: "other", label: "その他（OS・Caddy 等）", bytes: 1.1 * GB },
      ],
      stalls:
        demo === "stall"
          ? [
              { at: "10:41", seconds: 12.3 },
              { at: "10:38", seconds: 1.4 },
            ]
          : demo === "host"
            ? [{ at: "10:39", seconds: 2.1 }]
            : [],
    },
    projects,
  };
}

/** サイドバーの印：混んでいる Project（モックの既定は「1つの Project が混んでいる」） */
export function isProjectBusy(projectId: string, demo: ResourcesDemo): boolean {
  return getResourcesSnapshot(demo).projects.some((p) => p.projectId === projectId && p.busy === "busy");
}

export function isHostBusy(demo: ResourcesDemo): boolean {
  return getResourcesSnapshot(demo).host.busy === "busy";
}

export function parseResourcesDemo(value: string | null): ResourcesDemo {
  return RESOURCES_DEMO_STATES.some((s) => s.id === value) ? (value as ResourcesDemo) : "project";
}
