// Backlog（v4-modules.md §4.4、決定・2026-10-02）の見本データと操作。
// 形は tasks.json の `banto-backlog/1` をそのまま写す——画面が欄の名前を読み替えずに済むように。
// 中身は docs/tasks.json（2026-10-02 時点）の実際の項目を §4.4「いまの docs/tasks.json の移し方」で
// 読み替えたもの（pending → ready、undecided → backlog＋「未決」ラベル、phase → milestone、
// why・notes・result 等 → body）。ストーリーは見出し的なものから作り直した。
//
// 書き込みは Module の tool（createItem・updateItem・splitStory・moveItem）を通る想定なので、
// 関数もその5本に合わせる。消す操作は無い（§4.4「消す tool は作らない」）。
// projects.ts／settings.ts と同じく mutable な配列に持ち、変えたら `notifyMockStoreChange`。
import { notifyMockStoreChange } from "./store-events";
import type { ProjectId } from "./types";

export type BacklogKind = "story" | "task" | "bug";
export type BacklogStatus = "backlog" | "ready" | "in-progress" | "done" | "dropped";
export type BacklogPriority = "high" | "normal" | "low";

export interface BacklogMilestone {
  id: string;
  title: string;
  status: "open" | "closed";
}

export interface BacklogThreadRef {
  projectId: ProjectId;
  threadId: string;
}

export interface BacklogItem {
  id: string;
  kind: BacklogKind;
  title: string;
  status: BacklogStatus;
  parent: string | null;
  dependsOn: string[];
  milestone: string | null;
  priority: BacklogPriority;
  labels: string[];
  body: string;
  doneWhen: string;
  resolution: string | null;
  refs: string[];
  threads: BacklogThreadRef[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface BacklogFile {
  /** Project の根からの場所（Backlog の設定で変えられる。既定は docs/tasks.json） */
  path: string;
  milestones: BacklogMilestone[];
  /** ファイルの中の順＝優先順（§4.4「並び順はファイルの中の順番がそのまま優先順」） */
  items: BacklogItem[];
}

/** tasks.json の場所の既定（§4.4） */
export const BACKLOG_DEFAULT_PATH = "docs/tasks.json";

type Seed = Partial<BacklogItem> & Pick<BacklogItem, "id" | "kind" | "title" | "status">;

function seed(s: Seed): BacklogItem {
  const createdAt = s.createdAt ?? "2026-09-20T10:00:00+09:00";
  const closed = s.status === "done" || s.status === "dropped";
  return {
    parent: null,
    dependsOn: [],
    milestone: null,
    priority: "normal",
    labels: [],
    body: "",
    doneWhen: "",
    resolution: null,
    refs: [],
    threads: [],
    updatedAt: s.updatedAt ?? s.closedAt ?? createdAt,
    closedAt: closed ? (s.closedAt ?? createdAt) : null,
    ...s,
    createdAt,
  };
}

const bantoItems: BacklogItem[] = [
  // ---- 標準 Module を揃える ----
  seed({
    id: "repositories-next",
    kind: "story",
    title: "Repositories の続き",
    status: "in-progress",
    milestone: "phase2",
    labels: ["repositories"],
    body: [
      "手元のリポジトリの台帳と、Project を始める3つの手（手元のフォルダ・clone・新しいリポジトリ）を揃える。",
      "",
      "段階1では「Project を始める」「GitHub に公開」「clone し直す」は押すと「まだ作っていない」と言うだけだった。段階を追って中身を繋いでいる。",
    ].join("\n"),
    doneWhen: "§2.4 の始める3つの手・公開・アカウントが実ブラウザの E2E で通り、段階1の「まだ作っていない」が画面から消える",
    refs: ["docs/specs/v4-modules.md §2.4"],
    createdAt: "2026-09-30T09:00:00+09:00",
    updatedAt: "2026-10-02T15:20:00+09:00",
  }),
  seed({
    id: "repositories-stage1",
    kind: "task",
    title: "段階1：台帳・Import・一覧から外す／元に戻す・一覧の画面",
    status: "done",
    parent: "repositories-next",
    milestone: "phase2",
    labels: ["repositories"],
    body: [
      "core の中継に `relayListProjects` を足し、入口・画面の中身・画面からの呼び出しを「Project の Module 集合＋banto 全体の Module」に寄せた。",
      "",
      "- 単体：Module 19本・core の中継と入口",
      "- E2E：`e2e/specs/repositories.spec.ts`（2本）",
    ].join("\n"),
    doneWhen: "Command Palette の「リポジトリ」から開いた一覧に、Import した手元のリポジトリが正しく出ることを人が実物で確かめる",
    refs: ["docs/notes/2026-10-01-repositories-stage1.md"],
    threads: [{ projectId: "banto", threadId: "banto-base" }],
    createdAt: "2026-09-30T09:10:00+09:00",
    closedAt: "2026-10-01T18:40:00+09:00",
  }),
  seed({
    id: "repositories-stage2",
    kind: "task",
    title: "段階2：GitHub のアカウント（PAT・ブラウザでログイン・自動更新）",
    status: "done",
    parent: "repositories-next",
    dependsOn: ["repositories-stage1"],
    milestone: "phase2",
    labels: ["repositories", "vault"],
    body: [
      "設定の Repositories の面にアカウントの登録・確かめる・外す。秘密は Vault、Module は在りかだけを持つ。",
      "",
      "更新は使う直前・アカウントごとに1本ずつ。失敗はアカウントに残して受信箱へ（中継に `relayRaiseNotice` を足した）。",
    ].join("\n"),
    doneWhen: "ブラウザでログインして自分の login のアカウントが登録され、8時間後に「確かめる」で更新が通る",
    refs: ["docs/notes/2026-10-02-repositories-stage2.md", "docs/specs/v4-security.md §3"],
    threads: [{ projectId: "banto", threadId: "banto-base" }],
    createdAt: "2026-09-30T09:10:00+09:00",
    closedAt: "2026-10-02T11:05:00+09:00",
  }),
  seed({
    id: "repositories-stage3",
    kind: "task",
    title: "段階3：URL から clone・新しいリポジトリ・「Project も作る」",
    status: "in-progress",
    parent: "repositories-next",
    dependsOn: ["repositories-stage2"],
    milestone: "phase2",
    priority: "high",
    labels: ["repositories"],
    body: [
      "clone は Module の背景の仕事で、画面が進み具合を聞きに来る（git が5分黙ったら切る）。",
      "",
      "トークンは一度きりの unix socket から credential helper へ渡す——引数・環境には置かない。clone の間も hooks 等の潰しは効かせる。",
    ].join("\n"),
    doneWhen: "稼働中の banto で、公開・非公開・GitHub の外のリポジトリを URL から clone でき、「Project も作る」で新しい Project の画面が開く",
    refs: ["docs/specs/v4-modules.md §2.4", "docs/notes/2026-10-02-repositories-stage3.md"],
    threads: [{ projectId: "banto", threadId: "banto-base" }],
    createdAt: "2026-09-30T09:10:00+09:00",
    updatedAt: "2026-10-02T15:20:00+09:00",
  }),
  seed({
    id: "repositories-publish",
    kind: "task",
    title: "この Project を GitHub に公開する",
    status: "ready",
    parent: "repositories-next",
    dependsOn: ["repositories-stage3"],
    milestone: "phase2",
    labels: ["repositories"],
    body: "いまは押すと「まだ作っていない」と言うだけ。リポジトリを作って push し、台帳に GitHub の場所を書く。",
    doneWhen: "このマシンにだけのリポジトリを公開すると、一覧の GitHub の列に場所が出る（E2E、偽の GitHub）",
    createdAt: "2026-09-30T09:10:00+09:00",
  }),
  seed({
    id: "repositories-open-project",
    kind: "task",
    title: "既にある Project を Canvas から開く口",
    status: "backlog",
    parent: "repositories-next",
    dependsOn: ["repositories-stage3"],
    milestone: "phase2",
    labels: ["repositories", "未決"],
    body: "一覧の Project の列はいま名前だけ。Canvas から banto の画面遷移を頼む口が無い——`dev.banto/open-new-project` と同じ形で足すかは未決。",
    createdAt: "2026-09-30T09:10:00+09:00",
  }),
  seed({
    id: "backlog-module",
    kind: "story",
    title: "Backlog——仕事の一覧を Module にする",
    status: "ready",
    milestone: "phase2",
    priority: "high",
    labels: ["backlog"],
    body: [
      "今後やること・バグを、ストーリー・タスク・バグの3種類と依存関係で持つ。いまの `docs/tasks.json` が最初の利用者。",
      "",
      "窓口1本＋バックエンドの実装が複数（最初は tasks.json、将来は GitHub Issues）。",
    ].join("\n"),
    doneWhen: "AI が listItems で「いま着手できるもの」を引き、splitStory でタスクに分け、人が一覧の画面で同じ中身を見られる（実ブラウザの E2E）",
    refs: ["docs/specs/v4-modules.md §4.4"],
    createdAt: "2026-10-02T10:00:00+09:00",
  }),
  seed({
    id: "vault-directory-call-id",
    kind: "task",
    title: "vault-directory も中継に呼び出しの印を返す",
    status: "ready",
    milestone: "phase2",
    priority: "high",
    labels: ["vault", "中継"],
    body: [
      "印を返していない banto 全体の Module は接続単位で出所を引くので、Project が混ざると刻印が決まらない。",
      "",
      "vault-directory は2つの Project の Shell・Service から同時に `lookupAlias` を受けうる。実機では未観測、コードを読んで判明。",
    ].join("\n"),
    doneWhen: "2つの Project から同時に秘密を引く試験が通る",
    refs: ["docs/specs/v4-architecture.md §2.5"],
    createdAt: "2026-09-28T16:00:00+09:00",
  }),
  seed({
    id: "publish-host-verify",
    kind: "task",
    title: "Publish を本物の Caddy・Incus・ブラウザで確かめる",
    status: "ready",
    milestone: "phase2",
    labels: ["publish"],
    body: "単体試験（偽の Caddy・偽の Service）は通したが、host の Caddy の実物と Incus の `/state` の実物を見ていない。承認の画面も実ブラウザで見ていない。",
    doneWhen: "Service で起こしたサーバを AI が publishService で頼み、承認を経てその URL にブラウザから届き、Basic 認証で中身が出る",
    refs: ["docs/specs/v4-modules.md §4.3"],
    createdAt: "2026-09-27T20:00:00+09:00",
  }),
  seed({
    id: "claude-login-relay-owner",
    kind: "task",
    title: "Claude ログインの中継を core に常設する",
    status: "ready",
    milestone: "phase2",
    labels: ["subagent", "コンテナ"],
    body: [
      "いまは subagent-settings が1回ごとに開け閉めしており、寿命が必要な単位（Project）より短い。",
      "",
      "常設にすると Shell には何も足さずに `claude -p`・Agent SDK・banto の E2E が通る。",
    ].join("\n"),
    doneWhen: "Shell の runCommand から claude -p が通り、Project のコンテナの中で E2E が回る",
    refs: ["docs/notes/2026-09-27-claude-login-relay-alternatives.md"],
    createdAt: "2026-09-27T12:00:00+09:00",
  }),
  seed({
    id: "module-kit-extract",
    kind: "task",
    title: "Module を書く足場（kit）と契約試験を切り出す",
    status: "backlog",
    milestone: "phase2",
    labels: ["module"],
    body: "Vault・Shell・FileSystem・Repositories で同じ足場を4回書いている。",
    createdAt: "2026-09-12T10:00:00+09:00",
  }),
  seed({
    id: "phase0-stale-notify",
    kind: "task",
    title: "滞留通知——判断待ちが長く放っておかれたら知らせる",
    status: "backlog",
    milestone: "phase2",
    labels: ["受信箱"],
    body: [
      "判断待ちが出ても、人が画面を見ていなければ止まったままになる。",
      "",
      "- 閾値を過ぎた判断待ちを定期的に見て、通知の出来事を追記する",
      "- 本物の Web Push はやらない——タブが開いている間だけ",
    ].join("\n"),
    doneWhen: "閾値を過ぎた判断待ちで通知が実際に出ることを実ブラウザで確認する",
    refs: ["docs/requirements.md A7"],
    createdAt: "2026-09-06T10:00:00+09:00",
  }),
  seed({
    id: "registry-search-install",
    kind: "task",
    title: "公式レジストリからの検索・インストール",
    status: "dropped",
    milestone: "phase2",
    labels: ["module"],
    resolution: "重複——「MCP Registry の一覧から Module を入れて繋ぐ」で済んだ",
    createdAt: "2026-09-10T10:00:00+09:00",
    closedAt: "2026-09-21T10:00:00+09:00",
  }),

  // ---- 並べて任せる ----
  seed({
    id: "ai-forks",
    kind: "story",
    title: "AI が Fork を立てて並行に進める",
    status: "in-progress",
    milestone: "phase3",
    labels: ["fork"],
    body: "人とやり取りしながら進める話が複数あるとき、AI が Fork を立てて並行に進める（やり取りが要らないならサブエージェント）。",
    refs: ["docs/specs/v4-architecture.md §2.2", "docs/specs/v4-architecture.md §2.4"],
    createdAt: "2026-09-27T09:00:00+09:00",
  }),
  seed({
    id: "ai-start-forks",
    kind: "task",
    title: "AI が tool から Fork を立てる（名前と最初の指示つき）",
    status: "in-progress",
    parent: "ai-forks",
    milestone: "phase3",
    labels: ["fork"],
    body: [
      "core の単体試験（`fork-tool.test.ts`、6本）と画面の単体 16本は通した。",
      "",
      "2026-09-28：2つ目の Fork が「Fork 2」になる不具合を見つけて直し、host で E2E が通った（ユーザー実行）。",
    ].join("\n"),
    doneWhen: "host で ai-start-forks・project-thread-fork・inbox・fork-from-message の E2E が通る",
    threads: [
      { projectId: "banto", threadId: "ui" },
      { projectId: "banto", threadId: "banto-base" },
    ],
    createdAt: "2026-09-27T09:00:00+09:00",
    updatedAt: "2026-09-28T19:30:00+09:00",
  }),
  seed({
    id: "ai-forks-review-inbox",
    kind: "task",
    title: "ターンが終わった Fork を受信箱にレビュー待ちで出す",
    status: "ready",
    parent: "ai-forks",
    dependsOn: ["ai-start-forks"],
    milestone: "phase3",
    labels: ["fork", "受信箱"],
    doneWhen: "AI が立てた Fork のターンが終わると、受信箱にレビュー待ちが1件出て、押すとその Fork が開く",
    createdAt: "2026-09-27T09:00:00+09:00",
  }),
  seed({
    id: "ai-forks-live-check",
    kind: "task",
    title: "稼働中の banto で、AI に Fork を2つ立てさせて確かめる",
    status: "backlog",
    parent: "ai-forks",
    dependsOn: ["ai-start-forks", "ai-forks-review-inbox"],
    milestone: "phase3",
    labels: ["fork"],
    doneWhen: "再読み込みせずに名前つきの入口が2つ出て、それぞれ最初の指示で走り、終わったものが受信箱に出る",
    createdAt: "2026-09-27T09:00:00+09:00",
  }),
  seed({
    id: "subagent-human-loop",
    kind: "story",
    title: "サブエージェントと人のやり取り",
    status: "backlog",
    milestone: "phase3",
    labels: ["subagent"],
    body: "サブエージェントの確認を人に上げ、banto の Module を渡す。いまは確認を断って返り値に書いている。",
    refs: ["docs/specs/v4-modules.md §4.1"],
    createdAt: "2026-09-24T10:00:00+09:00",
  }),
  seed({
    id: "elicitation-answers",
    kind: "task",
    title: "Module からの問いに、受信箱から答えられるようにする",
    status: "ready",
    parent: "subagent-human-loop",
    milestone: "phase3",
    labels: ["subagent", "受信箱"],
    body: "「後で答える」の答えを届ける配線が無い（受信箱に「まだ繋がっていません」と出るだけ）。",
    refs: ["docs/specs/v4-architecture.md §2.4.1"],
    createdAt: "2026-09-24T10:00:00+09:00",
  }),
  seed({
    id: "subagent-permission-to-human",
    kind: "task",
    title: "サブエージェントの確認を人に上げる",
    status: "ready",
    parent: "subagent-human-loop",
    dependsOn: ["elicitation-answers"],
    milestone: "phase3",
    labels: ["subagent"],
    body: "main と揃えたモードでは普通の仕事で確認は来ない（実測）が、来たときに人が答えられるようにする。",
    refs: ["docs/notes/2026-09-24-subagent-acp.md"],
    createdAt: "2026-09-24T10:00:00+09:00",
  }),
  seed({
    id: "subagent-banto-modules",
    kind: "task",
    title: "サブエージェントに banto の Module（FileSystem・Shell・Vault）を渡す",
    status: "backlog",
    parent: "subagent-human-loop",
    dependsOn: ["subagent-module-sync"],
    milestone: "phase3",
    labels: ["subagent"],
    body: "いまは `session/new` の mcpServers が空。サブエージェント向けの中継の口（URL と合言葉）を host が出す必要がある。",
    createdAt: "2026-09-24T10:00:00+09:00",
  }),
  seed({
    id: "subagent-codex",
    kind: "task",
    title: "Subagent に Codex を足す",
    status: "backlog",
    parent: "subagent-human-loop",
    dependsOn: ["subagent-banto-modules"],
    milestone: "phase3",
    priority: "low",
    labels: ["subagent"],
    body: "設定を1つ足すだけで済むかが、差し替えられる形にできたかの試金石。",
    createdAt: "2026-09-24T10:00:00+09:00",
  }),
  seed({
    id: "subagent-module-sync",
    kind: "task",
    title: "Subagent Module（待つ形）——Claude Code と OpenCode",
    status: "done",
    milestone: "phase3",
    labels: ["subagent"],
    threads: [{ projectId: "banto", threadId: "vault-migration-poc" }],
    createdAt: "2026-09-22T10:00:00+09:00",
    closedAt: "2026-09-24T21:00:00+09:00",
  }),
  seed({
    id: "thread-messaging",
    kind: "task",
    title: "Thread 間のメッセージ——AI が別の Thread の AI に送る",
    status: "backlog",
    dependsOn: ["subagent-module-sync"],
    milestone: "phase3",
    labels: ["未決"],
    body: [
      "届け方（記録してから起こす・ループ防止・画面の札）は 2026-09-25 に共通の口として作った。残るのは送る側：",
      "",
      "- 宛先の一覧の見せ方（id・題・状態だけ、中身は読ませない）",
      "- Project をまたぐ送信の許し方",
    ].join("\n"),
    refs: ["docs/specs/v4-architecture.md §4.2", "docs/notes/2026-09-25-thread-delivery.md"],
    createdAt: "2026-09-25T10:00:00+09:00",
  }),
  seed({
    id: "ai-attach-module",
    kind: "task",
    title: "AI が目録から Module を選び、人の承認で Project につける",
    status: "ready",
    milestone: "phase3",
    labels: ["module"],
    body: "AI に見せる一覧は banto の目録（同梱と、banto が中身を確かめて載せたもの）だけ。外部の Module は今までどおり人が自分で足す。",
    doneWhen: "AI が目録の Module を頼むと、受信箱の承認を経てその Project につき、その Module の道具が AI から呼べる",
    createdAt: "2026-09-27T10:00:00+09:00",
  }),

  // ---- 毎日使える画面 ----
  seed({
    id: "project-container-prewarm",
    kind: "task",
    title: "新しい Project のコンテナを先回りして作り置く",
    status: "backlog",
    milestone: "phase4",
    priority: "low",
    labels: ["速さ", "コンテナ"],
    body: "新しい Project の Module が揃うまで 1.5〜1.75 秒。うちコンテナを起こすのが約 0.9 秒（2026-09-26 の実測）。",
    doneWhen: "新しい Project を作ってから Module が揃うまでが、host のログの内訳で 1 秒を切る",
    refs: ["docs/notes/2026-09-26-latency-fixes.md"],
    createdAt: "2026-09-26T10:00:00+09:00",
  }),
  seed({
    id: "turn-latest-on-return",
    kind: "task",
    title: "戻ってきたら、最新の状況をそのまま出す",
    status: "done",
    milestone: "phase4",
    labels: ["画面"],
    threads: [{ projectId: "banto", threadId: "ui-perf" }],
    createdAt: "2026-09-15T10:00:00+09:00",
    closedAt: "2026-09-18T10:00:00+09:00",
  }),

  // ---- マイルストーン無し（バグと、まだ置き場の決まらないもの） ----
  seed({
    id: "human-canvas-call-blocked-by-concurrent-turn",
    kind: "bug",
    title: "AI が同じ Module を使っている最中だと、人が画面で押した操作が無言で止まる",
    status: "in-progress",
    priority: "high",
    labels: ["中継"],
    body: [
      "出所の判定が呼び出しごとではなく Module のプロセス単位。1つでもターン由来が混ざっていたら、人の操作もターンの扱いになり承認ゲートに落ちる。",
      "",
      "押した画面は**何も言わずに最大10分待つ**。",
      "",
      "2026-09-21、E2E で実測：`deleteAlias` が同じターンの横断読み取りと重なって毎回止まった。",
    ].join("\n"),
    doneWhen: "AI がその Module を使っている最中に人が押しても、承認を挟まずに通る（試験で再現してから直す）",
    threads: [{ projectId: "banto", threadId: "vault-migration-poc" }],
    createdAt: "2026-09-21T10:00:00+09:00",
    updatedAt: "2026-10-01T10:00:00+09:00",
  }),
  seed({
    id: "judgment-answer-render-race",
    kind: "bug",
    title: "承認に答えた直後にターンが終わると、答えが画面に出ない",
    status: "ready",
    priority: "high",
    labels: ["承認"],
    body: [
      "画面は host に答えを送るのを待ってから、答えを記録に書き戻す。**その間に host 側のターンが完走すると SSE が先に閉じ**、答えが描かれないまま終わる。",
      "",
      "偽 Runner 側に 500ms の間を入れて回避しているが、画面側の競合はそのまま残っている。",
    ].join("\n"),
    doneWhen: "偽 Runner の間を外した状態で、「回答：許可する」が画面に残る",
    refs: ["docs/notes/2026-09-20-infisical-cloud-and-vault-list.md"],
    createdAt: "2026-09-21T10:00:00+09:00",
  }),
  seed({
    id: "fork-inline-fullscreen",
    kind: "bug",
    title: "Fork の会話の中の Module 画面を「大きく表示」できない",
    status: "ready",
    labels: ["fork"],
    body: "Fork で showFile の「大きく表示」を押すと「大きく表示できませんでした」と出る。Fork の会話に Canvas を開く口を渡していない見込み（未確認）。",
    doneWhen: "Fork の会話の中の画面を大きく表示でき、Fork を開いたまま Canvas が右に乗る",
    createdAt: "2026-09-27T10:00:00+09:00",
  }),
  seed({
    id: "relay-grant-codeid-not-bound",
    kind: "bug",
    title: "外から繋いだ宛先への承認が、コードの印に縛られていない",
    status: "ready",
    labels: ["セキュリティ", "中継"],
    body: "登録を消して別のサーバを同じ名前で繋ぐと、前の承認がそのまま効く。仕様は「縛る」と書いている——仕様と実装の食い違い。",
    doneWhen: "同じ名前で別のコードを繋いだら、聞き直す（試験で）",
    refs: ["docs/specs/v4-security.md §3"],
    createdAt: "2026-09-25T10:00:00+09:00",
  }),
  seed({
    id: "e2e-typecheck-red",
    kind: "bug",
    title: "e2e の型検査が赤い・そもそも型検査に入っていない",
    status: "ready",
    priority: "low",
    labels: ["試験"],
    body: "`oauth-mcp-fixture.ts` で11件落ちる。e2e の package.json に typecheck が無く、ルートの型検査から外れているので誰も気づいていなかった。",
    doneWhen: "ルートの npm run typecheck が e2e も見て通る",
    refs: ["banto/e2e/oauth-mcp-fixture.ts:52"],
    createdAt: "2026-09-26T10:00:00+09:00",
  }),
  seed({
    id: "frontend-lint-red",
    kind: "bug",
    title: "フロントの npm run lint が赤い",
    status: "done",
    priority: "low",
    labels: ["試験"],
    body: "react-hooks の指摘6件・トークンの検査5件・E2E のビルド成果物を見ていた250件。",
    createdAt: "2026-09-25T10:00:00+09:00",
    closedAt: "2026-09-29T10:00:00+09:00",
  }),
  seed({
    id: "shell-worktree-project-git",
    kind: "task",
    title: "git の worktree を根にした Project で、Shell の git が使えない",
    status: "backlog",
    labels: ["未決", "shell"],
    body: "worktree の `.git` はファイルで、実体が根の外にある。直すには本体の `.git` を閉じ込めの許可に足すことになり、本体のリポジトリ全体に触れる——広げてよいかは人の判断。",
    refs: ["docs/notes/2026-09-23-shell-home.md"],
    createdAt: "2026-09-23T10:00:00+09:00",
  }),
  seed({
    id: "landlock-proc-allowlist",
    kind: "task",
    title: "Landlock の許可リストから /proc を外す",
    status: "dropped",
    labels: ["shell"],
    resolution: "やらないと決めた——閉じ込めを Project ごとのコンテナへ移し、Landlock そのものをやめた",
    createdAt: "2026-09-08T10:00:00+09:00",
    closedAt: "2026-09-27T10:00:00+09:00",
  }),
];

const hermesItems: BacklogItem[] = [
  seed({
    id: "embedding-recompute-cost",
    kind: "task",
    title: "埋め込みの再計算コストを測る",
    status: "in-progress",
    labels: ["計測"],
    threads: [{ projectId: "hermes", threadId: "hermes-embedding" }],
    doneWhen: "1万件の再計算にかかる時間と費用が数値で出る",
  }),
  seed({
    id: "recall-accuracy",
    kind: "task",
    title: "記憶の引き当ての精度を測る",
    status: "ready",
    dependsOn: ["embedding-recompute-cost"],
    labels: ["計測"],
  }),
  seed({
    id: "duplicate-memories",
    kind: "bug",
    title: "長い会話で、同じ記憶が2回出る",
    status: "backlog",
  }),
];

const backlogs: Record<string, BacklogFile> = {
  banto: {
    path: BACKLOG_DEFAULT_PATH,
    milestones: [
      { id: "phase2", title: "標準 Module を揃える", status: "open" },
      { id: "phase3", title: "並べて任せる", status: "open" },
      { id: "phase4", title: "毎日使える画面", status: "open" },
    ],
    items: bantoItems,
  },
  hermes: { path: BACKLOG_DEFAULT_PATH, milestones: [], items: hermesItems },
};

export function getBacklog(projectId: ProjectId): BacklogFile | undefined {
  return backlogs[projectId];
}

export function isClosed(item: BacklogItem): boolean {
  return item.status === "done" || item.status === "dropped";
}

/** まだ終わっていない依存（§4.4「依存が全部終わった ready」の裏返し）。やめたものも終わっていない扱い */
export function waitingOn(item: BacklogItem, items: readonly BacklogItem[]): BacklogItem[] {
  return item.dependsOn
    .map((id) => items.find((i) => i.id === id))
    .filter((i): i is BacklogItem => i !== undefined && i.status !== "done");
}

/** いま着手できる——状態が ready で、依存が全部 done（listItems の「いま着手できるもの」と同じ条件） */
export function isActionable(item: BacklogItem, items: readonly BacklogItem[]): boolean {
  return item.status === "ready" && waitingOn(item, items).length === 0;
}

/** これを待っているもの（依存の逆向き） */
export function dependents(item: BacklogItem, items: readonly BacklogItem[]): BacklogItem[] {
  return items.filter((i) => i.dependsOn.includes(item.id));
}

export function childrenOf(story: BacklogItem, items: readonly BacklogItem[]): BacklogItem[] {
  return items.filter((i) => i.parent === story.id);
}

function now(): string {
  return new Date().toISOString();
}

function slug(title: string, items: readonly BacklogItem[]): string {
  // 題から読める名前を作る（英数字だけ拾う。拾えなければ item）。ぶつかったら番号を足す
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "item";
  let id = base;
  for (let n = 2; items.some((i) => i.id === id); n++) id = `${base}-${n}`;
  return id;
}

export interface NewBacklogItem {
  kind: BacklogKind;
  title: string;
  status?: BacklogStatus;
  parent?: string | null;
  dependsOn?: string[];
  milestone?: string | null;
  priority?: BacklogPriority;
  labels?: string[];
  body?: string;
  doneWhen?: string;
}

/**
 * 1件足す（createItem）。置き場所はファイルの末尾＝いちばん低い優先——ただし親があれば
 * 親の最後の子の後ろ（兄弟の中で末尾）にして、ストーリーの下にまとまって並ぶようにする
 */
export function createItem(projectId: ProjectId, input: NewBacklogItem): BacklogItem {
  const file = backlogs[projectId];
  if (!file) throw new Error(`Backlog がこの Project に無い：${projectId}`);
  const at = now();
  const parent = input.kind === "task" ? (input.parent ?? null) : null;
  const item: BacklogItem = {
    id: slug(input.title, file.items),
    kind: input.kind,
    title: input.title,
    status: input.status ?? "backlog",
    parent,
    dependsOn: input.dependsOn ?? [],
    milestone: parent
      ? (file.items.find((i) => i.id === parent)?.milestone ?? null)
      : (input.milestone ?? null),
    priority: input.priority ?? "normal",
    labels: input.labels ?? [],
    body: input.body ?? "",
    doneWhen: input.doneWhen ?? "",
    resolution: null,
    refs: [],
    threads: [],
    createdAt: at,
    updatedAt: at,
    closedAt: null,
  };
  const siblings = parent ? file.items.filter((i) => i.parent === parent || i.id === parent) : [];
  const after = siblings.at(-1);
  const index = after ? file.items.indexOf(after) + 1 : file.items.length;
  file.items = [...file.items.slice(0, index), item, ...file.items.slice(index)];
  notifyMockStoreChange();
  return item;
}

export type BacklogPatch = Partial<
  Pick<
    BacklogItem,
    "title" | "kind" | "status" | "parent" | "dependsOn" | "milestone" | "priority" | "labels" | "body" | "doneWhen" | "resolution"
  >
>;

/** 欄を変える（updateItem）。閉じれば closedAt、開き直せば resolution と closedAt を消す */
export function updateItem(projectId: ProjectId, id: string, patch: BacklogPatch): void {
  const file = backlogs[projectId];
  if (!file) return;
  const at = now();
  file.items = file.items.map((i) => {
    if (i.id !== id) return i;
    const next: BacklogItem = { ...i, ...patch, updatedAt: at };
    if (patch.status !== undefined && patch.status !== i.status) {
      const closed = isClosed(next);
      next.closedAt = closed ? at : null;
      if (!closed) next.resolution = null;
      if (next.status === "done") next.resolution = null;
    }
    if (next.kind !== "task") next.parent = null;
    return next;
  });
  notifyMockStoreChange();
}

export interface SplitTask {
  title: string;
  doneWhen?: string;
  /** 同じ回に作るタスクのうち、待つもの（何番目か） */
  waitsFor: number[];
}

/** ストーリーの下に複数のタスクを1回で作る（splitStory）。タスク間の依存つき */
export function splitStory(projectId: ProjectId, storyId: string, tasks: readonly SplitTask[]): BacklogItem[] {
  const created: BacklogItem[] = [];
  for (const t of tasks) {
    created.push(
      createItem(projectId, {
        kind: "task",
        title: t.title,
        status: "ready",
        parent: storyId,
        doneWhen: t.doneWhen,
        dependsOn: t.waitsFor.map((n) => created[n]?.id).filter((x): x is string => x !== undefined),
      }),
    );
  }
  return created;
}

/** 並び順（＝優先順）を、指定した項目の前か後ろへ動かす（moveItem） */
export function moveItem(projectId: ProjectId, id: string, targetId: string, where: "before" | "after"): void {
  const file = backlogs[projectId];
  if (!file || id === targetId) return;
  const moving = file.items.find((i) => i.id === id);
  if (!moving) return;
  const rest = file.items.filter((i) => i.id !== id);
  const t = rest.findIndex((i) => i.id === targetId);
  if (t < 0) return;
  const index = where === "before" ? t : t + 1;
  file.items = [...rest.slice(0, index), moving, ...rest.slice(index)];
  notifyMockStoreChange();
}
