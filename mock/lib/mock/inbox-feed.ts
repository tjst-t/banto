// 受信箱の見直し（決定・2026-10-15、ユーザー）のモック用データ。
//
// 受信箱は「人の番になったもの」だけ、かつ**受信箱の中で読んで答えて先へ進められる**（改訂・同日）：
//   1. 判断待ち（AI が止まっている）——その場で答える
//   2. 会話が人に返ってきたもの——ターンが終わり、その Thread に裏の仕事も、まだ渡していない届いたものも
//      残っていない。AI の最後の返事とまとめ（report_turn）をその場で読み、返信を打てる。決めることが
//      あるものは上に寄せ、選択肢を押すと返信の欄に入る
//   3. 人が直す必要のある仕組みの異常
import { notifyMockStoreChange } from "./store-events";

interface FeedBase {
  id: string;
  projectId: string;
  /** 無い＝banto 全体のもの */
  threadId?: string;
  threadKind?: "base" | "fork";
  age: string;
  ageMin: number;
}

export interface FeedJudgment extends FeedBase {
  kind: "judgment";
  from: string;
  message: string;
  /** 何を承認するのか（tool の引数など）を人に見せる */
  detail?: { label: string; value: string }[];
  choices: string[];
}

export interface FeedDecision {
  question: string;
  context?: string;
  /** href＝その選択肢の中身を見られる場所（モック等）。押す前に見比べられるように */
  options: { label: string; reply: string; recommended?: boolean; href?: string }[];
}

export interface FeedReturned extends FeedBase {
  kind: "returned";
  /** 人が頼んだこと（まとめの request）。まとめが無いときは人の最後の発言の頭 */
  request: string;
  /** AI の最後の返事（本文） */
  reply: string;
  summary?: {
    status: "done" | "partial" | "failed";
    headline: string;
    points: string[];
    notVerified: string[];
    artifacts?: { label: string; detail: string; href?: string }[];
    decisions: FeedDecision[];
    nextSuggestions?: { label: string; reply: string }[];
  };
  interrupted?: string;
  /** そのターンで AI がしたこと（tool の数など）——開かずに規模が分かるように */
  activity?: string;
}

export interface FeedFix extends FeedBase {
  kind: "fix";
  title: string;
  detail: string;
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
    message: "このコマンドを実行してよいですか？",
    detail: [
      { label: "コマンド", value: "git push origin main:release" },
      { label: "場所", value: "/home/ubuntu/banto" },
      { label: "鍵", value: "Vault の github-deploy-key（sshIdentity）" },
    ],
    choices: ["許可する", "拒否する"],
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
    message: "Backlog が Vault の秘密を使おうとしています。",
    detail: [
      { label: "呼び元", value: "Backlog（push_branch）" },
      { label: "宛先", value: "vault-local の resolveAlias" },
      { label: "alias", value: "github-token" },
    ],
    choices: ["許可する", "今回だけ許可する", "拒否する"],
    age: "14分前",
    ageMin: 14,
  },
  {
    kind: "returned",
    id: "r-ui",
    projectId: "banto",
    threadId: "ui",
    threadKind: "fork",
    request: "アシスタントの発言の見せ方を見直し、案をいくつか作って比べられるようにする",
    reply:
      "アシスタントの発言の見せ方を2案作りました。\n\n- **案A 文字なしアイコン**：発言の左に小さな丸だけを置き、名前は出しません。行の頭が揃うので長い会話でも目が流れやすいです。\n- **案B 罫線だけ**：アイコンも名前も無く、左に細い線を引くだけ。いちばん静かですが、人の発言との区別が色だけになります。\n\nどちらもモック https://mock-inbox-2ced47c4.banto.tjstkm.net/p/banto?fork=ui で切り替えて見られます。",
    summary: {
      status: "done",
      headline: "アシスタントの発言の見せ方を2案作りました。どちらで進めるか決めてください。",
      points: ["案A：文字なしアイコン（行の頭が揃う）", "案B：罫線だけ（静かだが人の発言との区別が色だけ）"],
      notVerified: ["携帯の幅では見ていない"],
      artifacts: [
        { label: "案A のモック", detail: "mock-ui-2ced47c4", href: "https://mock-inbox-2ced47c4.banto.tjstkm.net/p/banto?fork=ui&avatar=a" },
        { label: "案B のモック", detail: "mock-ui-2ced47c4", href: "https://mock-inbox-2ced47c4.banto.tjstkm.net/p/banto?fork=ui&avatar=b" },
        { label: "コミット", detail: "a1b2c3d4（fork/ui-avatar）" },
      ],
      decisions: [
        {
          question: "アシスタントの発言はどちらの見せ方にしますか？",
          context: "案B は暗いテーマで線が見えにくくなります。",
          options: [
            { label: "案A", reply: "案A（文字なしアイコン）で進めて。携帯の幅でも確かめて。", recommended: true, href: "https://mock-inbox-2ced47c4.banto.tjstkm.net/p/banto?fork=ui&avatar=a" },
            { label: "案B", reply: "案B（罫線だけ）で進めて。暗いテーマの線の色も調整して。", href: "https://mock-inbox-2ced47c4.banto.tjstkm.net/p/banto?fork=ui&avatar=b" },
          ],
        },
      ],
    },
    activity: "ファイル 6 件を変更・コマンド 4 回",
    age: "5分前",
    ageMin: 5,
  },
  {
    kind: "returned",
    id: "r-vault",
    projectId: "banto",
    threadId: "vault-variant",
    threadKind: "fork",
    request: "Infisical の環境を Project ごとに選べるようにする（Vault の「版」）",
    reply:
      "Infisical の環境の一覧を読むところまで動きました。単体テストは 42 件すべて通っています。\n\n本物の Infisical では、環境の一覧の API（GET /api/v1/projects/{id}）をまだ叩いていません。偽物のサーバでだけ確かめています。",
    summary: {
      status: "partial",
      headline: "環境の一覧を読むところまで動きました。本物の Infisical では未確認です。",
      points: ["版を名乗った実装だけ、紐付けの画面に版の選択が出る", "単体テスト 42 件通過"],
      notVerified: ["本物の Infisical の環境の一覧 API", "E2E は流していない"],
      decisions: [
        {
          question: "本物の Infisical で確かめてから main に入れますか？",
          options: [
            { label: "確かめてから", reply: "開発用の Infisical で環境の一覧を確かめてから main に入れて。", recommended: true },
            { label: "このまま入れる", reply: "このまま main に入れて。本物での確かめは Backlog に積んでおいて。" },
          ],
        },
        {
          question: "値が空の秘密は一覧に出しますか？",
          options: [
            { label: "出す", reply: "値が空の秘密も一覧に「空」と出して。", recommended: true },
            { label: "出さない", reply: "値が空の秘密は一覧に出さないで。" },
          ],
        },
      ],
    },
    activity: "ファイル 11 件を変更・コマンド 9 回",
    age: "31分前",
    ageMin: 31,
  },
  {
    kind: "returned",
    id: "r-login",
    projectId: "banto",
    threadId: "login",
    threadKind: "fork",
    request: "パスキーでログインできるようにして release まで出す",
    reply:
      "パスキーでのログインを実装し、main と release に push しました（8baed238）。フル E2E は 242 件すべて通りました。\n\nhost での反映（`node scripts/login-link.mjs` で最初のリンクを出す）はまだです。手順は docs/runbooks/release.md の C にあります。",
    summary: {
      status: "done",
      headline: "パスキーでのログインを実装し、main と release に push しました。host での反映はまだです。",
      points: ["フル E2E 242 件通過", "最初の1回は host で login-link を打って入る"],
      notVerified: ["携帯の実機でのパスキー登録"],
      artifacts: [{ label: "コミット", detail: "8baed238（main・release）" }],
      decisions: [],
      nextSuggestions: [
        { label: "反映の手順を出して", reply: "host で反映する手順を、打つコマンドだけ順に出して。" },
        { label: "Fork を閉じて", reply: "この Fork はもう終わりなので閉じて。" },
      ],
    },
    activity: "ファイル 23 件を変更・コマンド 31 回",
    age: "8分前",
    ageMin: 8,
  },
  {
    kind: "returned",
    id: "r-embedding",
    projectId: "hermes",
    threadId: "hermes-embedding",
    threadKind: "fork",
    request: "埋め込みの再計算にかかる時間を件数ごとに測る",
    reply: "1万件の再計算は 4 分 12 秒でした。10 万件を流しているところで…",
    interrupted: "banto を起こし直したため、途中で切れました",
    age: "22分前",
    ageMin: 22,
  },
  {
    kind: "returned",
    id: "r-home",
    projectId: "home",
    threadId: "home-base",
    threadKind: "base",
    request: "Caddy の証明書の更新が失敗している理由を調べて直す",
    reply:
      "Caddy の証明書更新スクリプトを直しました。Cloudflare のトークンの権限に Zone:Read が足りず、DNS-01 の確認が失敗していました。トークンを入れ替えて手で更新を流し、成功を確かめています。次の更新は 10月28日です。",
    activity: "コマンド 7 回",
    age: "1時間前",
    ageMin: 60,
  },
  {
    kind: "returned",
    id: "r-hermes",
    projectId: "hermes",
    threadId: "hermes-base",
    threadKind: "base",
    request: "検索の遅さの原因を調べて。直すのはまだいい",
    reply:
      "検索が遅い原因は、埋め込みの近傍探索ではなく、その前の絞り込み（タグでの WHERE）でした。\n\n- タグの列に索引が無く、1回の検索で 38 万行を全部読んでいます（EXPLAIN で確認）\n- 近傍探索そのものは 12ms で、全体 1.9 秒のほとんどは絞り込みです\n- 索引を足せば 50ms 前後になる見込みです（手元の写しで測った値）\n\n直すのはまだと言われたので、何も変えていません。索引を足すなら `CREATE INDEX memories_tags_idx ON memories USING gin (tags);` の1行です。",
    activity: "コマンド 12 回",
    age: "45分前",
    ageMin: 45,
  },
  {
    kind: "fix",
    id: "f-claude",
    projectId: "",
    title: "banto 本体の Claude ログインが期限切れです",
    detail:
      "Project のコンテナからの Claude の呼び出しが、本体のログインで断られました（401）。この機械で `claude auth login` を実行してください。",
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

export function dismissFeedItem(id: string): void {
  const next = items.filter((i) => i.id !== id);
  if (next.length === items.length) return;
  items = next;
  notifyMockStoreChange();
}

export type FeedSection = "judgment" | "decide" | "returned" | "fix";

export function sectionOf(item: FeedItem): FeedSection {
  if (item.kind === "judgment") return "judgment";
  if (item.kind === "fix") return "fix";
  return (item.summary?.decisions.length ?? 0) > 0 ? "decide" : "returned";
}

export function threadHref(item: FeedItem): string {
  if (item.kind === "fix") return item.href;
  return item.threadKind === "fork" ? `/p/${item.projectId}?fork=${item.threadId}` : `/p/${item.projectId}`;
}

export function feedBadgeCount(): number {
  return items.filter((i) => sectionOf(i) === "judgment" || sectionOf(i) === "decide").length;
}
