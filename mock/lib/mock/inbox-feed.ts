// 受信箱の見直し（決定・2026-10-15、ユーザー）のモック用データ。
//
// 受信箱は「人の番になったもの」だけ：
//   1. 判断待ち（AI が止まっている）
//   2. 会話が人に返ってきたもの——ターンが終わり、その Thread に裏の仕事（返信用の札の awaiting）も
//      まだ渡していない届いたものも残っていない。まとめ（report_turn）があればその中身、決めること
//      （decisions）があるものは上に寄せる。途中で切れた・失敗したターンも出す
//   3. 人が直す必要のある仕組みの異常
// 出さないもの：届くたびの「届きました。AI が続きをやります」、裏の仕事が残っている途中のターン、
// 知らせるだけのお知らせ（移し終えた・上限に当たった 等）。
import { notifyMockStoreChange } from "./store-events";

interface FeedBase {
  id: string;
  projectId: string;
  /** 無い＝banto 全体のもの（Project に属さない仕組みの異常） */
  threadId?: string;
  threadKind?: "base" | "fork";
  /** 何分前か（モックなので文字で持つ） */
  age: string;
  /** 並べるための分（小さいほど新しい） */
  ageMin: number;
}

export interface FeedJudgment extends FeedBase {
  kind: "judgment";
  /** 誰が聞いているか（「Shell の確認」等） */
  from: string;
  message: string;
}

export interface FeedReturned extends FeedBase {
  kind: "returned";
  /** まとめがあればその中身、無ければ最後の返事の頭 */
  summary?: {
    status: "done" | "partial" | "failed";
    headline: string;
    /** 決めることの問い（あれば上に寄せる） */
    decisions: { question: string; options: string[] }[];
  };
  lastReply?: string;
  /** 途中で切れた・失敗した */
  interrupted?: string;
}

export interface FeedFix extends FeedBase {
  kind: "fix";
  title: string;
  detail: string;
  /** 押したときの行き先の言葉（「設定を開く」等） */
  actionLabel: string;
  href: string;
}

export type FeedItem = FeedJudgment | FeedReturned | FeedFix;

let items: FeedItem[] = [
  {
    kind: "judgment",
    id: "j-shell",
    projectId: "banto",
    threadId: "banto-base",
    threadKind: "base",
    from: "Shell の確認",
    message: "`git push origin main:release` を実行してよいですか？",
    age: "2分前",
    ageMin: 2,
  },
  {
    kind: "judgment",
    id: "j-relay",
    projectId: "home",
    threadId: "home-base",
    threadKind: "base",
    from: "Module 間中継の承認",
    message: "Backlog が Vault の「github-token」を使います。許可しますか？",
    age: "14分前",
    ageMin: 14,
  },
  {
    kind: "returned",
    id: "r-ui",
    projectId: "banto",
    threadId: "ui",
    threadKind: "fork",
    summary: {
      status: "done",
      headline: "アシスタントの発言の見せ方を2案作りました。どちらで進めるか決めてください。",
      decisions: [
        { question: "アシスタントの発言はどちらの見せ方にしますか？", options: ["文字なしアイコン", "罫線だけ"] },
      ],
    },
    age: "5分前",
    ageMin: 5,
  },
  {
    kind: "returned",
    id: "r-vault",
    projectId: "banto",
    threadId: "vault-variant",
    threadKind: "fork",
    summary: {
      status: "partial",
      headline: "Infisical の環境の一覧を読むところまで動きました。本物の Infisical では未確認です。",
      decisions: [
        { question: "本物の Infisical で確かめてから main に入れますか？", options: ["確かめてから", "このまま入れる"] },
        { question: "空の秘密は一覧に出しますか？", options: ["出す", "出さない"] },
      ],
    },
    age: "31分前",
    ageMin: 31,
  },
  {
    kind: "returned",
    id: "r-login",
    projectId: "banto",
    threadId: "login",
    threadKind: "fork",
    summary: {
      status: "done",
      headline: "パスキーでのログインを実装し、main と release に push しました。host での反映はまだです。",
      decisions: [],
    },
    age: "8分前",
    ageMin: 8,
  },
  {
    kind: "returned",
    id: "r-embedding",
    projectId: "hermes",
    threadId: "hermes-embedding",
    threadKind: "fork",
    interrupted: "banto を起こし直したため、途中で切れました",
    lastReply: "1万件の再計算は 4 分 12 秒でした。10 万件を流しているところで…",
    age: "22分前",
    ageMin: 22,
  },
  {
    kind: "returned",
    id: "r-home",
    projectId: "home",
    threadId: "home-base",
    threadKind: "base",
    lastReply: "Caddy の証明書更新スクリプトを直しました。次の更新は 10月28日です。",
    age: "1時間前",
    ageMin: 60,
  },
  {
    kind: "returned",
    id: "r-docs",
    projectId: "banto",
    threadId: "docs-tidy",
    threadKind: "fork",
    summary: {
      status: "failed",
      headline: "仕様書の節番号を振り直そうとしましたが、別の Fork の変更とぶつかって止めました。",
      decisions: [],
    },
    age: "2時間前",
    ageMin: 120,
  },
  {
    kind: "fix",
    id: "f-claude",
    projectId: "",
    title: "banto 本体の Claude ログインが期限切れです",
    detail: "この機械で `claude auth login` を実行してください。",
    actionLabel: "手順を見る",
    href: "/settings",
    age: "40分前",
    ageMin: 40,
  },
  {
    kind: "fix",
    id: "f-module",
    projectId: "hermes",
    title: "Backlog を繋げませんでした",
    detail: "Project の root が git のリポジトリではありません。`git init` してから繋ぎ直してください。",
    actionLabel: "Project の設定を開く",
    href: "/settings?project=hermes&section=project-modules",
    age: "3時間前",
    ageMin: 180,
  },
];

export function getFeedItems(): readonly FeedItem[] {
  return items;
}

/** 見た（会話を開いた）ので一覧から外す */
export function dismissFeedItem(id: string): void {
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return;
  items = next;
  notifyMockStoreChange();
}

export function dismissAllReturned(): void {
  items = items.filter((i) => i.kind !== "returned" || (i.summary?.decisions.length ?? 0) > 0);
  notifyMockStoreChange();
}

export type FeedSection = "judgment" | "decide" | "returned" | "fix";

export function sectionOf(item: FeedItem): FeedSection {
  if (item.kind === "judgment") return "judgment";
  if (item.kind === "fix") return "fix";
  return (item.summary?.decisions.length ?? 0) > 0 ? "decide" : "returned";
}

export function feedHref(item: FeedItem): string {
  if (item.kind === "fix") return item.href;
  return item.threadKind === "fork" ? `/p/${item.projectId}?fork=${item.threadId}` : `/p/${item.projectId}`;
}

/** バッジに数えるもの——人が答えないと進まないもの（判断待ちと決めること） */
export function feedBadgeCount(): number {
  return items.filter((i) => sectionOf(i) === "judgment" || sectionOf(i) === "decide").length;
}
