/**
 * 別タブで開いた1枚（spec-file-browser §5.8.4）。
 *
 * **別タブでも整形して読める**（PO要望 2026-08-09）。`file.raw` へ直に送っていた頃は、
 * md も ts も `text/plain`（§5.8.2）で配られるので、ブラウザに出せるのは原文だけだった
 * ——「別タブで開く」を押すたびに、面の中では整形で読めていたものが原文に戻っていた。
 *
 * 会話もキャンバスも持たない**1枚**として立つ：
 *
 * - ホストへの WebSocket を張らない。要るのは `file.read` だけで、会話の状態は要らない
 * - 描き手は面と同じ（`FileBody.tsx`）。同じファイルが2つの姿を持たないため
 * - 到達先・場所・パスは URL が持つ（`filePage.ts`）。**位置の真実は URL**（D3）
 *
 * 「そのまま」が見たいときのために、頭から生ファイル（raw）とダウンロードへ出られる。
 */

import { useEffect, useState } from "react";
import { Icon } from "./icons.js";
import { CodeBody, FilePreviewBody } from "./views/FileBody.js";
import { fileRawUrl } from "./views/fileRaw.js";
import type { FilePageTarget } from "./views/filePage.js";
import { useColorScheme } from "./views/fileHighlight.js";
import { codeLangOfPath, kindOfPath, PREVIEW_MAX_LINES } from "./views/filePreview.js";
import { EmptyState, ErrorNote, Loading, Segmented, formatBytes } from "./views/ui.js";
import { useModuleTool } from "./views/useModuleTool.js";

interface FileContent {
  path: string;
  binary: boolean;
  size: number;
  content?: string;
  totalLines?: number;
  from?: number;
  to?: number;
  partialLine?: boolean;
  truncated?: boolean;
}

/**
 * 1度に読む行数。
 *
 * 面（`FileBrowser`）は既定の 400 行で開いて「続きを読む」で伸ばすが、こちらは
 * **読むためだけに開いた1枚**なので、最初から整形の上限（`PREVIEW_MAX_LINES`）まで取る。
 * それより大きいものは整形しない決め（§5.3）なので、これ以上取っても出しようがない。
 */
const READ_LINES = PREVIEW_MAX_LINES;

export function FilePage({ target }: { target: FilePageTarget }): React.ReactElement {
  const { endpoint, place, path } = target;
  const scheme = useColorScheme();
  const kind = kindOfPath(path);
  /** `html` / `image` は中身を運ばず URL を渡す（§5.1）。 */
  const raw = kind === "html" || kind === "image";
  /** 原文に色を付ける言語（`code` と `html` のみ）。 */
  const codeLang = kind === "code" || kind === "html" ? codeLangOfPath(path) : undefined;
  const rawHref = fileRawUrl(endpoint, place, path);

  const content = useModuleTool<FileContent>(
    endpoint,
    "file.read",
    { path, place, maxLines: READ_LINES },
    !raw
  );
  const body = content.data?.path === path ? content.data : undefined;

  // タブの札はファイル名。何枚も開いたときに見分けられないと、別タブで開く意味が薄い
  useEffect(() => {
    document.title = `${path.slice(path.lastIndexOf("/") + 1)} — banto`;
  }, [path]);

  const totalLines = body?.totalLines ?? body?.content?.split("\n").length ?? 0;
  /** 整形の姿を持つ種別か（§5.1 の表）。`plain` は原文しか無い。 */
  const previewable = kind !== "plain";
  /** 2000行超は整形しない（§5.3）。html / image は画面が行を組まないので効かせない */
  const previewAllowed = previewable && (raw || totalLines <= PREVIEW_MAX_LINES);

  const [choice, setChoice] = useState<"preview" | "source">();
  const mode = choice ?? "preview";
  const effectiveMode = previewAllowed ? mode : "source";
  const text = body?.content ?? "";

  const head = (
    <header className="fp-head">
      <span className="fp-place" title={`場所: ${place}`}>
        <Icon name="place" size={13} /> {place}
      </span>
      <code className="fp-path" title={path}>
        {path}
      </code>
      {previewable && kind !== "image" && (
        <Segmented
          label="表示"
          value={effectiveMode}
          onChange={setChoice}
          options={[
            {
              value: "preview",
              label: "整形",
              disabled: !previewAllowed,
              title: previewAllowed ? undefined : `${totalLines} 行と大きいため整形表示は使えません`,
            },
            { value: "source", label: "原文" },
          ]}
        />
      )}
      {/* 「そのまま」への出口は残す——整形が崩れたときに逃げ場が無くなる（§5.8.4） */}
      <a className="cv-btn is-small fp-link" href={rawHref} target="_blank" rel="noreferrer">
        <Icon name="external" size={13} /> 生ファイル
      </a>
      <a className="cv-btn is-small fp-link" href={`${rawHref}?dl=1`} download>
        <Icon name="arrow-down" size={13} /> 保存
      </a>
    </header>
  );

  const note = ((): React.ReactElement | undefined => {
    if (previewable && !raw && !previewAllowed) {
      return (
        <div className="cv-note is-warn">
          {totalLines} 行と大きいため、整形表示ではなく原文で出しています。
        </div>
      );
    }
    if (body?.truncated === true) {
      return (
        <div className="cv-note is-warn">
          大きいファイルのため {body.to ?? READ_LINES} / {totalLines} 行まで出しています。
          全部を見るには「生ファイル」へ。
        </div>
      );
    }
    return undefined;
  })();

  return (
    <div className="fp">
      {head}
      {note}
      {content.error && !raw ? (
        <ErrorNote onRetry={content.reload}>{content.error}</ErrorNote>
      ) : !raw && body === undefined ? (
        <Loading rows={6} />
      ) : body?.binary === true ? (
        <EmptyState icon="binary" title="バイナリのため表示できません">
          {formatBytes(body.size)} のファイルです。
          <a href={rawHref} target="_blank" rel="noreferrer">
            別タブで開く
          </a>
          {" · "}
          <a href={`${rawHref}?dl=1`} download>
            ダウンロード
          </a>
        </EmptyState>
      ) : (
        <main className="fp-body">
          {effectiveMode === "preview" ? (
            <FilePreviewBody
              path={path}
              kind={kind}
              content={text}
              rawHref={rawHref}
              scheme={scheme}
            />
          ) : (
            <CodeBody content={text} wrap {...(codeLang ? { lang: codeLang } : {})} scheme={scheme} />
          )}
        </main>
      )}
    </div>
  );
}
