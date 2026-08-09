/**
 * `file.viewer` — **1つのファイルを読む面**（ADR-0017 決定79）。
 *
 * `file.browser`（探す・移動する）とは**目的が違うので別種**にする——決定17 が
 * 「シェルと職人ビューアは目的が違うので別コンポーネント」としたのと同じ理屈。
 * 一覧を持たないぶん、本文に幅を全部使える。
 *
 * 器の `doc`（抜粋）から「全部読む →」で来る先がここ。**膳は抜粋で、全部はいつも面にある**。
 *
 * 描き手は `FileBody.tsx` を `file.browser` / 別タブの1枚（`FilePage`）と共有する
 * ——同じファイルが3つの姿を持たないため（`spec-canvas-ui` 第一原理）。
 *
 * D5: 判断は無い。渡されたパスを読んで描くだけ。
 */

import React, { useState } from "react";
import { Icon } from "../icons.js";
import { CodeBody, FilePreviewBody } from "./FileBody.js";
import { fileRawUrl } from "./fileRaw.js";
import { useColorScheme } from "./fileHighlight.js";
import { codeLangOfPath, kindOfPath, PREVIEW_MAX_LINES } from "./filePreview.js";
import type { CanvasViewProps } from "./registry.js";
import {
  EmptyState,
  ErrorNote,
  Loading,
  Segmented,
  ViewShell,
  ViewBar,
  ViewTitle,
  Spacer,
  formatBytes,
} from "./ui.js";
import { useModuleTool } from "./useModuleTool.js";

/**
 * 1度に読む行数。**読むためだけに開いた面**なので、最初から整形の上限まで取る
 * （それより大きいものは整形しない決め＝`spec-file-browser` §5.3）。
 */
const READ_LINES = PREVIEW_MAX_LINES;

interface FileContent {
  path: string;
  binary: boolean;
  size: number;
  content?: string;
  totalLines?: number;
  from?: number;
  to?: number;
  truncated?: boolean;
}

export function FileViewer({ params, endpoint }: CanvasViewProps): React.ReactElement {
  const scheme = useColorScheme();
  const path = typeof params["path"] === "string" ? params["path"] : "";
  const place = typeof params["place"] === "string" ? params["place"] : undefined;
  const kind = kindOfPath(path);
  /** `html` / `image` は中身を運ばず URL を渡す（`spec-file-browser` §5.1）。 */
  const raw = kind === "html" || kind === "image";
  const codeLang = kind === "code" || kind === "html" ? codeLangOfPath(path) : undefined;
  const rawHref = fileRawUrl(endpoint, place ?? "", path);

  const content = useModuleTool<FileContent>(
    endpoint,
    "file.read",
    { path, ...(place ? { place } : {}), maxLines: READ_LINES },
    !raw && path !== ""
  );
  // 頼んだパスと一致するときだけ描く（`spec-file-browser` §8.1）
  const body = content.data?.path === path ? content.data : undefined;

  const totalLines = body?.totalLines ?? body?.content?.split("\n").length ?? 0;
  const previewable = kind !== "plain";
  const previewAllowed = previewable && (raw || totalLines <= PREVIEW_MAX_LINES);

  const [choice, setChoice] = useState<"preview" | "source">();
  const effectiveMode = previewAllowed ? (choice ?? "preview") : "source";
  const text = body?.content ?? "";
  const name = path.slice(path.lastIndexOf("/") + 1);

  // I2: パスが無いまま開かれたら、黙って空にせず理由を出す
  if (path === "") {
    return (
      <ViewShell>
        <EmptyState icon="file" title="読むファイルが指定されていません">
          <code>path</code> を渡して開いてください（探して回るなら「ファイル」の面へ）。
        </EmptyState>
      </ViewShell>
    );
  }

  return (
    <ViewShell>
      <ViewBar>
        <ViewTitle icon="file-text">{name}</ViewTitle>
        <code className="fv-path" title={path}>
          {path}
        </code>
        <Spacer />
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
                ...(previewAllowed
                  ? {}
                  : { title: `${totalLines} 行と大きいため整形表示は使えません` }),
              },
              { value: "source", label: "原文" },
            ]}
          />
        )}
        {/* 「そのまま」への出口は残す——整形が崩れたときに逃げ場が無くなる */}
        <a className="cv-btn is-small" href={rawHref} target="_blank" rel="noreferrer">
          <Icon name="external" size={13} /> 生ファイル
        </a>
      </ViewBar>

      {/* I1: 切ったことを隠さない */}
      {previewable && !raw && !previewAllowed && (
        <div className="cv-note is-warn">
          {totalLines} 行と大きいため、整形表示ではなく原文で出しています。
        </div>
      )}
      {body?.truncated === true && (
        <div className="cv-note is-warn">
          大きいファイルのため {body.to ?? READ_LINES} / {totalLines} 行まで出しています。
          全部を見るには「生ファイル」へ。
        </div>
      )}

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
        </EmptyState>
      ) : (
        <div className="fv-body">
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
        </div>
      )}
    </ViewShell>
  );
}
