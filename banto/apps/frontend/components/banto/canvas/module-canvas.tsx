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
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import {
  answerRealInboxItem,
  callRealUiTool,
  fetchRealUiConfig,
  fetchRealUiResource,
  type RealCanvasOwner,
  type RealUiResource,
} from "@/lib/backend/client";
import { getRealJudgments, refreshRealInbox } from "@/lib/backend/real-inbox";
import { beginCanvasToolCall, endCanvasToolCall } from "@/lib/backend/adapter";
import { getProject } from "@/lib/mock/projects";
import { getThread } from "@/lib/mock/threads";

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
  sandboxUrl,
  resource,
}: ModuleCanvasProps & { sandboxUrl: string; resource: RealUiResource }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  // **橋は、画面が変わったときにだけ張り直す**（`frontend-interaction-hardening`、
  // 2026-09-10）。以前は毎レンダー新しくなるもの（親が render 中に作る
  // `onRequestFullscreen`、tool の入出力オブジェクト）を効果の依存に置いていたので、
  // 親が再描画されるたびに **AppBridge を閉じて張り直していた**——実測（同日）：
  // Canvas を1つ出して Fork を開いて閉じるだけで **9回**。中身は生き延びていたが、
  // 張り直しの最中に飛んでいる呼び出しがあれば落ちる（規則2 の「黙って別の経路へ
  // 落ちない」が保てない）。**いま要る値は ref から読む**——依存に入れない。
  const latest = useRef({ owner, toolArgs, toolResult, onRequestFullscreen });
  useEffect(() => {
    latest.current = { owner, toolArgs, toolResult, onRequestFullscreen };
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
    // `_client` は null——**tool 呼び出しを素通しさせない**。下の oncalltool で
    // 受けて、host の承認ゲートへ回す
    const bridge = new AppBridge(null, { name: "banto", version: "0.1.0" }, {}, {
      hostContext: {
        displayMode,
        availableDisplayModes: ["inline", "fullscreen"],
        theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
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
        // tool 起点のときだけ入れる。**無いものを作らない**——画面はこれが
        // 無いことで「人が直接開いた」と分かり、自分で必要なものを取りに行く
        ...(toolName ? { toolInfo: { tool: { name: toolName, inputSchema: { type: "object" } } } } : {}),
      },
    });

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
      void bridge.close();
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
      />
    </>
  );
}

