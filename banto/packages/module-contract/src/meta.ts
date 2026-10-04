// docs/specs/v4-architecture.md §5.1・§5.4、docs/specs/v4-modules.md §2.1 の実装。
// `_meta["dev.banto/module"]` の型・parser・visibility解決。
// 接頭辞は `dev.banto`（決定・2026-09-02、実際にDNSを持つ必要はない——
// 逆DNS記法は名前空間衝突回避のための記法でしかない）。

export const VENDOR_PREFIX = "dev.banto";
export const MODULE_META_KEY = `${VENDOR_PREFIX}/module`;
export const VISIBILITY_META_KEY = `${VENDOR_PREFIX}/visibility`;
/**
 * その資源が**どの面か**（決定・2026-09-07）。いまは `"config"`（設定 Canvas）だけ。
 *
 * MCP Apps の仕様に「設定画面」という概念は無い（UI のライフサイクルは
 * 完全に tool 起点）。**ここは banto が足した拡張**であると自覚して扱う。
 * banto が全 Module に `ui://<id>/config` を投機的に読みにいく形にはしない
 * ——「在るかもしれない」を毎回試すと、無いのか壊れているのかが曖昧になる
 * （規則2、`docs/specs/v4-frontend.md` §6.2）。**Module が名乗る。**
 */
export const CANVAS_META_KEY = `${VENDOR_PREFIX}/canvas`;

/**
 * **その資源が Skill の本体（`SKILL.md`）であること**の印（決定・2026-09-23、
 * アーキ仕様 §5.6）。値は `true` だけ。
 *
 * 印の付いた資源は、**`name` に Skill の名前、`description` に Skill の説明**を
 * そのまま載せる（Agent Skills の frontmatter の2つの必須項目）。core はこの2つを
 * 一覧から読んで `instructions` を組み立てる——**本体を毎回読みに行かない**。
 * 真実は `SKILL.md` の frontmatter で、一覧はそれを Module が毎回そこから
 * 導いたもの（写しを保存しない、規則3）。
 *
 * `references/` などの兄弟資源には付けない——あれは Skill ではなく、
 * Skill の本文から URI で指される資料である。
 */
export const SKILL_META_KEY = `${VENDOR_PREFIX}/skill`;

/** その資源が Skill の本体だと名乗っているか。**`true` 以外は全部「違う」。** */
export function isSkillResource(x: { _meta?: Record<string, unknown> }): boolean {
  return x._meta?.[SKILL_META_KEY] === true;
}

/**
 * Agent Skills の仕様（`agentskills.io`）が決めている名前と説明の形。
 * **形式は発明しない**——ここに書くのは仕様の写しで、banto の独自の制約ではない。
 *
 * - 名前：1〜64字、英小文字・数字・`-`。`-` で始まらず終わらず、`--` を含まない
 * - 説明：1〜1024字
 */
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** 名前と説明が仕様の形に収まっているか。**収まっていなければ、何が違うかを返す。** */
export function skillEntryProblem(name: unknown, description: unknown): string | undefined {
  if (typeof name !== "string" || name.length === 0) return "名前がありません";
  if (name.length > SKILL_NAME_MAX) return `名前が ${SKILL_NAME_MAX} 字を超えています（${name.length} 字）`;
  if (!SKILL_NAME_PATTERN.test(name)) {
    return `名前「${name}」が形に合いません（英小文字・数字・「-」だけ。「-」で始まらず終わらず、続けない）`;
  }
  if (typeof description !== "string" || description.trim().length === 0) return "説明がありません";
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return `説明が ${SKILL_DESCRIPTION_MAX} 字を超えています（${description.length} 字）`;
  }
  return undefined;
}

/**
 * その tool が**秘密の値を返さない**ことの申告（決定・2026-09-12）。
 *
 * Module 間中継の承認ゲートが守っているのは**値**であって、名前ではない
 * ——`relayListTargets` を承認も監査も通さないのは、返すのが名前と role
 * だけだから（アーキ仕様 §2.5）。同じ理由で、**一覧・検索のような
 * 「値を返さない口」は初回の承認を要らないことにする**。
 *
 * **無指定は「返す」扱い**（fail closed）。第三者の Module はこのキーを
 * 持たないので、既定を「返さない」にすると、名乗らないだけで承認を
 * すり抜けられることになる。**名乗った Module だけが緩む。**
 */
export const VALUE_FREE_META_KEY = `${VENDOR_PREFIX}/valueFree`;

/**
 * **その呼び出しが、どの Project のためのものか**（決定・2026-09-13）。
 *
 * host が中継するときに刻む——**Module に自己申告させない**（申告なら詐称できる）。
 * Vault の「この alias はどの Project から使えるか」は、これが根拠になる。
 *
 * 値は `{ project: "<id>" }` か `{ admin: true }`（人が管理画面から直接触っている）。
 * **刻印が無い呼び出しは「決められない」**——受け手は fail closed で止める
 * （規則2。既定を「全部見える」にすると、名乗らないだけで制限をすり抜けられる）。
 */
export const CALLER_META_KEY = `${VENDOR_PREFIX}/caller`;

/**
 * **誰のための呼び出しか**。host だけが刻む（Module の自己申告ではない）。
 *
 * - `{project}`——その Project のための呼び出し。Project のグループ＋共通が使える
 * - `{admin: true}`——人が管理画面から触っている。全部見える
 *   - **`forProject`**（追加・2026-09-28）——人が**ある Project の画面**（会話の中・入口・設定）から押したとき、
 *     その Project の id を併記する。人の操作である印（`admin`）はそのまま。**名前を `project` にしない**：
 *     受け手は `"project" in stamp` で Project の刻印かを見ているので、同じ名前を併記すると人の刻印が
 *     Project の刻印に化ける受け手が出る（vault-kit の `findAlias` は `"project" in` を先に見る）。別の名前なら、今までの受け手には
 *     今までどおりの `{admin: true}` にしか見えない
 * - `{instance: true}`——**banto 全体のための呼び出し**（追加・2026-09-16）。
 *   `${secret:…}` を banto 全体に1本の Module へ差し込むときに使う。
 *   **Project が決まらないので、共通の秘密だけ**（規則2——曖昧なら広げない）
 */
export type CallerStamp = { project: string } | { admin: true; forProject?: string } | { instance: true };

/**
 * **コンテナの中の呼び出し元にも見える、host 側のフォルダ**（追加・2026-09-27）。host だけが刻む。
 *
 * Vault が鍵の窓口（ssh-agent）を host の `/tmp` に立てると、Project のコンテナの中の Shell からは
 * 見えない（2026-09-25 にコンテナへ移してから `sshIdentity` が使えなくなっていた）。host の Unix ソケットは、
 * マウントしたフォルダ越しならコンテナの中の同じ uid から届く（実測・2026-09-27）。そこで host が
 * 「呼び出し元の Module の置き場の中の、窓口用のフォルダ」を刻み、Vault はそこに窓口を立てる。
 * **呼び出し元の申告ではない**——中継は呼び出し元の `_meta` を使わずに刻印を組み立てる
 */
export const SOCKET_DIR_META_KEY = `${VENDOR_PREFIX}/socketDir`;

/** 刻印からフォルダを読む。絶対パスでなければ `undefined` */
export function socketDirOf(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.[SOCKET_DIR_META_KEY];
  return typeof raw === "string" && raw.startsWith("/") ? raw : undefined;
}

/**
 * **host がその Module を呼んだ、1件の呼び出しの印**（追加・2026-09-28）。host だけが刻む（推測できない印）。
 *
 * Module は**その呼び出しを処理している間に中継を呼ぶなら、この印を中継の呼び出しの `_meta` に同じ名前で返す**。
 * host の台帳（`ModuleCallTracker`）は出所（人の画面か AI のターンか）・Thread・Project を**呼び出し単位で**持っていて、
 * 印があればその1件を引く。**無ければ接続単位**（その Module に走っている呼び出しを全部合わせ、混ざっていたら
 * 厳しいほう）——banto 全体に1本の Module は、ある Project の AI のターンと人の画面を同時に処理しうるので、
 * 接続単位だと人の承認が AI のターンの刻印で断られる（2026-09-28、Fable のレビュー）。
 *
 * 形は分散トレースの文脈の受け渡し（W3C Trace Context の `traceparent`）と、返信用の札（`REPLY_TO_META_KEY`）と同じ
 * ——呼ばれた側が印を受け取り、下流へ渡すときに添える。**host が信じるのは同梱の Module が返した印だけ**
 * （第三者は同時に走っている自分の呼び出しのうち緩いほうを選べてしまうので、今までどおり接続単位）
 */
export const CALL_ID_META_KEY = `${VENDOR_PREFIX}/callId`;

/** 呼び出しの印を読む。文字列でなければ `undefined` */
export function callIdOf(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.[CALL_ID_META_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * **その呼び出しが、どの Thread の AI のターンから来たか**（追加・2026-10-03、Backlog の「取り組んだ Thread」）。
 * host だけが刻む——AI の代理接続（`agent-proxy`）が、ターンの Project と Thread を知っているときだけ。
 *
 * 値は `{ projectId, threadId }`。**人の画面からの呼び出し・Module 間の中継には刻まない**（AI のターンではないので、
 * 「その Thread で取り組んだ」とは言えない）。受け手は**刻印が無ければ何もしない**——推測で埋めない。
 *
 * 返信用の札（`REPLY_TO_META_KEY`）と違い、Thread の id そのものを渡す。札は「届ける」ための推測できない印で、
 * こちらは「どこで取り組んだかを記録に残す」ための名前（記録に残すので、札では役に立たない）
 */
export const THREAD_META_KEY = `${VENDOR_PREFIX}/thread`;

export interface ThreadStamp {
  projectId: string;
  threadId: string;
}

/** Thread の刻印を読む。**形が違えば `undefined`**（片方だけ・空文字は刻印ではない） */
export function threadOf(meta: Record<string, unknown> | undefined): ThreadStamp | undefined {
  const raw = meta?.[THREAD_META_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const { projectId, threadId } = raw as Record<string, unknown>;
  if (typeof projectId !== "string" || projectId === "" || typeof threadId !== "string" || threadId === "") {
    return undefined;
  }
  return { projectId, threadId };
}

/**
 * **中継が、いまどの Project のための呼び出しとして扱っているか**（追加・2026-09-28）。`relayListTargets` の返事の
 * `_meta` に host が載せる。宛先の一覧に Project の Module が出ないとき、「その Project に無い」のか「どの Project の
 * ための呼び出しか決められなかった」のかを、呼び出し元が取り違えないため（規則2——「無い」と「決められない」を混ぜない）
 */
export const ON_BEHALF_OF_META_KEY = `${VENDOR_PREFIX}/onBehalfOf`;

/** 刻印を読む。**形が違えば `undefined`**——「たぶんこう」で通さない。 */
export function callerOf(meta: Record<string, unknown> | undefined): CallerStamp | undefined {
  const raw = meta?.[CALLER_META_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const obj = raw as Record<string, unknown>;
  if (obj.admin === true) {
    return typeof obj.forProject === "string" && obj.forProject !== "" ? { admin: true, forProject: obj.forProject } : { admin: true };
  }
  if (obj.instance === true) return { instance: true };
  if (typeof obj.project === "string" && obj.project !== "") return { project: obj.project };
  return undefined;
}

/**
 * **監査に残してよい引数の名前**（追加・2026-09-15、規則8 で上がった穴の決着）。
 *
 * 仕様（`v4-architecture.md`）は「引数のうち、**値そのものではなく
 * 『何を指しているかの識別子』（例：Vault の alias 名）は記録してよい**」と
 * 決めているのに、実装は引数を1つも記録していなかった。その結果
 * **「誰がどの秘密を消したか」が後から追えない**——監査として肝心のところが空。
 *
 * **どの引数が識別子かは、その tool を持つ Module しか知らない。**
 * banto が推測すると、いつか秘密の入った引数を記録する（`createAlias` の
 * `value` など）。**名乗っていない引数は1つも記録しない**（fail closed）。
 */
export const AUDIT_ARGS_META_KEY = "dev.banto/auditArgs";

/** その tool が「この引数は識別子だから記録してよい」と名乗ったもの。 */
export function auditArgsOf(x: { _meta?: Record<string, unknown> }): string[] {
  const raw = x._meta?.[AUDIT_ARGS_META_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter((k): k is string => typeof k === "string");
}

/**
 * **終わったら呼び出し元の Thread に届ける tool**（追加・2026-09-25、アーキ仕様 §4.2「返信用の札」）。
 *
 * tool がこれを `true` で名乗ると、AI がその tool を呼んだときに host が**呼び出し元の Thread に結びついた札**を
 * 呼び出しの `_meta[REPLY_TO_META_KEY]` で渡す。Module は Thread の id を知らない——札で届ける
 * （host の中継の `relayDeliverToThread`）。Slack の `response_url` と同じ形（規則12）。
 */
export const DELIVERS_LATER_META_KEY = `${VENDOR_PREFIX}/deliversLater`;
/** host が渡す返信用の札（推測できない印）。**host だけが刻む**——tool の引数ではない */
export const REPLY_TO_META_KEY = `${VENDOR_PREFIX}/replyTo`;
/**
 * **この札で、あとで届ける**（tool の結果の `_meta` に `true`）。host は札を「返事待ち」として記録し、
 * Module が止まったら代わりに「途中で終わりました」を届ける——呼び出し元の AI が来ない返事を待ち続けない
 */
export const PENDING_REPLY_META_KEY = `${VENDOR_PREFIX}/pendingReply`;

/**
 * **何を待っているか**（追加・2026-10-04、ユーザー。v4-frontend.md §6.33）。「あとで届ける」（`PENDING_REPLY_META_KEY`）と
 * 一緒に tool の結果の `_meta` に載せる。値は `{ on: "human", title? }`——**人の答えを待っている**（公開の承認など）。
 * 載せなければ、裏で仕事が進んでいる（サブエージェントなど）とみなす。
 *
 * サイドバーは、人を待っているものを「あなたの番」として出し分ける——「バックグラウンド」と出すと放っておいてよいものに
 * 見える。`title` はサイドバーに出す1行（無ければカードの題、それも無ければ Module 名から作る）
 */
export const WAITING_ON_META_KEY = `${VENDOR_PREFIX}/waitingOn`;

export interface WaitingOn {
  on: "human";
  title?: string;
}

/** 何を待っているかを読む。**`on: "human"` のときだけ**返す（ほかは名乗っていない＝裏の仕事） */
export function waitingOnOf(meta: Record<string, unknown> | undefined): WaitingOn | undefined {
  const raw = meta?.[WAITING_ON_META_KEY];
  if (typeof raw !== "object" || raw === null) return undefined;
  const { on, title } = raw as Record<string, unknown>;
  if (on !== "human") return undefined;
  return { on, ...(typeof title === "string" && title.trim() !== "" ? { title: title.trim() } : {}) };
}

/** その tool が「終わったら呼び出し元の Thread に届ける」と名乗っているか。**`true` 以外は名乗っていない** */
export function deliversLater(x: { _meta?: Record<string, unknown> }): boolean {
  return x._meta?.[DELIVERS_LATER_META_KEY] === true;
}

/** 呼び出しに刻まれた返信用の札を読む（無ければ `undefined`） */
export function replyToOf(meta: Record<string, unknown> | undefined): string | undefined {
  const raw = meta?.[REPLY_TO_META_KEY];
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/**
 * **画面つきの tool を、会話には「開く」カードだけで残す**（決定・2026-10-01、ユーザー）。
 *
 * `_meta.ui.resourceUri` を持つ tool は、ふつうは結果が返ったところで会話の中に画面を埋める（§6.2）。
 * この印を付けた tool は**画面を埋めず**、呼んだその時点（結果を待たずに）から会話にカードを置き、
 * 押すと画面を Canvas に大きく開く——Fork の「この Fork を開く」と同じ形。走っている間も、終わってからも
 * 様子を見に行ける入口が要るもの（サブエージェントに頼んだ仕事など）に使う。
 *
 * 値は `{ title, description }`。どちらも文で、`{引数名}` をその呼び出しの引数（文字列・数・真偽）で置き換える
 * （例：`"{agent} に頼んだ仕事"`）。**MCP Apps の仕様には無い、banto が足した拡張。**
 */
export const CARD_META_KEY = `${VENDOR_PREFIX}/card`;

export interface ToolCardMeta {
  title?: string;
  description?: string;
}

/** tool が「会話にはカードだけ」と名乗っていればその中身を、名乗っていなければ `undefined` を返す */
export function toolCardOf(x: { _meta?: Record<string, unknown> }): ToolCardMeta | undefined {
  const raw = x._meta?.[CARD_META_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const { title, description } = raw as Record<string, unknown>;
  return {
    ...(typeof title === "string" ? { title } : {}),
    ...(typeof description === "string" ? { description } : {}),
  };
}

/** tool が名乗る画面（MCP Apps の `_meta.ui.resourceUri`）。無ければ `undefined` */
export function uiResourceUriOf(tool: unknown): string | undefined {
  const meta = (tool as { _meta?: { ui?: { resourceUri?: unknown } } })._meta;
  const uri = meta?.ui?.resourceUri;
  return typeof uri === "string" ? uri : undefined;
}

/**
 * カードの文の `{引数名}` を、その呼び出しの引数（文字列・数・真偽）で置き換える。**1行に収め**（改行は空白に）、
 * 80 字を超えれば畳む。引数に無い名前はそのまま残す（黙って消すと、Module の書き間違いに気づけない）。
 *
 * host がバックグラウンドの仕事の題を作るのに使う（追加・2026-10-03）。**画面（apps/frontend）にも同じものがある**
 * （`inline-module-view.tsx` の `fillCardText`）——画面は workspace のパッケージに依存していないため。変えるなら両方
 */
export function fillCardText(template: string | undefined, args?: Record<string, unknown>): string | undefined {
  if (!template) return undefined;
  const filled = template
    .replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name: string) => {
      const v = args?.[name];
      return typeof v === "string" || typeof v === "number" || typeof v === "boolean" ? String(v) : whole;
    })
    .replace(/\s+/g, " ")
    .trim();
  if (filled === "") return undefined;
  return filled.length > 80 ? `${filled.slice(0, 80)}…` : filled;
}

/** その tool が「値を返さない」と名乗っているか。**`true` 以外は全部「返す」。** */
export function isValueFree(x: { _meta?: Record<string, unknown> }): boolean {
  return x._meta?.[VALUE_FREE_META_KEY] === true;
}

export type Visibility = "agent" | "module" | "admin";
export const DEFAULT_VISIBILITY: Visibility = "agent";

export type Isolation = "in-process" | "subprocess";
export type Scope = "instance" | "project";

/**
 * **その Module がどこから来たか**（追加・2026-09-15）。
 *
 * **これは信頼の境界であって、表示のための札ではない。** banto に同梱された
 * 実装と、人が外から繋いだ第三者のコードでは、**許してよいことが違う**
 * ——`valueFree` で承認を飛ばす・敏感な役割を名乗る・閉じ込め無しで立つ、は
 * どれも同梱にしか許せない（`docs/specs/v4-security.md`）。
 *
 * **`bundled` は host だけが付けられる。** 人や差分（overlay）が名乗っても
 * 受け付けない——名乗れたら境界の意味が無い。
 */
export type ModuleOrigin = "bundled" | "external";

/**
 * **同梱の実装だけが名乗ってよい役割**（追加・2026-09-15、レビューで発覚）。
 *
 * `satisfies` は自己申告で、`SPAWN_SHAPE_FIELDS` の厳格さが掛かっていない。
 * 第三者が `vault-directory` を名乗れれば、**AI と Shell が話す窓口になりうる**
 * ——alias 名を全部観測し、値を取りに行く先を自分の実装へ向けられる。
 * `shell` を名乗れば閉じ込めの緩い profile（`exec`）を得られる。
 *
 * **これらは banto の骨格そのものなので、外から名乗らせない。**
 * 第三者が拡張したいのは「新しい役割」であって、既にある骨格の乗っ取りではない。
 */
export const RESERVED_ROLES = ["shell", "filesystem", "vault", "vault-directory"] as const;

/**
 * **instance 全体で1本しか居てはいけない役割**（追加・2026-09-15）。
 *
 * 束ね役（窓口）は「複数を1つに見せる」ためのものなので、**それ自体が
 * 複数あると意味が消える**——呼ぶ側（Shell）は「唯一の1本」を引けなくなる。
 * **A 面を持つかどうかからは導出できない**（A 面を持たない2本目の窓口実装は
 * 理屈の上では作れてしまうため）ので、ここに明示で持つ。
 */
export const SINGLETON_ROLES = ["vault-directory"] as const;

export interface RoleDependency {
  role: string;
  required: boolean;
}

export interface Confinement {
  kind: "landlock";
  /**
   * 閉じ込めの根（追加・2026-09-15）。
   *
   * `project` は Project の根まで読み書きできる。**`none` は根を持たない**
   * ——banto 全体に1本の Module 用。許すのは node・動的リンカ・`/dev`・`/etc`・
   * その Module 自身の置き場だけで、**`~/.claude` も `~/.config/banto` も読めない**。
   *
   * これが無かったので、**instance の Module は閉じ込めようが無かった**
   * ——結果、外から繋いだ instance の Module を起動できなかった。
   */
  root: "project" | "none";
  /**
   * 許す広さ（追加・2026-09-15、レビューで発覚）。
   *
   * 以前は host が **`satisfies.includes("shell")` から決めていた**ので、
   * **`shell` を名乗るだけで広いほう（PATH の実行を許す）を取れた**
   * ——自己申告が閉じ込めの強さを決めてしまっていた。宣言で持つ。
   */
  profile: "exec" | "files-only";
}

export interface BantoModuleMeta {
  /** どこから来たか。**host だけが `bundled` を付けられる**（上記）。既定 `external`。 */
  origin: ModuleOrigin;
  satisfies: string[];
  dependsOn: RoleDependency[];
  isolation: Isolation;
  /** Module自身のバックエンドコードが平文の値を変数・引数として受け取るか。既定false。 */
  handlesSecrets: boolean;
  /** 既定 "instance"。"project" は Shell/FileSystemのようにLandlockで
   *  Project単位にプロセスを分ける必要があるModule向け。 */
  scope: Scope;
  confinement?: Confinement;
}

export class ModuleMetaError extends Error {}

function isRoleDependency(x: unknown): x is RoleDependency {
  return (
    typeof x === "object" &&
    x !== null &&
    typeof (x as RoleDependency).role === "string" &&
    typeof (x as RoleDependency).required === "boolean"
  );
}

/** 静的宣言・動的自己申告のどちらもこの1つのparserを通す（規則3）。 */
export function parseModuleMeta(raw: unknown, source: string): BantoModuleMeta {
  if (typeof raw !== "object" || raw === null) {
    throw new ModuleMetaError(`${source}: ${MODULE_META_KEY} はオブジェクトである必要があります`);
  }
  const obj = raw as Record<string, unknown>;

  const satisfies = obj.satisfies;
  if (!Array.isArray(satisfies) || !satisfies.every((s) => typeof s === "string")) {
    throw new ModuleMetaError(`${source}: satisfies は string[] である必要があります`);
  }

  const dependsOnRaw = obj.dependsOn ?? [];
  if (!Array.isArray(dependsOnRaw) || !dependsOnRaw.every(isRoleDependency)) {
    throw new ModuleMetaError(`${source}: dependsOn は {role,required}[] である必要があります`);
  }

  const isolation = obj.isolation;
  if (isolation !== "in-process" && isolation !== "subprocess") {
    throw new ModuleMetaError(`${source}: isolation は必須で in-process か subprocess`);
  }

  // **書き間違いを「無指定」と同じに扱わない**（決定・2026-09-10）。
  // 既定（handlesSecrets:false / scope:"instance"）は**キーが無いとき**の話であって、
  // 値が壊れているときの話ではない——`"handlesSecrets": "true"`（文字列）や
  // `"scope": "projekt"` を黙って緩い側に倒すと、秘密を扱う Module が in-process で
  // 立ち、Project ごとに分けるべき Module が1本で共有される（規則2）
  if (obj.handlesSecrets !== undefined && typeof obj.handlesSecrets !== "boolean") {
    throw new ModuleMetaError(
      `${source}: handlesSecrets は true か false（${JSON.stringify(obj.handlesSecrets)} が来ました）`,
    );
  }
  const handlesSecrets = obj.handlesSecrets === true;
  if (obj.scope !== undefined && obj.scope !== "instance" && obj.scope !== "project") {
    throw new ModuleMetaError(
      `${source}: scope は instance か project（${JSON.stringify(obj.scope)} が来ました）`,
    );
  }
  const scope: Scope = obj.scope === "project" ? "project" : "instance";

  let confinement: Confinement | undefined;
  if (obj.confinement !== undefined) {
    const c = obj.confinement as Record<string, unknown>;
    if (c.kind !== "landlock" || (c.root !== "project" && c.root !== "none")) {
      throw new ModuleMetaError(`${source}: confinement の形が不正です`);
    }
    // **広さは書いていなければ狭いほう**（追加・2026-09-15）。
    // 書き間違いを緩い側に倒さない（既存の handlesSecrets / scope と同じ姿勢）
    if (c.profile !== undefined && c.profile !== "exec" && c.profile !== "files-only") {
      throw new ModuleMetaError(
        `${source}: confinement.profile は exec か files-only（${JSON.stringify(c.profile)} が来ました）`,
      );
    }
    confinement = {
      kind: "landlock",
      root: c.root,
      profile: c.profile === "exec" ? "exec" : "files-only",
    };
  }

  // **`bundled` は host だけが付けられる**（上記 ModuleOrigin）。
  // **書いてあっても読まない**——parse の出口は必ず `external` で、
  // 印を立てられるのは host の `markBundled()` だけ。捨てるのであって
  // 「緩いほうへ倒す」のではない（規則2）——宣言に決める権利が無いという話

  const meta: BantoModuleMeta = {
    origin: "external",
    satisfies,
    dependsOn: dependsOnRaw as RoleDependency[],
    isolation,
    handlesSecrets,
    scope,
    confinement,
  };

  assertConsistent(meta, source);
  return meta;
}

/**
 * docs/specs/v4-modules.md §2.1「VaultUIのisolation」・
 * docs/specs/v4-security.md「Projectの根はModule起動時に確定させる」の
 * 機械チェック。読み違えたまま動かさない（規則2）。
 */
function assertConsistent(meta: BantoModuleMeta, source: string): void {
  if (meta.handlesSecrets && meta.isolation === "in-process") {
    throw new ModuleMetaError(
      `${source}: handlesSecrets:true の Module は isolation:"in-process" を宣言できません`,
    );
  }

  if (meta.confinement && meta.isolation !== "subprocess") {
    throw new ModuleMetaError(`${source}: confinement を持つには isolation:"subprocess" が必要です`);
  }
  // **根が Project なら、Project ごとに立つ Module でなければならない**
  // （instance に1本の Module には渡す根が無い）。逆に `root: "none"` は
  // どちらでもよい——根を持たない閉じ込めは Project の有無と関係しない
  if (meta.confinement?.root === "project" && meta.scope !== "project") {
    throw new ModuleMetaError(
      `${source}: confinement の根が "project" なら scope:"project" が必要です`,
    );
  }
}

/**
 * 食い違いを検出したら差し替えてよいフィールドと、してはいけないフィールドを分ける
 * （決定・2026-09-03）。spawn の仕方を左右する4つは、動的自己申告のほうが正しいと
 * 分かっても「読み替えるだけ」では済まない——呼び出し側が再spawnする責任を持つ。
 */
/**
 * **同梱の印を立てる。host だけが呼ぶ**（`DEFAULT_MODULE_DECLARATIONS` の parse 後）。
 *
 * parse は必ず `external` を返すので、**印は「host がこの経路を通した」ことの
 * 証拠**になる。差分（overlay）で足された宣言はこの経路を通らないので `external`。
 */
export function markBundled(meta: BantoModuleMeta, source: string): BantoModuleMeta {
  const marked: BantoModuleMeta = { ...meta, origin: "bundled" };
  assertConsistent(marked, source);
  return marked;
}

/**
 * **骨格の役割は、同梱だけが名乗れる**（追加・2026-09-15、レビューで発覚）。
 *
 * parse の中ではできない——parse は必ず `external` を返すので、そこで検査すると
 * **同梱も弾かれる**。origin が決まったあと（host が `markBundled` を通したあと）
 * に呼ぶ。
 *
 * 第三者が `vault-directory` を名乗れれば **AI と Shell が話す窓口になりうる**
 * （alias 名を全部観測し、値を取りに行く先を自分の実装へ向けられる）。
 * `shell` を名乗れば閉じ込めの緩い profile を得られた（そちらは宣言へ移した）。
 */
export function assertRolesAllowed(meta: BantoModuleMeta, source: string): void {
  if (meta.origin === "bundled") return;
  const taken = meta.satisfies.filter((r) => (RESERVED_ROLES as readonly string[]).includes(r));
  if (taken.length > 0) {
    throw new ModuleMetaError(
      `${source}: ${taken.join("・")} は banto 同梱の実装だけが名乗れる役割です` +
        "（外から繋ぐ Module は、別の名前の役割を名乗ってください）",
    );
  }
}

export const SPAWN_SHAPE_FIELDS = ["scope", "isolation", "handlesSecrets", "confinement"] as const;

export interface ReconcileResult {
  reconciled: BantoModuleMeta;
  /** true なら呼び出し側は接続を切って正しい形で再spawnしなければならない。 */
  requiresRespawn: boolean;
  changedFields: string[];
}

/**
 * 宣言（Config）と自己申告（Module）の食い違いを、**方向で**分ける
 * （決定・2026-09-06）。
 *
 * **Module の申告は「より厳しくする方向にだけ効く情報」**として扱う。
 * Module は他人が書いたものでありうるので、「私は秘密を扱いません、
 * 閉じ込めは要りません」という自己申告を鵜呑みにして隔離を外すのは、
 * 攻撃者にとって一番都合のいい形になる。**運用者の意図（Config）が上位**。
 *
 * - `stricter`：Module のほうが厳しい → Config を直して起動し直してよい（安全側）
 * - `looser`：Module のほうが緩い → **従わない。繋がずに人に上げる**
 * - `other`：起動の形に関わらない差分（役割名など）→ 記録して続行してよい
 */
export interface MetaDifference {
  stricter: string[];
  looser: string[];
  other: string[];
}

/** その項目について、a は b より厳しいか。 */
function isStricter(field: (typeof SPAWN_SHAPE_FIELDS)[number], a: BantoModuleMeta, b: BantoModuleMeta): boolean {
  switch (field) {
    case "scope":
      // Project ごとに分ける方が、instance に1本より厳しい
      return a.scope === "project" && b.scope === "instance";
    case "isolation":
      return a.isolation === "subprocess" && b.isolation === "in-process";
    case "handlesSecrets":
      // 「秘密を扱う」と申告する方が厳しい（追加の検査が掛かる）
      return a.handlesSecrets && !b.handlesSecrets;
    case "confinement":
      return a.confinement !== undefined && b.confinement === undefined;
  }
}

export function classifyMetaDifference(
  declared: BantoModuleMeta,
  selfReported: BantoModuleMeta,
): MetaDifference {
  const stricter: string[] = [];
  const looser: string[] = [];
  const other: string[] = [];

  for (const field of SPAWN_SHAPE_FIELDS) {
    if (JSON.stringify(declared[field]) === JSON.stringify(selfReported[field])) continue;
    if (isStricter(field, selfReported, declared)) stricter.push(field);
    else if (isStricter(field, declared, selfReported)) looser.push(field);
    else other.push(field);
  }
  if (JSON.stringify(declared.satisfies) !== JSON.stringify(selfReported.satisfies)) other.push("satisfies");
  if (JSON.stringify(declared.dependsOn) !== JSON.stringify(selfReported.dependsOn)) other.push("dependsOn");

  return { stricter, looser, other };
}

export function reconcileModuleMeta(
  staticMeta: BantoModuleMeta,
  dynamicMeta: BantoModuleMeta,
): ReconcileResult {
  const changedFields: string[] = [];
  let requiresRespawn = false;

  for (const field of SPAWN_SHAPE_FIELDS) {
    const a = JSON.stringify(staticMeta[field]);
    const b = JSON.stringify(dynamicMeta[field]);
    if (a !== b) {
      changedFields.push(field);
      requiresRespawn = true;
    }
  }
  if (JSON.stringify(staticMeta.satisfies) !== JSON.stringify(dynamicMeta.satisfies)) {
    changedFields.push("satisfies");
  }
  if (JSON.stringify(staticMeta.dependsOn) !== JSON.stringify(dynamicMeta.dependsOn)) {
    changedFields.push("dependsOn");
  }

  // 動的自己申告を正とする（satisfies/dependsOnはルーティングにしか
  // 影響しないので、そのまま採用してよい）。
  return { reconciled: dynamicMeta, requiresRespawn, changedFields };
}

/** 全 tool/resource が明示的な visibility を持つかを確認する
 *（handlesSecrets:true の Module に要求される、決定・2026-09-03）。 */
export function assertAllVisibilityExplicit(
  entries: Array<{ name: string; meta?: Record<string, unknown> }>,
  source: string,
): void {
  for (const e of entries) {
    const v = e.meta?.[VISIBILITY_META_KEY];
    if (v === undefined) {
      throw new ModuleMetaError(
        `${source}: handlesSecrets:true の Module は全 tool/resource に明示的な ` +
          `${VISIBILITY_META_KEY} が必要です（${e.name} に無い）`,
      );
    }
  }
}

/**
 * その tool/resource を誰に見せるか。
 *
 * **キーが無い＝既定（`agent`）**。第三者の Module は banto 独自のこのキーを
 * 持たないので、無指定を `agent` にしないと何も動かない（`docs/specs/v4-modules.md` §2.1）。
 *
 * **ただし「書き間違い」は無指定ではない**（決定・2026-09-10）。`"modle"` のような
 * 値を既定に落とすと、**Module 専用のつもりの道具がいちばん緩い側（AI に見せる）へ
 * 転落する**。ここでは**いちばん狭い側**（`module`——AI にも画面にも出ない）へ倒し、
 * 入口（Module を繋ぐとき）では `assertVisibilityValues` で**繋がずに止める**。
 */
export function visibilityOf(x: { _meta?: Record<string, unknown> }): Visibility {
  const v = x._meta?.[VISIBILITY_META_KEY];
  if (v === undefined) return DEFAULT_VISIBILITY;
  return v === "agent" || v === "module" || v === "admin" ? v : "module";
}

/**
 * 宣言されている `visibility` の**値**が語彙の中にあることを確かめる
 * （決定・2026-09-10）。壊れた値を持つ Module は**繋がない**——黙って
 * 「いちばん狭い側」で動かすと、書いた人は自分の意図どおりだと思い続ける（規則2）。
 */
export function assertVisibilityValues(
  entries: Array<{ name: string; meta?: Record<string, unknown> }>,
  source: string,
): void {
  const broken = entries.filter((e) => {
    const v = e.meta?.[VISIBILITY_META_KEY];
    return v !== undefined && v !== "agent" && v !== "module" && v !== "admin";
  });
  if (broken.length === 0) return;
  const detail = broken
    .map((e) => `${e.name}=${JSON.stringify(e.meta?.[VISIBILITY_META_KEY])}`)
    .join(", ");
  throw new ModuleMetaError(
    `${source}: ${VISIBILITY_META_KEY} の値が agent / module / admin のどれでもありません（${detail}）`,
  );
}

/** dev.banto/ 接頭辞のキーだけを取り除く。他ベンダの _meta は残す。 */
export function stripBantoMeta<T extends { _meta?: Record<string, unknown> }>(x: T): T {
  if (!x._meta) return x;
  const kept: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x._meta)) {
    if (!k.startsWith(`${VENDOR_PREFIX}/`)) kept[k] = v;
  }
  return { ...x, _meta: Object.keys(kept).length > 0 ? kept : undefined };
}
