// **流れ「terminal」1本＝tmux の制御モードの client 1つ**（v4-modules.md §4.6、アーキ仕様 §5.8）。
//
// - 画面→Module：文字の JSON `{ "type": "input", "data": "…" }`・`{ "type": "resize", "cols": n, "rows": n }`
// - Module→画面：端末への出力のバイト列（2進）
// - 繋いだら、今の画面の中身（`capture-pane -e`、履歴つき）を先に送ってから続きを流す。`;` で並べた1行は間に出力を
//   挟まずに走るので、写しを取る返事より前に来た出力は写しに含まれている——捨てる。返事より後の出力だけを流す
// - 大きさは最後に打った方に合わせる（`window-size latest`）。制御モードの client は `send-keys` では「最後」に
//   ならない（実測・2026-10-08）ので、別の流れが最後だったときは、打つ前に `switch-client` で自分を最後にして、
//   自分の大きさを伝え直す
//
// 打った中身・出力はどこにも残さない（記録に書くのは開いた・閉じた・失敗の理由だけ）。

import type { StreamHandler, WebSocket } from "@banto/stream-server";
import { STREAM_CLOSE_GONE } from "@banto/module-contract";
import { TmuxControlClient } from "./control.js";
import { paneTarget, sessionNameProblem, type Tmux } from "./tmux.js";

/** 写しに含める履歴の行数の上限（tmux の history-limit と同じ） */
const SNAPSHOT_HISTORY = 10000;
/** 1通の大きさ（口の上限 1MiB より十分小さく。写しは分けて送る） */
const CHUNK_BYTES = 256 * 1024;
/** `send-keys -H` の1回に載せるバイト数（1行が長くなりすぎないように） */
const KEYS_PER_COMMAND = 1024;

export interface TerminalSize {
  cols: number;
  rows: number;
}

/** 大きさとして受ける範囲。外れたら断る（黙って丸めない） */
export function parseSize(cols: unknown, rows: unknown): TerminalSize | undefined {
  const ok = (n: unknown, max: number): n is number => typeof n === "number" && Number.isInteger(n) && n >= 2 && n <= max;
  return ok(cols, 1000) && ok(rows, 500) ? { cols, rows } : undefined;
}

interface PaneInfo {
  paneId: string;
  sessionId: string;
  cursorX: number;
  cursorY: number;
  flags: Record<(typeof FLAG_NAMES)[number], boolean>;
}

const FLAG_NAMES = [
  "alternate_on",
  "cursor_flag",
  "keypad_cursor_flag",
  "keypad_flag",
  "mouse_standard_flag",
  "mouse_button_flag",
  "mouse_any_flag",
  "mouse_sgr_flag",
] as const;

const INFO_FORMAT = ["#{pane_id}", "#{session_id}", "#{cursor_x}", "#{cursor_y}", ...FLAG_NAMES.map((f) => `#{${f}}`)].join(" ");

function parseInfo(line: string | undefined): PaneInfo {
  const parts = (line ?? "").trim().split(" ");
  if (parts.length !== 4 + FLAG_NAMES.length || !parts[0]!.startsWith("%")) {
    throw new Error(`tmux のペインの様子が読めません: ${line ?? "（返事なし）"}`);
  }
  const flags = Object.fromEntries(FLAG_NAMES.map((f, i) => [f, parts[4 + i] === "1"])) as PaneInfo["flags"];
  return { paneId: parts[0]!, sessionId: parts[1]!, cursorX: Number(parts[2]), cursorY: Number(parts[3]), flags };
}

/**
 * **今の画面の中身を、端末に書けば同じ見た目になるバイト列にする**。先頭で端末を初期化（`ESC c`——前に描いたものと
 * 履歴を消す。繋ぎ直したときに二重にならない）し、履歴と見えている行を書き、カーソルと入力の形（矢印キーの送り方・
 * マウス）を戻す
 */
export function buildSnapshot(lines: string[], info: PaneInfo): Buffer {
  const f = info.flags;
  let out = "\x1bc";
  if (f.alternate_on) out += "\x1b[?1049h";
  // 行ごとに色を戻してから改行する（背景の色が次の行に広がらないように）
  out += lines.join("\x1b[0m\r\n");
  out += "\x1b[0m";
  out += `\x1b[${info.cursorY + 1};${info.cursorX + 1}H`;
  if (!f.cursor_flag) out += "\x1b[?25l";
  if (f.keypad_cursor_flag) out += "\x1b[?1h";
  if (f.keypad_flag) out += "\x1b=";
  if (f.mouse_standard_flag) out += "\x1b[?1000h";
  if (f.mouse_button_flag) out += "\x1b[?1002h";
  if (f.mouse_any_flag) out += "\x1b[?1003h";
  if (f.mouse_sgr_flag) out += "\x1b[?1006h";
  return Buffer.from(out, "utf8");
}

export interface TerminalStreamDeps {
  tmux: Tmux;
  /** 記録（中身は書かない） */
  log?: (line: string) => void;
}

/** セッション（tmux の id）ごとに、いま大きさを決めている流れ */
type LatestMap = Map<string, object>;

export function terminalStreamHandler(deps: TerminalStreamDeps): StreamHandler {
  const latest: LatestMap = new Map();
  const log = deps.log ?? ((line: string) => process.stderr.write(`[terminal] ${line}\n`));
  return (ws, stamp) => {
    const name = stamp.params.session;
    const problem = sessionNameProblem(name);
    const size = parseSize(stamp.params.cols ?? 80, stamp.params.rows ?? 24);
    if (problem || !size) {
      ws.close(1008, problem ?? "端末の大きさ（cols・rows）が範囲の外です");
      return;
    }
    attach(ws, name as string, size, deps.tmux, latest, log);
  };
}

function attach(ws: WebSocket, name: string, size: TerminalSize, tmux: Tmux, latest: LatestMap, log: (line: string) => void): void {
  const me = {};
  let alive = true;
  let control: TmuxControlClient | undefined;
  let paneId: string | undefined;
  let sessionId: string | undefined;
  /** 写しを取っている間は出力を流さない（写しに含まれている） */
  let syncing = true;
  /**
   * 繋ぐ・写しを取る・打鍵・大きさは、この順に1つずつ流す（ペインが決まる前の打鍵を先に送らない）。受け口は
   * 最初に付ける——付ける前に届いた1通は捨てられてしまう
   */
  let queue: Promise<void> = Promise.resolve();

  function enqueue(step: () => Promise<void>): void {
    queue = queue.then(async () => {
      if (!alive) return;
      try {
        await step();
      } catch (err) {
        // 握りつぶさない：流れを閉じ、画面は繋ぎ直す（そのときに写しを取り直す）
        log(`セッション「${name}」の流れを閉じます: ${(err as Error).message}`);
        alive = false;
        if (ws.readyState === ws.OPEN) ws.close(1011, truncateReason((err as Error).message));
        control?.close();
      }
    });
  }

  async function connect(): Promise<void> {
    if (!(await tmux.has(name))) {
      alive = false;
      ws.close(STREAM_CLOSE_GONE, `セッション「${name}」はありません`);
      return;
    }
    control = new TmuxControlClient(tmux.attachControl(name), {
      onOutput(pane, data) {
        if (syncing || pane !== paneId || ws.readyState !== ws.OPEN) return;
        ws.send(data, { binary: true });
      },
      onNotification(line) {
        // 見ているウィンドウ・ペインが替わった（AI が Shell から足した等）——写しを取り直す
        if (/^%(session-window-changed|window-pane-changed) /.test(line)) enqueue(sync);
      },
      onExit(reason) {
        alive = false;
        if (sessionId && latest.get(sessionId) === me) latest.delete(sessionId);
        if (ws.readyState !== ws.OPEN) return;
        void (async () => {
          // セッションが閉じられたなら「もう無い」——画面は繋ぎ直しをやめる
          const gone = sessionId ? !(await tmux.hasId(sessionId).catch(() => true)) : true;
          if (gone) ws.close(STREAM_CLOSE_GONE, `セッション「${name}」は閉じられました`);
          else ws.close(1011, truncateReason(reason));
        })();
      },
    });
    await sync();
  }

  async function sync(): Promise<void> {
    syncing = true;
    const target = sessionId ?? paneTarget(name);
    const [, captured, info] = await control!.run([
      `refresh-client -C ${size.cols}x${size.rows}`,
      `capture-pane -p -e -S -${SNAPSHOT_HISTORY} -t '${target}'`,
      `display-message -p -t '${target}' '${INFO_FORMAT}'`,
    ]);
    const pane = parseInfo(info![0]);
    paneId = pane.paneId;
    sessionId = pane.sessionId;
    // 繋いだ client は tmux の中でも「最後」になる
    latest.set(sessionId, me);
    const snapshot = buildSnapshot(captured!, pane);
    for (let i = 0; i < snapshot.length; i += CHUNK_BYTES) {
      if (ws.readyState !== ws.OPEN) return;
      ws.send(snapshot.subarray(i, i + CHUNK_BYTES), { binary: true });
    }
    syncing = false;
  }

  async function input(data: string): Promise<void> {
    if (!control || !paneId || !sessionId) return;
    const commands: string[] = [];
    if (latest.get(sessionId) !== me) {
      commands.push(`switch-client -t '${sessionId}'`, `refresh-client -C ${size.cols}x${size.rows}`);
      latest.set(sessionId, me);
    }
    const bytes = Buffer.from(data, "utf8");
    for (let i = 0; i < bytes.length; i += KEYS_PER_COMMAND) {
      const hex = [...bytes.subarray(i, i + KEYS_PER_COMMAND)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
      commands.push(`send-keys -t '${paneId}' -H ${hex}`);
    }
    if (commands.length > 0) await control.run(commands);
  }

  async function resize(next: TerminalSize): Promise<void> {
    size.cols = next.cols;
    size.rows = next.rows;
    // 「最後」でない流れの大きさは、tmux がウィンドウに効かせない（打ったときに効く）
    await control?.run([`refresh-client -C ${size.cols}x${size.rows}`]);
  }

  ws.on("message", (data, isBinary) => {
    if (isBinary) {
      ws.close(1003, "2進は受けません（文字の JSON で送ってください）");
      return;
    }
    let message: { type?: unknown; data?: unknown; cols?: unknown; rows?: unknown };
    try {
      message = JSON.parse(data.toString()) as typeof message;
    } catch {
      ws.close(1007, "JSON ではありません");
      return;
    }
    if (message.type === "input" && typeof message.data === "string") {
      const text = message.data;
      enqueue(() => input(text));
      return;
    }
    if (message.type === "resize") {
      const next = parseSize(message.cols, message.rows);
      if (!next) {
        ws.close(1008, "端末の大きさ（cols・rows）が範囲の外です");
        return;
      }
      enqueue(() => resize(next));
      return;
    }
    ws.close(1008, "知らないメッセージです");
  });
  ws.on("close", () => {
    alive = false;
    if (sessionId && latest.get(sessionId) === me) latest.delete(sessionId);
    control?.close();
  });

  enqueue(connect);
}

/** 閉じる理由は 123 バイトまで（WebSocket の決まり） */
function truncateReason(reason: string): string {
  let out = reason;
  while (Buffer.byteLength(out, "utf8") > 123) out = out.slice(0, -1);
  return out;
}
