// 実行場所（決定・2026-10-08、ユーザー。`docs/specs/v4-security.md` §1「Project の実行場所——別のサーバ」、Backlog の remote-runtime-registry）。
//
// - Project を、この機械のコンテナではなく、SSH で入る別のサーバで動かせる。サーバ丸ごとがその Project の箱になる
// - banto 全体の設定に一覧を持ち、Project を作るときに選ぶ（既定はこの機械のコンテナ）。あとからは変えない
// - **最初の版は1つの実行場所に Project は1つ**（2026-10-08、ユーザー）——同じ SSH ユーザーで動くと Service どうしが壊し合う
// - 鍵は Vault の SSH 鍵（alias の名前だけを持つ）。初めて繋ぐときは host 鍵の指紋を人が確かめて覚える。以後、違えば繋がない
// - 繋いだとき・Module を起こす前に前提を確かめる。足りなければ名指しして直し方を添えて断る。linger が無いのは断らず注意
//
// モックなので SSH はしない。「繋いで確かめる」の結果は宛先の名前で決めた固定の筋書き（`probeRuntime`）
import { useSyncExternalStore } from "react";
import { getAllProjects } from "./projects";
import { notifyMockStoreChange, subscribeMockStore } from "./store-events";

/** この機械のコンテナ（既定）。Project の `runtimeId` が無いものはこれ */
export const HOST_CONTAINER = "host-container";

/** 前提の1項目の結果。fail は断る、warn は使えるが注意を出す */
export interface RuntimeCheck {
  label: string;
  status: "ok" | "warn" | "fail";
  /** fail・warn のときの説明と直し方（向こうで人が打つコマンド） */
  detail?: string;
  fix?: string;
}

export interface MockRuntime {
  id: string;
  /** 一覧と選ぶ画面に出す名前 */
  name: string;
  host: string;
  user: string;
  port: number;
  /** Vault の SSH 鍵の alias（値は持たない） */
  keyAlias: string;
  /** 向こうの置き場の根 */
  dataRoot: string;
  /** 覚えた host 鍵の指紋。無ければまだ確かめていない */
  hostKey?: { type: string; fingerprint: string; confirmedAt: string };
  /** 前に覚えた鍵と違う指紋が返ってきた（繋がない） */
  hostKeyMismatch?: { type: string; fingerprint: string };
  /** 最後に確かめた前提 */
  checks?: RuntimeCheck[];
  checkedAt?: string;
}

const OK_CHECKS: RuntimeCheck[] = [
  { label: "CPU の種類と libc（x86_64・glibc）が banto と同じ", status: "ok" },
  { label: "ログインしたときに何も出力しない", status: "ok" },
  { label: "道具（git・ssh・curl・tar）", status: "ok" },
  { label: "ユーザーの systemd（/run/user/1001/bus）", status: "ok" },
  { label: "SSH を閉じても動き続ける設定（linger）", status: "ok" },
  { label: "置き場に書ける", status: "ok" },
  { label: "SSH の転送が許されている・同時に開ける数（MaxSessions 10）", status: "ok" },
];

let runtimes: MockRuntime[] = [
  {
    id: "rt.home-lab",
    name: "home-lab",
    host: "192.168.1.60",
    user: "banto",
    port: 22,
    keyAlias: "home-lab-ssh",
    dataRoot: "~/.local/share/banto-remote",
    hostKey: { type: "ED25519", fingerprint: "SHA256:q3Vt8m0Yb1kFQ2eWJp7nLx9cR4uZsA6dHgT5oKiE0Nw", confirmedAt: "2026-10-08" },
    checks: [
      ...OK_CHECKS,
      { label: "Docker（containerlab）", status: "ok" },
    ],
    checkedAt: "3分前",
  },
  {
    id: "rt.gpu-box",
    name: "gpu-box",
    host: "gpu-box.lan",
    user: "banto",
    port: 22,
    keyAlias: "gpu-box-ssh",
    dataRoot: "~/.local/share/banto-remote",
    hostKey: { type: "ED25519", fingerprint: "SHA256:Lm4pQ8wZr2Tn6Ys0Vx3bKc9Hd1Fg7Je5Ua8Oi2Pk4Ro", confirmedAt: "2026-10-09" },
    checks: OK_CHECKS.map((c) =>
      c.label.startsWith("SSH を閉じても")
        ? {
            ...c,
            status: "warn",
            detail: "SSH の接続を閉じると、Service と裏で流したコマンドが止まります。",
            fix: "sudo loginctl enable-linger banto",
          }
        : c,
    ),
    checkedAt: "昨日",
  },
  {
    id: "rt.old-dev",
    name: "old-dev",
    host: "192.168.1.73",
    user: "banto",
    port: 22,
    keyAlias: "old-dev-ssh",
    dataRoot: "~/.local/share/banto-remote",
    hostKey: { type: "ED25519", fingerprint: "SHA256:3xKpN7cVb0Wq5Lr8Ty1Ua4Zs6Gd9Hf2Je0Mi7Oo3Pq", confirmedAt: "2026-09-30" },
    hostKeyMismatch: { type: "ED25519", fingerprint: "SHA256:Zt9Bv2Nm6Qw1Er4Ty7Ui0Op3As5Df8Gh1Jk4Lz7Xc2" },
    checks: OK_CHECKS,
    checkedAt: "10月2日",
  },
];

/** Project → 実行場所（作るときに決め、あとから変えない）。無ければこの機械のコンテナ */
const projectRuntime = new Map<string, string>([["home", "rt.home-lab"]]);

export function getRuntimes(): readonly MockRuntime[] {
  return runtimes;
}

/** 画面から読むときはこちら（変わったら描き直す） */
export function useRuntimes(): readonly MockRuntime[] {
  return useSyncExternalStore(subscribeMockStore, getRuntimes, getRuntimes);
}

export function getRuntime(id: string): MockRuntime | undefined {
  return runtimes.find((r) => r.id === id);
}

export function runtimeIdOfProject(projectId: string): string {
  return projectRuntime.get(projectId) ?? HOST_CONTAINER;
}

export function setProjectRuntime(projectId: string, runtimeId: string): void {
  if (runtimeId === HOST_CONTAINER) projectRuntime.delete(projectId);
  else projectRuntime.set(projectId, runtimeId);
}

/** その実行場所を使っている Project（閉じたものも数える——閉じても向こうの置き場は残り、再開できる） */
export function projectUsingRuntime(runtimeId: string) {
  return getAllProjects().find((p) => projectRuntime.get(p.id) === runtimeId);
}

/**
 * 新しい Project で選べるか。選べないなら理由（画面にそのまま出す）。
 * 1つの実行場所に Project は1つ・host 鍵が変わった・前提が足りない・まだ確かめていない、の順に見る
 */
export function runtimeUnavailableReason(r: MockRuntime): string | undefined {
  const used = projectUsingRuntime(r.id);
  if (used) return `Project「${used.name}」が使っています（1つの実行場所に Project は1つ）`;
  if (r.hostKeyMismatch) return "host 鍵が前と違うので繋ぎません";
  if (!r.hostKey) return "まだ繋いで確かめていません";
  if (r.checks?.some((c) => c.status === "fail")) return "前提が足りません";
  return undefined;
}

export function sshTarget(r: Pick<MockRuntime, "user" | "host" | "port">): string {
  return `${r.user}@${r.host}${r.port === 22 ? "" : `:${r.port}`}`;
}

export interface NewRuntimeInput {
  name: string;
  host: string;
  user: string;
  port: number;
  keyAlias: string;
  dataRoot: string;
}

/**
 * 「繋いで確かめる」の1回目：host 鍵の指紋を返す（覚えるのは人が確かめてから）。
 * モックの筋書き：宛先に `nodocker` を含めば Docker が無い、`fail` を含めば systemd が無い
 */
export function probeHostKey(input: NewRuntimeInput): { type: string; fingerprint: string } {
  const seed = [...`${input.host}:${input.port}`].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = seed;
  let fp = "";
  for (let i = 0; i < 43; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    fp += chars[s % chars.length];
  }
  return { type: "ED25519", fingerprint: `SHA256:${fp}` };
}

/** 2回目：指紋を覚えたあとの前提の確かめ */
export function probeChecks(input: NewRuntimeInput): RuntimeCheck[] {
  const checks = OK_CHECKS.map((c) => ({ ...c }));
  if (input.host.includes("fail")) {
    const i = checks.findIndex((c) => c.label.startsWith("ユーザーの systemd"));
    checks[i] = {
      ...checks[i],
      status: "fail",
      detail: "/run/user/1001/bus がありません。Service・裏で流すコマンド・Module の起こし方が使います。",
      fix: "sudo loginctl enable-linger banto  # のあと、banto で一度ログインし直す",
    };
  }
  checks.push(
    input.host.includes("nodocker")
      ? {
          label: "Docker（containerlab）",
          status: "warn",
          detail: "Docker がありません。「中で Docker を使う」Project では断ります。",
          fix: "sudo apt install docker.io && sudo usermod -aG docker banto",
        }
      : { label: "Docker（containerlab）", status: "ok" },
  );
  return checks;
}

export function addRuntime(input: NewRuntimeInput, hostKey: { type: string; fingerprint: string }): MockRuntime {
  const runtime: MockRuntime = {
    id: `rt.${input.name}-${Math.random().toString(36).slice(2, 6)}`,
    ...input,
    hostKey: { ...hostKey, confirmedAt: "今日" },
    checks: probeChecks(input),
    checkedAt: "たった今",
  };
  runtimes = [...runtimes, runtime];
  notifyMockStoreChange();
  return runtime;
}

export function recheckRuntime(id: string): void {
  runtimes = runtimes.map((r) => (r.id === id ? { ...r, checks: probeChecks(r), checkedAt: "たった今" } : r));
  notifyMockStoreChange();
}

/** 前と違う指紋を、人が確かめたうえで覚え直す */
export function acceptNewHostKey(id: string): void {
  runtimes = runtimes.map((r) =>
    r.id === id && r.hostKeyMismatch
      ? { ...r, hostKey: { ...r.hostKeyMismatch, confirmedAt: "今日" }, hostKeyMismatch: undefined, checkedAt: "たった今" }
      : r,
  );
  notifyMockStoreChange();
}

/** 外す。使っている Project があれば外せない（画面がボタンを出さない） */
export function removeRuntime(id: string): void {
  runtimes = runtimes.filter((r) => r.id !== id);
  notifyMockStoreChange();
}

// ── 向こうのフォルダ（本物は SSH で名前だけを引く）────────────────────────────

const REMOTE_FOLDERS: Record<string, string[]> = {
  "rt.home-lab": ["~/labs/pve-nested", "~/labs/pve-nested/topologies", "~/labs/evpn", "~/notes"],
  "rt.gpu-box": ["~/work/llm-bench", "~/work/llm-bench/results", "~/work/vision", "~/datasets"],
};

export function remoteFolderSource(runtimeId: string) {
  const all = REMOTE_FOLDERS[runtimeId] ?? ["~/work"];
  return {
    exists: (path: string) => path === "~" || all.some((f) => f === path || f.startsWith(`${path}/`)),
    list: (path: string) => {
      const children = new Set<string>();
      for (const f of all) if (f.startsWith(`${path}/`)) children.add(f.slice(path.length + 1).split("/")[0]);
      return [...children].sort();
    },
  };
}
