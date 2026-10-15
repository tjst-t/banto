#!/usr/bin/env node
// docs/specs/v4-modules.md §2.2 FileSystem のインターフェース。
// resourceは`file:///{path}`テンプレート1本（数えきれない資源なのでtemplates/listに乗せる）。

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { VISIBILITY_META_KEY, MODULE_META_KEY, CANVAS_META_KEY, UI_BY_EXTENSION_META_KEY } from "@banto/module-contract";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import { basename, join, sep } from "node:path";
import * as ops from "./operations.js";
import { BROWSER_APP_URI, DOCUMENT_APP_URI, EDIT_DIFF_APP_URI, FILE_APP_URI, UI_APP_MIME, appHtml } from "./ui-app.js";
import { isPdfAssetKind, readPdfAsset } from "./pdf-assets.js";
import { CONFIG_APP_HTML, CONFIG_APP_URI } from "./config-app.js";
import { readSettings, writeSettings } from "./settings.js";
import { getComments, saveComments } from "./comments.js";
import { ConvertedStore, DOCUMENT_CONVERTED_EXTENSIONS, DocumentConversions, defaultTarget, extensionOf, type ConvertTarget } from "./converted.js";
import { RelayConverter } from "./relay-converter.js";
import { parsePages, readDocument } from "./read-document.js";

function tool(name: string, description: string, inputSchema: unknown) {
  return { name, description, inputSchema, _meta: { [VISIBILITY_META_KEY]: "agent" } };
}

/** 変換の形（無ければ拡張子から決まる既定） */
function convertTargetArg(v: unknown, absPath: string): ConvertTarget {
  if (v === undefined) return defaultTarget(extensionOf(absPath));
  if (v !== "pdf" && v !== "spreadsheet") throw new Error(`to は pdf か spreadsheet です: ${String(v)}`);
  return v;
}

export function createFileSystemServer(deps: {
  projectRoot: string;
  /** 変換役に頼んで置き場に残す（中継と Module の置き場が渡されたときだけ） */
  conversions?: DocumentConversions;
}) {
  const needConversions = () => {
    if (!deps.conversions) throw new Error("変換役に繋がっていません（banto の中継・Module の置き場が渡されていません）");
    return deps.conversions;
  };
  const server = new Server(
    { name: "banto-module-filesystem", version: "0.1.0" },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      tool("readFile", "読み取り（PDF・Office の文書の中身は readDocument で読む）", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      // **PDF・Office をページごとの文字・ページの絵で読む**（v4-modules.md §2.2「PDF・Office…」の「AI の側」）。readFile では
      // base64 が返るだけで読めない（readFile の形は変えない）。変換は人の画面と同じ変換役・同じ置き場
      tool(
        "readDocument",
        "PDF・Office の文書（docx・pptx・xlsx・doc・ppt・xls・odt・odp・ods など）をページごとの文字で読む（表はシートごとの CSV）。" +
          "asImage: true ならページの絵を返す。1回 20 ページ・200,000 字・絵は合計 10MB まで",
        {
          type: "object",
          properties: {
            path: { type: "string" },
            pages: {
              type: "string",
              description: '読むページ（1 から）。"3"・"2-5"・"1,4,6-8" の形。表ではシートの番号。省略すると 1 ページ目から 20 ページまで',
            },
            asImage: { type: "boolean", description: "true ならページの絵（図・レイアウトを見るとき。表は PDF にしたときのページ）" },
          },
          required: ["path"],
        },
      ),
      tool("writeFile", "新規作成／全体上書き", { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] }),
      // **結果は差分として画面にも出る**（v4-modules.md §2.2「editFile の結果は
      // 行単位差分で inline カードに埋め込む」）。返すのは unified diff で、
      // AI が読むものと画面が描くものは同じ1つの文字列（規則3）
      {
        ...tool("editFile", "部分編集。結果は unified diff", {
          type: "object",
          properties: {
            path: { type: "string" },
            edits: {
              type: "array",
              items: {
                type: "object",
                properties: { oldText: { type: "string" }, newText: { type: "string" } },
                required: ["oldText", "newText"],
              },
            },
          },
          required: ["path", "edits"],
        }),
        _meta: { [VISIBILITY_META_KEY]: "agent", ui: { resourceUri: EDIT_DIFF_APP_URI } },
      },
      // **この tool には画面がある**（MCP Apps、決定・2026-09-06）。
      // 印を付けるだけ——「どこに出すか」は banto が決める（§6.2）。
      {
        // **どう見せるかも頼める**（決定・2026-09-07、ユーザー要望）。
        // MCP Apps の仕様には「最初からこの mode で開く」を宣言する場所が無く、
        // 用意されているのは `ui/request-display-mode`（画面が頼み、host が決める）
        // だけ。そこで**この tool の引数**として受け取り、画面が立ち上がった直後に
        // その mode を頼む——AI が「フルスクリーンで開いて」に応えられるようになる。
        ...tool("listDirectory", "直下の一覧。displayMode で見せ方も頼める", {
          type: "object",
          properties: {
            path: { type: "string" },
            displayMode: {
              type: "string",
              enum: ["inline", "fullscreen"],
              description:
                "一覧の見せ方。fullscreen を指定すると会話の隣に大きく開く（既定は inline＝会話の中に埋め込む）。" +
                "人が「大きく」「フルスクリーンで」「別に開いて」と言ったら fullscreen を指定する。",
            },
          },
          required: ["path"],
        }),
        _meta: { [VISIBILITY_META_KEY]: "agent", ui: { resourceUri: BROWSER_APP_URI } },
      },
      // **人にファイルを見せる**（決定・2026-09-23、ユーザー）。readFile に画面を付けると、
      // AI がファイルを読むたびに会話にカードが出る（AI の読む口は readFile だけ）ので、
      // 「見せる」を別の tool にした。既定は会話の中のカードで、大きく開くのは頼まれたときだけ
      // （listDirectory の displayMode と同じ形）
      {
        ...tool(
          "showFile",
          "人にファイルを見せる（画面に出す）。人が「見せて」「開いて」「表示して」と言ったときに使う。" +
            "中身を自分で読むだけなら readFile を使う（こちらは中身を返さない）",
          {
            type: "object",
            properties: {
              path: { type: "string" },
              displayMode: {
                type: "string",
                enum: ["inline", "fullscreen"],
                description:
                  "見せ方。fullscreen を指定すると会話の隣に大きく開く（既定は inline＝会話の中に埋め込む）。" +
                  "人が「大きく」「フルスクリーンで」「別に開いて」と言ったら fullscreen を指定する。",
              },
            },
            required: ["path"],
          },
        ),
        _meta: {
          [VISIBILITY_META_KEY]: "agent",
          ui: { resourceUri: FILE_APP_URI },
          // **PDF・Office の文書は別の画面で描く**（v4-modules.md §2.2「PDF・Office…」）——pdf.js・docx-preview を同梱して
          // 重いので、テキストの画面の重さを変えない。どちらを出すかは host が引数のパスの拡張子で選ぶ。pptx・doc・ppt・odt・odp は
          // 画面が変換役で PDF にして描く（#305）
          [UI_BY_EXTENSION_META_KEY]: { arg: "path", byExtension: Object.fromEntries(["pdf", ...DOCUMENT_CONVERTED_EXTENSIONS].map((e) => [e, DOCUMENT_APP_URI])) },
        },
      },
      tool("searchFiles", "名前検索", { type: "object", properties: { path: { type: "string" }, pattern: { type: "string" } }, required: ["path", "pattern"] }),
      tool("createDirectory", "mkdir -p 相当", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("moveFile", "移動・リネーム", { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] }),
      tool("deleteFile", "削除", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      tool("getFileInfo", "サイズ・更新時刻・種別", { type: "object", properties: { path: { type: "string" } }, required: ["path"] }),
      // **この Module 自身の設定**。設定 Canvas から呼ぶもので、AI には見せない
      // （§2.1 の3段——人の管理操作は admin）
      // **ファイルブラウザが使う、人の操作だけの口**（v4-modules.md §2.2「launcher が
      // 開くファイルブラウザには、人向けのダウンロード／アップロードを置く……
      // 新しい AI 向け tool を要らない」）。AI には見せない（admin）
      {
        name: "uploadFile",
        description: "人が画面から置くファイル（中身は base64）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, data: { type: "string" } },
          required: ["path", "data"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "downloadFiles",
        description: "選んだファイルをまとめた ZIP",
        inputSchema: {
          type: "object",
          properties: { paths: { type: "array", items: { type: "string" } } },
          required: ["paths"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      // **PDF の画面が中身をバイトの範囲で受ける口**（v4-modules.md §2.2「PDF・Office…」）。pdf.js は末尾の xref から
      // 読むのでページでは切り出せない。1回 4MiB まで（base64 で stdio の1通 10MB に収まる）
      {
        name: "readFileRange",
        description: "ファイルのバイトの範囲（中身は base64、1回 4MiB まで）",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            offset: { type: "integer", minimum: 0 },
            length: { type: "integer", minimum: 0, maximum: ops.READ_RANGE_MAX_BYTES },
            // **変換したものを読む**（写しはパスで指させない——元のファイルのパスで、FileSystem が置き場の写しを引く）
            converted: { type: "boolean", description: "true なら、そのファイルを変換したもの（convertDocument の後で）" },
            to: { type: "string", enum: ["pdf", "spreadsheet"], description: "converted のとき、どの形か（既定：表は spreadsheet、それ以外は pdf）" },
          },
          required: ["path", "offset", "length"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      // **Office の文書を変換役で変換して置き場に残す**（v4-modules.md §2.2「変換役」）。同じ中身なら変換し直さない。
      // 変換役を入れている途中なら `{status:"preparing", message}`——画面はそれを出して待ち、あとで頼み直す
      {
        name: "convertDocument",
        description: "Office の文書を PDF に、表を計算し直した xlsx に変換して置き場に残す（7MB まで）。中身は readFileRange の converted で読む",
        inputSchema: {
          type: "object",
          properties: {
            path: { type: "string" },
            to: { type: "string", enum: ["pdf", "spreadsheet"], description: "既定：表は spreadsheet、それ以外は pdf" },
          },
          required: ["path"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      // pdf.js が fetch で読む同梱の資料（日本語の CMap・標準フォント）。画面は CSP で fetch できないので、ここから渡す
      {
        name: "readPdfAsset",
        description: "pdf.js の同梱の資料（CMap・標準フォント、中身は base64）",
        inputSchema: {
          type: "object",
          properties: { kind: { type: "string", enum: ["cmap", "standardFont"] }, name: { type: "string" } },
          required: ["kind", "name"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      // **PDF・Office の画面で付けたコメント**（v4-modules.md §2.2「PDF・Office…」の「コメント」）。Project ごとの置き場に、
      // ファイルの根からの相対パスを鍵に残す。各コメントは付けたときのファイルのハッシュを持つ（host が付ける）
      {
        name: "getComments",
        description: "そのファイルに付けたコメントと、いまのファイルのハッシュ",
        inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "saveComments",
        description: "そのファイルのコメントを、渡した一覧で置き換える（空なら消す）",
        inputSchema: {
          type: "object",
          properties: { path: { type: "string" }, comments: { type: "array", items: { type: "object" } } },
          required: ["path", "comments"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "getRoot",
        description: "この Module が見ている Project の根（画面の見出しに出す）",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "getSettings",
        description: "この Module のいまの設定",
        inputSchema: { type: "object", properties: {} },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
      {
        name: "setSettings",
        description: "この Module の設定を変える",
        inputSchema: {
          type: "object",
          properties: { showHidden: { type: "boolean" } },
          required: ["showHidden"],
        },
        _meta: { [VISIBILITY_META_KEY]: "admin" },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments as Record<string, unknown>;
    const root = deps.projectRoot;
    switch (request.params.name) {
      case "readFile": {
        const block = await ops.readFileOp(root, String(args.path));
        return { content: [block] };
      }
      case "readDocument": {
        const file = ops.fileInRoot(root, String(args.path));
        const blocks = await readDocument(file.abs, file.rel, { pages: parsePages(args.pages), asImage: args.asImage === true }, deps.conversions);
        return { content: blocks };
      }
      case "writeFile":
        await ops.writeFileOp(root, String(args.path), String(args.content));
        return { content: [{ type: "text", text: "ok" }] };
      case "editFile": {
        const diff = await ops.editFileOp(root, String(args.path), args.edits as ops.Edit[]);
        return { content: [{ type: "text", text: diff.text }] };
      }
      case "showFile": {
        const shown = await ops.showFileOp(root, String(args.path));
        return { content: [{ type: "text", text: JSON.stringify(shown) }] };
      }
      case "uploadFile": {
        const { size } = await ops.uploadFileOp(root, String(args.path), String(args.data));
        return { content: [{ type: "text", text: JSON.stringify({ size }) }] };
      }
      case "downloadFiles": {
        const paths = Array.isArray(args.paths) ? args.paths.map(String) : [];
        const zip = await ops.zipFilesOp(root, paths);
        return {
          content: [
            {
              type: "resource",
              resource: { uri: `file:///${zip.name}`, mimeType: "application/zip", blob: zip.data.toString("base64") },
            },
          ],
        };
      }
      case "readFileRange": {
        if (args.converted === true) {
          const file = ops.fileInRoot(root, String(args.path));
          const copy = await needConversions().convertedPath(file.abs, convertTargetArg(args.to, file.abs));
          const range = await ops.readRangeAt(copy, file.rel, Number(args.offset), Number(args.length));
          return { content: [{ type: "text", text: JSON.stringify(range) }] };
        }
        const range = await ops.readFileRangeOp(root, String(args.path), Number(args.offset), Number(args.length));
        return { content: [{ type: "text", text: JSON.stringify(range) }] };
      }
      case "convertDocument": {
        const file = ops.fileInRoot(root, String(args.path));
        const outcome = await needConversions().convert(file.abs, convertTargetArg(args.to, file.abs));
        return { content: [{ type: "text", text: JSON.stringify({ path: file.rel, ...outcome }) }] };
      }
      case "readPdfAsset": {
        if (!isPdfAssetKind(args.kind)) throw new Error(`kind は cmap か standardFont です: ${String(args.kind)}`);
        const data = await readPdfAsset(args.kind, String(args.name));
        return { content: [{ type: "text", text: JSON.stringify({ data: data.toString("base64") }) }] };
      }
      case "getComments": {
        const file = ops.fileInRoot(root, String(args.path));
        const got = await getComments(file.rel, file.abs);
        return { content: [{ type: "text", text: JSON.stringify({ path: file.rel, ...got }) }] };
      }
      case "saveComments": {
        const file = ops.fileInRoot(root, String(args.path));
        const saved = await saveComments(file.rel, file.abs, args.comments);
        return { content: [{ type: "text", text: JSON.stringify({ path: file.rel, ...saved }) }] };
      }
      case "getRoot": {
        const real = realpathSync(root);
        const home = homedir();
        // 人に見せる形——ホームの下なら `~` で縮める（見出しは狭い）
        const display = real === home ? "~" : real.startsWith(home + sep) ? `~${real.slice(home.length)}` : real;
        // `absolute` は、AI が絶対パスで頼んだ場所を画面がツリーの中で探すため
        return { content: [{ type: "text", text: JSON.stringify({ path: display, name: basename(real), absolute: real }) }] };
      }
      case "getSettings":
        return { content: [{ type: "text", text: JSON.stringify(readSettings()) }] };
      case "setSettings": {
        const next = { showHidden: Boolean(args.showHidden) };
        writeSettings(next);
        return { content: [{ type: "text", text: JSON.stringify(next) }] };
      }
      case "listDirectory": {
        const entries = await ops.listDirectoryOp(root, String(args.path), {
          showHidden: readSettings().showHidden,
        });
        return { content: [{ type: "text", text: JSON.stringify(entries) }] };
      }
      case "searchFiles": {
        const results = await ops.searchFilesOp(root, String(args.path), String(args.pattern));
        return { content: [{ type: "text", text: JSON.stringify(results) }] };
      }
      case "createDirectory":
        await ops.createDirectoryOp(root, String(args.path));
        return { content: [{ type: "text", text: "ok" }] };
      case "moveFile":
        await ops.moveFileOp(root, String(args.from), String(args.to));
        return { content: [{ type: "text", text: "ok" }] };
      case "deleteFile":
        await ops.deleteFileOp(root, String(args.path));
        return { content: [{ type: "text", text: "ok" }] };
      case "getFileInfo": {
        const info = await ops.getFileInfoOp(root, String(args.path));
        return { content: [{ type: "text", text: JSON.stringify(info) }] };
      }
      default:
        throw new Error(`unknown tool: ${request.params.name}`);
    }
  });

  // **自分が何者かを名乗る**（決定・2026-09-06）。AI には見せない（admin）。
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        // **ファイルブラウザ**——listDirectory の結果を描く画面であり、人が直接開ける
        // 入口でもある（launcher、§6.2、決定・2026-09-07。「まずファイルを見たい」は
        // AI に頼む用事ではない、要件C3）。会話の中（inline）では一覧だけ、
        // 大きく開いたとき（fullscreen）はツリーと中身の2ペインになる。
        // AI に読ませるものではない（HTML）ので agent には見せない
        //
        // URI は `directory` のまま——会話の記録と開いている画面の URL がこの名前で
        // 指しているので、変えると過去のカードが開けなくなる
        uri: BROWSER_APP_URI,
        // 設定 Canvas と**同じ1つの仕組み**で名乗る（増やさない）。
        // 人に見せる名前と説明は、仕様の `name` / `description` をそのまま使う
        name: "ファイル",
        description: "この Project のファイルを見る・開く・編集する",
        mimeType: UI_APP_MIME,
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [CANVAS_META_KEY]: "launcher",
          ui: { prefersBorder: false },
        },
      },
      {
        // showFile の画面（人に見せるファイル1つ）
        uri: FILE_APP_URI,
        name: "ファイルを見せる",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", ui: { prefersBorder: false } },
      },
      {
        // showFile の画面のうち PDF・Word（pdf.js を Worker 無しで、docx-preview と同梱。v4-modules.md §2.2「PDF・Office…」）
        uri: DOCUMENT_APP_URI,
        name: "PDF・Word を見せる",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", ui: { prefersBorder: false } },
      },
      {
        // editFile の結果（差分）を描く画面
        uri: EDIT_DIFF_APP_URI,
        name: "ファイルの差分",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", ui: { prefersBorder: false } },
      },
      {
        // **設定 Canvas**（決定・2026-09-07）。banto の設定画面がこれを埋め込む。
        // 「在るかもしれない」を試させない——**こちらから名乗る**
        uri: CONFIG_APP_URI,
        name: "FileSystem",
        mimeType: UI_APP_MIME,
        _meta: { [VISIBILITY_META_KEY]: "admin", [CANVAS_META_KEY]: "config", ui: { prefersBorder: false } },
      },
      {
        uri: "file://module",
        name: "この Module の申告",
        mimeType: "application/json",
        _meta: {
          [VISIBILITY_META_KEY]: "admin",
          [MODULE_META_KEY]: {
            satisfies: ["filesystem"],
            dependsOn: [{ role: "documents", required: false }],
            isolation: "subprocess",
            scope: "project",
            confinement: { kind: "landlock", root: "project" },
          },
        },
      },
    ],
  }));

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
    resourceTemplates: [
      {
        uriTemplate: "file:///{path}",
        name: "Project file",
        _meta: { [VISIBILITY_META_KEY]: "agent" },
      },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri === CONFIG_APP_URI) {
      return { contents: [{ uri: CONFIG_APP_URI, mimeType: UI_APP_MIME, text: CONFIG_APP_HTML }] };
    }
    if (request.params.uri === BROWSER_APP_URI) {
      return { contents: [{ uri: BROWSER_APP_URI, mimeType: UI_APP_MIME, text: appHtml("browser") }] };
    }
    if (request.params.uri === FILE_APP_URI) {
      return { contents: [{ uri: FILE_APP_URI, mimeType: UI_APP_MIME, text: appHtml("file") }] };
    }
    if (request.params.uri === DOCUMENT_APP_URI) {
      return { contents: [{ uri: DOCUMENT_APP_URI, mimeType: UI_APP_MIME, text: appHtml("document") }] };
    }
    if (request.params.uri === EDIT_DIFF_APP_URI) {
      return { contents: [{ uri: EDIT_DIFF_APP_URI, mimeType: UI_APP_MIME, text: appHtml("edit-diff") }] };
    }
    const match = request.params.uri.match(/^file:\/\/\/(.+)$/);
    if (!match) throw new Error(`unknown resource: ${request.params.uri}`);
    const uri = request.params.uri;
    const block = await ops.readFileOp(deps.projectRoot, match[1]!);
    if (block.type === "text") return { contents: [{ uri, mimeType: "text/plain", text: block.text }] };
    if (block.type === "image") return { contents: [{ uri, mimeType: block.mimeType, blob: block.data }] };
    return { contents: [{ uri, mimeType: block.resource.mimeType, blob: block.resource.blob }] };
  });

  return server;
}

if (process.argv[1] && process.argv[1].endsWith("server.js")) {
  const projectRoot = process.env.BANTO_PROJECT_ROOT;
  if (!projectRoot) {
    console.error("BANTO_PROJECT_ROOT が必要です");
    process.exit(1);
  }
  // 変換役は中継の向こう（banto 全体の道具用のコンテナ）。変換したものは Project ごとの Module の置き場に残す
  const relayUrl = process.env.BANTO_HOST_MCP_URL;
  const relayToken = process.env.BANTO_HOST_MCP_TOKEN;
  const dataDir = process.env.BANTO_MODULE_DATA_DIR;
  const conversions =
    dataDir !== undefined
      ? new DocumentConversions(
          new ConvertedStore(join(dataDir, "converted")),
          relayUrl && relayToken ? new RelayConverter(relayUrl, relayToken) : undefined,
        )
      : undefined;
  const server = createFileSystemServer({ projectRoot, ...(conversions ? { conversions } : {}) });
  await server.connect(new StdioServerTransport());
}
