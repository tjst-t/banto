"use client";

// Module が描く画面を、隔離した上で埋め込む（決定・2026-09-06、§6.2）。
//
// **受け皿は公式のものを使う**（`@modelcontextprotocol/ext-apps` の AppBridge、
// 規則12）。自作すると、穴があっても静かだから。
//
// 二重 iframe：
//   banto の画面（このコンポーネント）
//     └ 外側 iframe … **別オリジン**（サンドボックスの口）で中継だけをする
//         └ 内側 iframe … Module の HTML が動く
// 別オリジンであることは仕様の要求。同一オリジンで中継すると、
// `allow-same-origin` を持つ内側から banto の中身に手が届いてしまう。
//
// **tool 呼び出しは AppBridge に任せず、必ず host の承認ゲートへ回す**
// （`_client` に null を渡し、`oncalltool` を自分で持つ）。仕様は
// 「host が同意を求めてよい」としか言っていないが、banto は必ず通す。

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AppBridge, PostMessageTransport, type McpUiHostContext } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  answerRealInboxItem,
  callRealUiTool,
  fetchRealUiConfig,
  fetchRealUiResource,
  listRealLaunchers,
  listRealUiSettings,
  type RealCanvasOwner,
  type RealUiResource,
} from "@/lib/backend/client";
import { getRealJudgments, refreshRealInbox } from "@/lib/backend/real-inbox";
import { getAllProjects, getProject } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";
import { prepareDownload, saveDownload, type PreparedDownload } from "@/lib/backend/canvas-download";
import { VIEW_STATE_KEY, serializeViewState } from "@/lib/backend/canvas-view-state";
import {
  decideNewProjectRequest,
  OPEN_NEW_PROJECT_METHOD,
  parseNewProjectParams,
  requestNewProject,
} from "@/lib/backend/canvas-new-project";
import { CLOSE_PROJECTS_METHOD, closeProjectsRequests, parseCloseProjectsParams } from "@/lib/backend/canvas-close-projects";
import { FOLDER_PREPARED_METHOD, parseFolderPrepared, type PreparedFolder } from "@/lib/backend/canvas-folder-prepared";
import { OPEN_PROJECT_METHOD, decideOpenProject, parseOpenProjectParams } from "@/lib/backend/canvas-open-project";
import { OPEN_SURFACE_METHOD, decideOpenSurface, parseOpenSurfaceParams, runOpenSurface } from "@/lib/backend/canvas-open-surface";
import { currentCanvasAppearance } from "@/lib/backend/canvas-host-styles";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

export interface ModuleCanvasProps {
  /** 誰の画面か。会話の中なら Thread、設定画面なら Project。 */
  owner: RealCanvasOwner;
  /** Module の名前（宣言の name）。 */
  server: string;
  /** 画面の資源（`ui://…`）。 */
  resourceUri: string;
  /** この画面を開くきっかけになった tool 呼び出し。
   *  **入口（launcher）から人が開いたときは無い**——仕様の `toolInfo` は
   *  「この App を起こした tool 呼び出し」なので、無いものを作らない（§6.2）。 */
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: unknown;
  displayMode: "inline" | "fullscreen";
  /** 画面が「大きく出して」と言ってきたとき（`ui/request-display-mode`）。
   *  **決めるのは host（banto）**——仕様どおり、要求であって指示ではない（§6.2）。 */
  onRequestFullscreen?: () => void;
  /** 前に預かった「見ている場所」（`dev.banto/view-state`、`lib/backend/canvas-view-state.ts`）。
   *  開き直したとき（リロード・別タブ）に画面へ返す。預かる場所が無い面では渡さない */
  viewState?: unknown;
  /** 画面が「見ている場所」を預けてきたとき。渡さなければ預からない（会話の中のカード等） */
  onViewStateChange?: (state: unknown) => void;
  /**
   * 画面が「このフォルダを用意した」と返してきたとき（`dev.banto/folder-prepared`、新しい Project の画面の枠の中だけ）。
   * 渡さなければ受けない
   */
  onFolderPrepared?: (folder: PreparedFolder) => void;
}

type CallToolResult = Parameters<AppBridge["sendToolResult"]>[0];

/**
 * 会話に載っている tool の結果を、仕様の `CallToolResult` の形に整える。
 *
 * **同じ中身が3つの形で流れてくる**（実測・2026-09-06）——Agent SDK の
 * `tool_result` は中身のブロック配列のことも、文字列のことも、
 * `{content:[…]}` のこともある。ここで揃えないと、画面には何も届かないのに
 * 画面は出たままになる（＝規則13 の「繋がっていないのに繋がって見える」）。
 */
function toCallToolResult(value: unknown): CallToolResult | undefined {
  if (typeof value === "string") return { content: [{ type: "text", text: value }] };
  if (Array.isArray(value)) return { content: value } as CallToolResult;
  if (typeof value === "object" && value !== null && Array.isArray((value as { content?: unknown }).content)) {
    return value as CallToolResult;
  }
  return undefined;
}

/** 依存配列に入れるための、相手を一意に表す文字列。 */
function ownerKey(owner: RealCanvasOwner): string {
  return owner.kind === "instance" ? "instance" : owner.id;
}

/**
 * その Canvas が**どの Project の上で開かれているか**。
 *
 * banto 全体の設定（`instance`）から開かれた画面には Project が無い
 * ——**無いものを作らない**（画面は「Project が渡ってこない＝全体の面だ」と
 * 分かる）。Thread から開かれた面は、その Thread の Project。
 */
function bantoProjectContext(owner: RealCanvasOwner): { id: string; name: string } | undefined {
  if (owner.kind === "instance") return undefined;
  const projectId = owner.kind === "project" ? owner.id : getThread(owner.id)?.projectId;
  if (!projectId) return undefined;
  return { id: projectId, name: getProject(projectId).name };
}

type LoadState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "ready"; sandboxUrl: string; resource: RealUiResource };

export function ModuleCanvas(props: ModuleCanvasProps) {
  const { owner, server, resourceUri } = props;
  const [state, setState] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [config, resource] = await Promise.all([
          fetchRealUiConfig(),
          fetchRealUiResource(owner, server, resourceUri),
        ]);
        if (cancelled) return;
        if (!config.sandboxUrl) {
          // **隔離できないなら出さない**（規則2）——素のまま埋めて代用しない
          setState({
            phase: "error",
            message: "サンドボックスの配信先が設定されていません（host の sandboxPublicUrl）",
          });
          return;
        }
        setState({ phase: "ready", sandboxUrl: config.sandboxUrl, resource });
      } catch (err) {
        if (!cancelled) {
          setState({ phase: "error", message: err instanceof Error ? err.message : String(err) });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [owner.kind, ownerKey(owner), server, resourceUri]);

  if (state.phase === "loading") {
    return <div className="p-3 text-xs text-ink-3">画面を読み込んでいます…</div>;
  }
  if (state.phase === "error") {
    return (
      <div className="p-3 text-xs text-stop" data-testid="module-canvas-error">
        画面を出せませんでした：{state.message}
      </div>
    );
  }
  return <SandboxFrame {...props} sandboxUrl={state.sandboxUrl} resource={state.resource} />;
}

function SandboxFrame({
  owner,
  server,
  toolName,
  toolArgs,
  toolResult,
  displayMode,
  onRequestFullscreen,
  viewState,
  onViewStateChange,
  onFolderPrepared,
  sandboxUrl,
  resource,
}: ModuleCanvasProps & { sandboxUrl: string; resource: RealUiResource }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  // 画面が頼んできたダウンロードのうち、**人の操作の直後でなかったもの**（下の ondownloadfile）
  const [pendingDownload, setPendingDownload] = useState<{
    files: PreparedDownload[];
    resolve: (ok: boolean) => void;
  } | null>(null);

  // **橋は、画面が変わったときにだけ張り直す**（`frontend-interaction-hardening`、
  // 2026-09-10）。以前は毎レンダー新しくなるもの（親が render 中に作る
  // `onRequestFullscreen`、tool の入出力オブジェクト）を効果の依存に置いていたので、
  // 親が再描画されるたびに **AppBridge を閉じて張り直していた**——実測（同日）：
  // Canvas を1つ出して Fork を開いて閉じるだけで **9回**。中身は生き延びていたが、
  // 張り直しの最中に飛んでいる呼び出しがあれば落ちる（規則2 の「黙って別の経路へ
  // 落ちない」が保てない）。**いま要る値は ref から読む**——依存に入れない。
  const router = useRouter();
  const navigate = (href: string) => router.push(href);
  const latest = useRef({ owner, server, toolArgs, toolResult, onRequestFullscreen, viewState, onViewStateChange, onFolderPrepared, navigate });
  useEffect(() => {
    latest.current = { owner, server, toolArgs, toolResult, onRequestFullscreen, viewState, onViewStateChange, onFolderPrepared, navigate };
  });
  // 張り直しは目に見えないので、**見えるところに出す**（規則4）——
  // 回帰試験はこの数字が増えないことを見る
  const generation = useRef(0);

  useEffect(() => {
    generation.current += 1;
    frameRef.current?.setAttribute("data-bridge-generation", String(generation.current));
    const frame = frameRef.current;
    if (!frame?.contentWindow) return;

    // host 側は「送る先」も「受ける元」も外側 iframe（message-transport.d.ts）
    const transport = new PostMessageTransport(frame.contentWindow, frame.contentWindow);
    const hostContext = {
      displayMode,
      availableDisplayModes: ["inline", "fullscreen"],
      // **明暗と、banto の色・段**（決定・2026-09-25、§6.27）。元は globals.css の層A——
      // 画面は banto の値の写しを持たない。明暗が変わったら下で渡し直す
      ...currentCanvasAppearance(),
      // **いまどこで開かれているか**（追加・2026-09-12）。Project のものを
      // 扱う画面（Vault の alias の割り当て先など）は、これが無いと
      // 「この Project」を指せない——人に UUID を選ばせることになる。
      //
      // `hostContext` は仕様が**追加の項目を認めている**（`McpUiHostContext`
      // の index signature、"for forward compatibility"）ので、新しい
      // 受け渡しの道を作らずに済む（規則12）。名前空間は他の banto 拡張と同じ。
      //
      // **渡すのは開かれた場所だけ**——Project の一覧を全部渡さない。
      // どの Canvas にも人の Project 名が全部見えることになる
      ...(bantoProjectContext(owner) ? { "dev.banto/project": bantoProjectContext(owner) } : {}),
      // **前に見ていた場所**（banto の拡張、2026-09-23）。画面が預けていったものを、
      // 開き直したときに返す——`dev.banto/project` と同じく仕様が認める追加の項目
      ...(latest.current.viewState !== undefined ? { [VIEW_STATE_KEY]: latest.current.viewState } : {}),
      // tool 起点のときだけ入れる。**無いものを作らない**——画面はこれが
      // 無いことで「人が直接開いた」と分かり、自分で必要なものを取りに行く
      ...(toolName ? { toolInfo: { tool: { name: toolName, inputSchema: { type: "object" } } } } : {}),
    } satisfies McpUiHostContext;
    // `_client` は null——**tool 呼び出しを素通しさせない**。下の oncalltool で
    // 受けて、host の承認ゲートへ回す
    // **ダウンロードは受ける**（`downloadFile`、追加・2026-09-23）——画面はサンドボックスの
    // 中にいて自分では保存させられないので、仕様が host に頼む口（`ui/download-file`）を
    // 用意している。受けると名乗った host にだけ、画面はダウンロードの口を出す
    const bridge = new AppBridge(null, { name: "banto", version: "0.1.0" }, { downloadFile: {}, openLinks: {} }, { hostContext });

    // **明暗が変わったら、色と一緒に渡し直す**（§6.27）——値は明暗ごとに違うので、渡し直さないと
    // 開いたままの画面が古い色に残る。明暗は next-themes が `<html>` の class で切り替える
    // （人の切り替えも、システムの切り替えも）。変わった項目だけが通知される（`setHostContext`）
    const themeObserver = new MutationObserver(() => {
      bridge.setHostContext({ ...hostContext, ...currentCanvasAppearance() });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    bridge.oncalltool = async (params) => {
      // **自分の Module を呼ぶのに承認は求めない**（改訂・2026-09-07、ユーザー指示）。
      // その画面を開いたのは人で、画面の中のボタンがその画面を出している Module の
      // tool を呼ぶのは、画面が仕事をしているだけ。**呼び先は画面が選べない**
      // ——この Canvas がどの Module のものかで決まる（下の `server`）。
      // AI からの呼び出しは今までどおり承認ゲートを通る（性質が違う）。
      const result = await callRealUiTool(
        latest.current.owner,
        server,
        params.name,
        params.arguments as Record<string, unknown> | undefined,
      );
      return result as Awaited<ReturnType<NonNullable<typeof bridge.oncalltool>>>;
    };

    // **画面からのダウンロード**（MCP Apps `ui/download-file`、追加・2026-09-23）。
    // 仕様は「host は保存の前に確かめるべき（SHOULD）」と言う。banto は
    // **人が画面の中を押した直後なら確かめない**——その操作がダウンロードの意思で、
    // もう一度聞くのは二度手間になる。押した直後かどうかはブラウザの
    // 「一時的な利用者の操作」（transient user activation）で見る。子の iframe の中の
    // 操作は親の画面にも伝わるので、banto の側から読める。**そうでない
    // （画面が勝手に頼んできた、または準備に時間がかかった）ときは banto の画面で確かめる**
    bridge.ondownloadfile = async ({ contents }) => {
      const files: PreparedDownload[] = [];
      for (const item of contents) {
        // resource_link（host が取りに行く形）は受けない——どこへ取りに行ってよいかを
        // banto は決めていない。**受けられないと答える**（黙って捨てない）
        if (item.type !== "resource") return { isError: true };
        files.push(prepareDownload(item.resource));
      }
      if (files.length === 0) return { isError: true };
      if (!navigator.userActivation?.isActive) {
        const ok = await new Promise<boolean>((resolve) => setPendingDownload({ files, resolve }));
        if (!ok) return { isError: true };
      }
      for (const file of files) saveDownload(file);
      return {};
    };

    // **画面が「見ている場所」を預けてくる**（banto の拡張、2026-09-23）。仕様に無い通知
    // なので、決まった受け口ではなく「知らない通知」の受け口で受ける。預かる場所が無い面
    // （会話の中のカード）では捨てる——知らない通知は無視してよい（JSON-RPC の通知）
    bridge.fallbackNotificationHandler = async (notification) => {
      if (notification.method !== VIEW_STATE_KEY) return;
      const state = (notification.params as { state?: unknown } | undefined)?.state;
      latest.current.onViewStateChange?.(state);
    };

    // **画面から「新しい Project の画面を、このフォルダで開いて」**（banto の拡張、2026-10-02、
    // `lib/backend/canvas-new-project.ts`）。仕様に無い request なので「知らない request」の受け口で受ける。
    // 開くのは確かめる画面だけ——Project を作るのは人がそこで押したとき
    bridge.fallbackRequestHandler = async (request) => {
      // JSON-RPC の決まった番号で断る（受け口は投げたものの `code` を返事に使う）
      const refuse = (code: number, message: string) => Object.assign(new Error(message), { code });
      const decideFrom = { fromConversation: latest.current.owner.kind === "thread", activated: navigator.userActivation?.isActive === true, from: latest.current.server };
      if (request.method === OPEN_NEW_PROJECT_METHOD) {
        const parsed = parseNewProjectParams(request.params);
        if ("error" in parsed) throw refuse(-32602, parsed.error);
        // 会話の中の画面（AI の tool の結果）からは、人が押した直後だけ。開いている間・開く場所が無い面では断る
        const decision = decideNewProjectRequest(decideFrom);
        if ("error" in decision) throw refuse(-32000, decision.error);
        requestNewProject({ ...parsed, from: latest.current.server });
        return {};
      }
      if (request.method === OPEN_PROJECT_METHOD) {
        const parsed = parseOpenProjectParams(request.params);
        if ("error" in parsed) throw refuse(-32602, parsed.error);
        const decision = decideOpenProject({ projectId: parsed.projectId, activated: decideFrom.activated, projects: getAllProjects() });
        if ("error" in decision) throw refuse(-32000, decision.error);
        latest.current.navigate(`/p/${parsed.projectId}`);
        return {};
      }
      if (request.method === OPEN_SURFACE_METHOD) {
        // **同じ Project の中の別の面へ移る**（`lib/backend/canvas-open-surface.ts`）。押した直後かは、一覧を取り直す前に見る
        const target = parseOpenSurfaceParams(request.params, latest.current.server);
        if ("error" in target) throw refuse(-32602, target.error);
        const projectId = bantoProjectContext(latest.current.owner)?.id;
        const outcome = await runOpenSurface(async () => {
          // 一覧は移る前に取り直す——画面が古い控えで「無い」と断られない（取れなければ理由を返す、規則2）
          const decision = decideOpenSurface({
            target,
            projectId,
            activated: decideFrom.activated,
            launchers: target.surface === "launcher" && projectId && decideFrom.activated ? await listRealLaunchers(projectId) : undefined,
            settings: target.surface === "settings" && projectId && decideFrom.activated ? await listRealUiSettings({ kind: "project", id: projectId }) : undefined,
            getThread,
            here: { pathname: window.location.pathname, search: window.location.search },
            serializeSelect: serializeViewState,
          });
          if ("error" in decision) return decision;
          latest.current.navigate(decision.href);
          return {};
        });
        if ("error" in outcome) throw refuse(-32000, outcome.error);
        return {};
      }
      if (request.method === CLOSE_PROJECTS_METHOD) {
        const parsed = parseCloseProjectsParams(request.params);
        if ("error" in parsed) throw refuse(-32602, parsed.error);
        const decision = closeProjectsRequests.decide(decideFrom);
        if ("error" in decision) throw refuse(-32000, decision.error);
        closeProjectsRequests.request({ ...parsed, from: latest.current.server });
        return {};
      }
      if (request.method === FOLDER_PREPARED_METHOD) {
        // 受けるのは新しい Project の画面の枠の中に出した画面だけ
        const onPrepared = latest.current.onFolderPrepared;
        if (!onPrepared) throw refuse(-32000, "この画面はフォルダを受け取る場所に出ていません（新しい Project の画面の中でだけ使えます）");
        const parsed = parseFolderPrepared(request.params);
        if ("error" in parsed) throw refuse(-32602, parsed.error);
        onPrepared(parsed);
        return {};
      }
      throw refuse(-32601, `Method not found: ${request.method}`);
    };

    // **画面からのリンクを開く**（MCP Apps `ui/open-link`、追加・2026-09-28——Publish の入口の「開く」）。
    // 画面はサンドボックスの中にいて、自分では新しいタブを開けない（`allow-popups` を付けていない）。
    // **開くのは http/https だけ・人が画面の中を押した直後だけ**——画面が勝手に頼んできたものは開かない
    // （ダウンロードと同じ「一時的な利用者の操作」で見る）。別のタブで、元の画面を触らせない形で開く
    bridge.onopenlink = async ({ url }) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { isError: true };
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { isError: true };
      if (!navigator.userActivation?.isActive) return { isError: true };
      const opened = window.open(parsed.href, "_blank", "noopener,noreferrer");
      // noopener のとき window.open は null を返す（開けたかどうかは分からない）——開けなかったとは言わない
      void opened;
      return {};
    };

    // 画面からの「大きく出して」（§6.2 の交渉モデル。**決めるのは banto**）
    bridge.onrequestdisplaymode = async ({ mode }) => {
      const onRequestFullscreen = latest.current.onRequestFullscreen;
      if (mode === "fullscreen" && onRequestFullscreen) {
        onRequestFullscreen();
        return { mode: "fullscreen" as const };
      }
      // 出せないものは**出せないと答える**（黙って無視しない）。いまの mode を返す
      return { mode: displayMode };
    };

    // 外側プロキシが立ち上がったら、Module の HTML を流し込む
    const onSandboxReady = () => {
      void bridge.sendSandboxResourceReady({
        html: resource.html,
        sandbox: "allow-scripts allow-same-origin allow-forms",
      });
    };
    bridge.addEventListener("sandboxready", onSandboxReady);

    // 画面が「これだけの高さが要る」と言ってきたら合わせる（inline は特に要る）
    const onSizeChange = (params: { height?: number }) => {
      if (typeof params.height === "number" && frameRef.current) {
        frameRef.current.style.height = `${Math.min(params.height, 800)}px`;
      }
    };
    if (displayMode === "inline") bridge.addEventListener("sizechange", onSizeChange);

    // きっかけになった tool の入出力を渡す——画面が自分で呼び直さずに描ける
    const onInitialized = () => {
      // tool 起点でないなら、渡すものが無い——**空の入力を送らない**
      if (!toolName) return;
      void bridge.sendToolInput({ arguments: latest.current.toolArgs ?? {} });
      const result = toCallToolResult(latest.current.toolResult);
      if (result) void bridge.sendToolResult(result);
    };
    bridge.addEventListener("initialized", onInitialized);

    void bridge.connect(transport);
    return () => {
      themeObserver.disconnect();
      void bridge.close();
      // 確かめている途中で画面が替わったら、頼みは断ったことにする
      setPendingDownload((pending) => {
        pending?.resolve(false);
        return null;
      });
    };
    // **画面が別物になったときだけ**組み直す（入出力とコールバックは ref から読む）
  }, [owner.kind, ownerKey(owner), server, toolName, displayMode, sandboxUrl, resource.html]);

  const csp = resource.csp ? `?csp=${encodeURIComponent(JSON.stringify(resource.csp))}` : "";
  return (
    <>
      <iframe
      ref={frameRef}
      data-testid="module-canvas-frame"
      title={`${server} の画面`}
      src={`${sandboxUrl}/sandbox.html${csp}`}
      className="h-full w-full border-0 bg-transparent"
      // 参照実装と同じ。`allow-same-origin` が指すのは**サンドボックスの
      // オリジン**であって banto ではない——内側へ HTML を流し込むのに要る。
      // 別オリジンで配っていることが、この属性が安全である前提（§6.2）
        sandbox="allow-scripts allow-same-origin allow-forms"
        // **クリップボードへの書き込みだけ通す**（追加・2026-09-15）。
        // Permissions Policy は**経路上の全ての iframe が渡して初めて届く**ので、
        // ここで渡さないと中の `navigator.clipboard.writeText` は必ず
        // `NotAllowedError` になる——実測で確かめた（公開鍵の「コピーする」は
        // 一度も動いていなかった）。**読み取り（clipboard-read）は渡さない**
        // ——人が別の用事でコピーしたものを Module に読ませる理由が無い
        allow="clipboard-write"
      />
      <AlertDialog
        open={pendingDownload !== null}
        onOpenChange={(open) => {
          if (open) return;
          pendingDownload?.resolve(false);
          setPendingDownload(null);
        }}
      >
        <AlertDialogContent data-testid="canvas-download-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>ダウンロードしますか</AlertDialogTitle>
            <AlertDialogDescription>
              {server} の画面が、次のファイルを保存しようとしています：
              {pendingDownload?.files.map((f) => f.name).join("、")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>やめる</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                pendingDownload?.resolve(true);
                setPendingDownload(null);
              }}
            >
              ダウンロードする
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

