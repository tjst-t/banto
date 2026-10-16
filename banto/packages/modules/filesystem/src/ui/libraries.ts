// **PDF・Office を描く道具を、要るときに読み込む**（#341、v4-modules.md §2.2「画面の形」の「ファイルブラウザの右側で読む」）。
//
// `document` の画面は道具を HTML に最初から入れている（`ui-app.ts`）。ファイルブラウザは入れない——テキストしか見ないときも
// 開くのが約 0.3 秒遅くなった（docs/notes/2026-10-16-doc-review-in-browser.md）。PDF・Office を選んだときに、この Module の
// tool（`readViewerScript`、admin）で JS を受け、inline の script で読み込む。Canvas の CSP は `'unsafe-inline'` を許していて、
// 外の script・blob の URL・eval は許していない（変えない）——inline の script はそのまま通る。
// 読み込んだ道具は globalThis に自分を置くので、2回目からは読み込まない。

import { callTool, textOf } from "./protocol.js";

/** 道具の束。描き方ごとに要るもの（`document-screen.ts` の描き方と同じ名前） */
export type ViewerLibrary = "pdf" | "docx" | "sheet";

type ScriptName = "pdfjs-worker" | "pdfjs" | "jszip" | "docx-preview" | "xlsx";

/** 束ごとに読む JS（この順に読む——docx-preview は JSZip を見て自分を置く）と、読み込めたかを見る globalThis の名前 */
const LIBRARIES: Readonly<Record<ViewerLibrary, ReadonlyArray<{ name: ScriptName; global: string }>>> = {
  pdf: [
    { name: "pdfjs-worker", global: "pdfjsWorker" },
    { name: "pdfjs", global: "pdfjsLib" },
  ],
  docx: [
    { name: "jszip", global: "JSZip" },
    { name: "docx-preview", global: "docx" },
  ],
  sheet: [{ name: "xlsx", global: "XLSX" }],
};

const loading = new Map<ViewerLibrary, Promise<void>>();

function present(global: string): boolean {
  return (globalThis as Record<string, unknown>)[global] !== undefined;
}

/** その道具を読み込む（読み込み済みなら何もしない）。読み込めなければ止まる（描けないふりをしない、規則2） */
export function ensureLibrary(library: ViewerLibrary): Promise<void> {
  let promise = loading.get(library);
  if (!promise) {
    promise = load(library);
    // 失敗したら次に選んだときに読み直す
    promise.catch(() => loading.delete(library));
    loading.set(library, promise);
  }
  return promise;
}

async function load(library: ViewerLibrary): Promise<void> {
  for (const { name, global } of LIBRARIES[library]) {
    if (present(global)) continue;
    const script = JSON.parse(textOf(await callTool("readViewerScript", { name }))) as { text?: unknown; module?: unknown };
    if (typeof script.text !== "string") throw new Error(`${name} の JS を受け取れませんでした`);
    await run(name, script.text, script.module === true);
    if (!present(global)) throw new Error(`${name} を読み込みましたが、globalThis.${global} がありません`);
  }
}

/** module の script が走り終えたら呼ぶ口（script の末尾に足す。名前ごとに1つ） */
const DONE_KEY = "__bantoViewerScriptDone";

/**
 * inline の script を足して走らせる。普通の script は足したその場で走る。module の script は後で走り、inline のものには load が
 * 来ない（Chromium で確かめた）ので、末尾に「走り終えた」を知らせる1行を足して待つ。中で投げたものは window の error に出るので、
 * それも拾う
 */
function run(name: string, text: string, module: boolean): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const done = (Reflect.get(globalThis, DONE_KEY) as Record<string, () => void> | undefined) ?? {};
    Reflect.set(globalThis, DONE_KEY, done);
    let thrown: unknown;
    const onError = (e: ErrorEvent) => {
      thrown ??= e.error ?? e.message;
      if (module) finish();
    };
    const finish = () => {
      window.removeEventListener("error", onError);
      delete done[name];
      if (thrown === undefined) resolve();
      else reject(new Error(`${name} を読み込めませんでした：${String(thrown)}`));
    };
    window.addEventListener("error", onError);
    const el = document.createElement("script");
    el.dataset.viewerScript = name;
    if (module) {
      el.type = "module";
      done[name] = finish;
      el.textContent = `${text}\n;globalThis[${JSON.stringify(DONE_KEY)}]?.[${JSON.stringify(name)}]?.();\n`;
      document.head.append(el);
    } else {
      el.textContent = text;
      document.head.append(el);
      finish();
    }
  });
}
