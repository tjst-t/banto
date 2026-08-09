/**
 * 道具の絵（spec-design §4）。
 *
 * 絵文字をやめた理由は3つ。環境で字面が変わる／ベースラインがずれる（CSS 側に
 * 中心合わせの手当てが要っていた）／色が地から浮く。
 *
 * 規約：**24 の升目・1.5px の線・`fill: none`・`stroke: currentColor`**。
 * 絵に色を持たせず、置いた場所の色を継ぐ。ここに無い絵が要るときは**足してから使う**。
 */

import React from "react";

export type IconName =
  // 器・移動
  | "chevron-down" | "chevron-right" | "chevron-left" | "arrow-right"
  | "arrow-down" | "arrow-up" | "arrow-left" | "external" | "enter" | "stop"
  | "close" | "plus" | "minus" | "search" | "copy" | "check" | "dot" | "more"
  // 面（キャンバスに開くもの）
  | "chat" | "history" | "settings" | "inbox" | "file" | "file-text" | "folder"
  | "image" | "table" | "archive" | "binary" | "graph" | "home" | "memory"
  | "skill" | "worker" | "environment" | "lock" | "repo" | "branch" | "model"
  | "canvas" | "place"
  // 状態・注記
  | "warn" | "error" | "pencil" | "sparkle" | "clock" | "moon" | "sun";

/**
 * 絵の中身。`stroke` は継承させるので、ここでは形だけを持つ。
 * 塗りが要るもの（点）だけ `fill` を明示する。
 */
const SHAPES: Record<IconName, React.ReactNode> = {
  "chevron-down": <path d="M6 9l6 6 6-6" />,
  "chevron-right": <path d="M9 6l6 6-6 6" />,
  "chevron-left": <path d="M15 6l-6 6 6 6" />,
  "arrow-right": <path d="M5 12h13M12 5l7 7-7 7" />,
  "arrow-down": <path d="M12 5v13M5 12l7 7 7-7" />,
  "arrow-up": <path d="M12 19V6M5 13l7-7 7 7" />,
  "arrow-left": <path d="M19 12H6M11 5l-7 7 7 7" />,
  external: <><path d="M14 4h6v6" /><path d="M20 4l-9 9" /><path d="M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5" /></>,
  // 送る。改行キーの形をそのまま線にする
  enter: <path d="M20 5v6a2 2 0 01-2 2H5m0 0l4-4m-4 4l4 4" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  search: <><circle cx="11" cy="11" r="6" /><path d="M20 20l-4.5-4.5" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a1 1 0 011-1h9" /></>,
  check: <path d="M5 13l4.5 4.5L19 7" />,
  dot: <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />,
  // そのほか（畳んだ操作）。1つの絵として持たせる——点を3つ並べて置くと器から溢れる
  more: <><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></>,

  chat: <path d="M20 12a7 7 0 01-7 7H8l-4 3v-5.5A7 7 0 018 5h5a7 7 0 017 7z" />,
  history: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5.2l3.2 2" /></>,
  // つまみ。歯車は小さいと太陽に見えるので使わない
  settings: <><path d="M4 7h8M18 7h2M4 12h4M14 12h6M4 17h8M18 17h2" /><circle cx="15" cy="7" r="2" /><circle cx="11" cy="12" r="2" /><circle cx="15" cy="17" r="2" /></>,
  inbox: <><path d="M3 13h4.5l1.8 3h5.4l1.8-3H21" /><path d="M5.5 5h13l2.5 8v4.5a1.5 1.5 0 01-1.5 1.5H4.5A1.5 1.5 0 013 17.5V13z" /></>,
  file: <><path d="M13 3H7a1.5 1.5 0 00-1.5 1.5v15A1.5 1.5 0 007 21h10a1.5 1.5 0 001.5-1.5V8.5z" /><path d="M13 3v5.5h5.5" /></>,
  "file-text": <><path d="M13 3H7a1.5 1.5 0 00-1.5 1.5v15A1.5 1.5 0 007 21h10a1.5 1.5 0 001.5-1.5V8.5z" /><path d="M13 3v5.5h5.5M9 13h6M9 17h4" /></>,
  folder: <path d="M3 7.5A1.5 1.5 0 014.5 6h4L11 8.5h8.5A1.5 1.5 0 0121 10v8a1.5 1.5 0 01-1.5 1.5h-15A1.5 1.5 0 013 18z" />,
  image: <><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><circle cx="9" cy="10" r="1.6" /><path d="M4 17l4.5-4.5L13 17l3-3 4 4" /></>,
  table: <><rect x="3.5" y="5" width="17" height="14" rx="1.5" /><path d="M3.5 10h17M9.5 10v9" /></>,
  archive: <><path d="M3.5 7.5h17v11a1.5 1.5 0 01-1.5 1.5H5a1.5 1.5 0 01-1.5-1.5z" /><rect x="2.5" y="4" width="19" height="3.5" rx="1" /><path d="M10 12h4" /></>,
  binary: <><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /><path d="M7.5 9h2v6h-2zM14.5 9h2v6h-2z" /></>,
  graph: <><circle cx="6" cy="18" r="2.2" /><circle cx="12" cy="6" r="2.2" /><circle cx="18" cy="14" r="2.2" /><path d="M7.6 16.5L10.6 8M13.9 7.4l2.7 5" /></>,
  home: <><path d="M4 10.5L12 4l8 6.5" /><path d="M6 10v9.5h12V10" /></>,
  memory: <path d="M12 4.5a3.5 3.5 0 00-3.5 3.5 3 3 0 00-.5 5.9V16a3.5 3.5 0 007 0v-2.1a3 3 0 00-.5-5.9A3.5 3.5 0 0012 4.5zM12 4.5v15" />,
  skill: <><path d="M5 4.5h9.5a2 2 0 012 2V21H7a2 2 0 01-2-2z" /><path d="M16.5 6.5H19V21H7" /><path d="M8 9h6M8 12.5h4" /></>,
  worker: <><circle cx="12" cy="8" r="3.6" /><path d="M4.5 20v-1.5A4.5 4.5 0 019 14h6a4.5 4.5 0 014.5 4.5V20" /></>,
  environment: <><rect x="3.5" y="5" width="17" height="11.5" rx="1.5" /><path d="M8.5 20.5h7M12 16.5v4" /></>,
  lock: <><rect x="4.5" y="10.5" width="15" height="9.5" rx="1.5" /><path d="M8 10.5V8a4 4 0 018 0v2.5" /></>,
  repo: <><path d="M4.5 5.5A1.5 1.5 0 016 4h11.5a1 1 0 011 1v14a1 1 0 01-1 1H6a1.5 1.5 0 010-3h12.5" /><path d="M8 8h6" /></>,
  branch: <><circle cx="7" cy="6" r="2.2" /><circle cx="7" cy="18" r="2.2" /><circle cx="17" cy="9" r="2.2" /><path d="M7 8.2v7.6M17 11.2c0 3-2.5 4.3-6 4.6" /></>,
  model: <><circle cx="12" cy="12" r="8.5" /><path d="M12 3.5v17" /><path d="M12 3.5a8.5 8.5 0 000 17" fill="currentColor" stroke="none" opacity=".22" /></>,
  canvas: <><rect x="3.5" y="4.5" width="17" height="15" rx="1.5" /><path d="M3.5 9h17M9 9v10.5" /></>,
  place: <><path d="M12 21s6.5-5.6 6.5-10.2A6.5 6.5 0 005.5 10.8C5.5 15.4 12 21 12 21z" /><circle cx="12" cy="10.6" r="2.3" /></>,

  warn: <><path d="M12 4l8.5 15h-17z" /><path d="M12 10.5v3.5M12 17v.6" /></>,
  error: <><circle cx="12" cy="12" r="8.5" /><path d="M15 9l-6 6M9 9l6 6" /></>,
  pencil: <><path d="M4.5 19.5h3.2L19 8.2a1.6 1.6 0 000-2.3l-.9-.9a1.6 1.6 0 00-2.3 0L4.5 16.3z" /><path d="M14.5 6.5l3 3" /></>,
  // 考えている印。四方に伸びる光
  sparkle: <path d="M12 4v16M4 12h16M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></>,
  moon: <path d="M20 14.2A8.4 8.4 0 019.8 4 8.4 8.4 0 1020 14.2z" />,
  sun: <><circle cx="12" cy="12" r="4" /><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M18.7 5.3l-1.6 1.6M6.9 17.1l-1.6 1.6" /></>,
};

export interface IconProps {
  name: IconName;
  /** 升目の大きさ（px）。既定 16。字と並べるときは 14〜17 に収める。 */
  size?: number;
  /** 線の太さ。既定 1.5。小さく描くときだけ 1.6〜1.8 に上げる。 */
  stroke?: number;
  className?: string;
  /** 意味を持つ絵にだけ付ける。付けたときは `aria-hidden` を外す。 */
  title?: string;
}

/**
 * 絵をひとつ描く。**色は継承する**ので、置いた側の `color` で決まる。
 *
 * 既定は `aria-hidden`——ほとんどの絵は隣の字の言い直しで、読み上げに二度言わせない。
 * 絵だけで意味を担うとき（絵のボタン）は `title` を渡す。
 */
export function Icon({ name, size = 16, stroke = 1.5, className, title }: IconProps): React.ReactElement {
  return (
    <svg
      className={className ? `ico ${className}` : "ico"}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={stroke}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      {title && <title>{title}</title>}
      {SHAPES[name]}
    </svg>
  );
}

/**
 * ホストが配る面の名前（kind）→ 絵。
 *
 * **カタログの `icon`（ホストが持つ文字）はもう見ない**——絵文字の文字列が
 * そのまま画面に出ていた経路がここだった。ホストの登録を触らずに絵を差し替えるため、
 * 対応づけは画面側に置く（D5：どう描くかは Surface の領分）。
 */
const KIND_ICONS: Record<string, IconName> = {
  "file.browser": "folder",
  "worker.viewer": "worker",
  "memory.viewer": "memory",
  "skill.viewer": "skill",
  "env.manager": "environment",
  "git.viewer": "branch",
  "repo.manager": "repo",
  "place.permissions": "lock",
  "llm.registry": "model",
  settings: "settings",
};

/** 面の絵。知らない kind は無地の面として描く（黙って消さない）。 */
export function iconOfKind(kind: string): IconName {
  return KIND_ICONS[kind] ?? "canvas";
}

/** 拡張子 → 絵。ファイル一覧で使う。 */
export function iconOfFile(name: string, isDir: boolean): IconName {
  if (isDir) return "folder";
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["md", "txt", "rst"].includes(ext)) return "file-text";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "avif"].includes(ext)) return "image";
  if (["json", "yaml", "yml", "toml", "ini", "cfg", "env"].includes(ext)) return "settings";
  if (["csv", "tsv"].includes(ext)) return "table";
  if (["mmd", "mermaid"].includes(ext)) return "graph";
  if (["zip", "gz", "tar", "tgz", "7z", "xz", "bz2"].includes(ext)) return "archive";
  return "file";
}
