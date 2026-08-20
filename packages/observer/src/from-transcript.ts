/**
 * Claude Code のトランスクリプト（~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl）を、
 * 観測の入力に変える。
 *
 * **これは第三者のファイル。** banto 自身のイベントログ（from-log.ts）と違い、
 * 版印もスキーマの保証も無い。壊れた行・想定外の形に当たっても投げずに数えて返す
 * ——ただし「数えずに握りつぶす」ことだけは規則2でやってはいけない。
 */

import { readdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { Turn } from './observe.js';

export interface TranscriptScanResult {
  readonly turns: Turn[];
  /** type:"assistant" だが .message.usage が無かった行の数。 */
  readonly skippedNoUsage: number;
  /** isSidechain:true だった行の数（turns には含めたまま、別枠で数える）。 */
  readonly sidechainTurns: number;
  /** JSON として読めなかった行の数。 */
  readonly malformedLines: number;
  /** 走査した .jsonl ファイルの数。 */
  readonly files: number;
  /** turns に1件以上残ったセッション（ファイル）の数。 */
  readonly sessions: number;
  /**
   * type:"assistant" の**行数**（重複を落とす前）。
   *
   * `turns.length` と必ず併記する。ADR-0001 に載っている「88,711 ターン」は
   * この行数のほうなので、片方だけ出すと過去の計測と突き合わせられなくなる。
   */
  readonly rawAssistantLines: number;
  /** 同じ message.id の2通目以降として落とした行数。 */
  readonly duplicateLines: number;
}

const DEFAULT_ROOT = path.join(os.homedir(), '.claude', 'projects');

/** トランスクリプトの assistant 行のうち、使う部分だけの最小の形。 */
interface AssistantLine {
  readonly type: 'assistant';
  readonly isSidechain?: boolean;
  readonly message?: {
    readonly id?: unknown;
    readonly usage?: {
      readonly input_tokens?: unknown;
      readonly cache_creation_input_tokens?: unknown;
      readonly cache_read_input_tokens?: unknown;
      readonly output_tokens?: unknown;
    };
  };
}

function isAssistantLine(value: unknown): value is AssistantLine {
  return typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'assistant';
}

/** 4つの usage フィールドが揃っていて数値であることを確かめる。1つでも欠けたら undefined。 */
function readUsage(line: AssistantLine): Turn['usage'] | undefined {
  const usage = line.message?.usage;
  if (usage === undefined) return undefined;
  const { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } = usage;
  if (
    typeof input_tokens !== 'number' ||
    typeof cache_creation_input_tokens !== 'number' ||
    typeof cache_read_input_tokens !== 'number' ||
    typeof output_tokens !== 'number'
  ) {
    return undefined;
  }
  // 実データで確認した別枠：message.id が "msg_" 始まりでない合成行（API 応答ではない）は
  // 4項目とも 0 になる。相関を実測で確認済み（0/89,040 行が「非 msg_ 接頭辞なのに非ゼロ」）。
  // これを usage 扱いすると、文脈サイズが 0 のターンが混じり、そこへの下降を圧縮の発火と
  // 誤検出する（observe.ts の compactionDropRatio が拾ってしまう）。「usage が無い」の一種として
  // 同じ skippedNoUsage に数える——別カウンタを増やさない。
  if (input_tokens === 0 && cache_creation_input_tokens === 0 && cache_read_input_tokens === 0 && output_tokens === 0) {
    return undefined;
  }
  return {
    inputTokens: input_tokens,
    cacheCreationInputTokens: cache_creation_input_tokens,
    cacheReadInputTokens: cache_read_input_tokens,
    outputTokens: output_tokens,
  };
}

/**
 * 1ファイル分を読む。seriesId はファイル名（拡張子抜き）。
 *
 * **同じ message.id を持つ assistant 行は1ターンに畳む。**
 * 応答の streaming 中、SDK は完了した content block ごとに1通ずつ出し、
 * どれも同じ累積 usage を載せている（sdk.d.ts の SDKAssistantMessage の説明、
 * および実測：同一 id 内で usage の食い違い 0 件）。
 *
 * 畳まないと実測で 1.81 倍に膨らみ、同じ文脈サイズが繰り返されて、
 * content block が多かったメッセージへ分位点の重みが寄る。
 * どれを残しても同じ値なので、最初の1通を残す。
 *
 * message.id が無い行は畳まない——畳む根拠が無いものを、勝手に同一視しない。
 */
async function scanFile(file: string): Promise<{
  turns: Turn[];
  skippedNoUsage: number;
  sidechainTurns: number;
  malformedLines: number;
  rawAssistantLines: number;
  duplicateLines: number;
}> {
  const seriesId = path.basename(file, '.jsonl');
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');

  const turns: Turn[] = [];
  let skippedNoUsage = 0;
  let sidechainTurns = 0;
  let malformedLines = 0;
  let rawAssistantLines = 0;
  let duplicateLines = 0;
  const seenMessageIds = new Set<string>();

  for (const raw of lines) {
    if (raw.trim() === '') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      malformedLines += 1;
      continue;
    }

    if (!isAssistantLine(parsed)) continue;
    rawAssistantLines += 1;

    const messageId = parsed.message?.id;
    if (typeof messageId === 'string') {
      if (seenMessageIds.has(messageId)) {
        duplicateLines += 1;
        continue;
      }
      seenMessageIds.add(messageId);
    }

    const usage = readUsage(parsed);
    if (usage === undefined) {
      skippedNoUsage += 1;
      continue;
    }

    if (parsed.isSidechain === true) sidechainTurns += 1;
    // 畳んだ後の並び順。行の位置ではなくターンの位置を持つ。
    turns.push({ seriesId, index: turns.length, usage });
  }

  return { turns, skippedNoUsage, sidechainTurns, malformedLines, rawAssistantLines, duplicateLines };
}

/** root 配下を再帰的に走査して *.jsonl を探す。 */
async function findJsonlFiles(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true, recursive: true });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw cause;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    // recursive:true の Dirent.path は見つかったディレクトリの絶対パス（Node 20+）。
    const dir = entry.parentPath ?? entry.path;
    files.push(path.join(dir, entry.name));
  }
  return files;
}

/**
 * root（既定 ~/.claude/projects）配下の全 *.jsonl を読み、observe() にそのまま渡せる
 * Turn[] にする。読み取り専用——書き込みは一切しない。
 */
export async function scanTranscripts(root: string = DEFAULT_ROOT): Promise<TranscriptScanResult> {
  const files = await findJsonlFiles(root);

  const turns: Turn[] = [];
  let skippedNoUsage = 0;
  let sidechainTurns = 0;
  let malformedLines = 0;
  let rawAssistantLines = 0;
  let duplicateLines = 0;
  const sessionsWithTurns = new Set<string>();

  for (const file of files) {
    const result = await scanFile(file);
    turns.push(...result.turns);
    skippedNoUsage += result.skippedNoUsage;
    sidechainTurns += result.sidechainTurns;
    malformedLines += result.malformedLines;
    rawAssistantLines += result.rawAssistantLines;
    duplicateLines += result.duplicateLines;
    if (result.turns.length > 0) {
      const seriesId = path.basename(file, '.jsonl');
      sessionsWithTurns.add(seriesId);
    }
  }

  return {
    turns,
    skippedNoUsage,
    sidechainTurns,
    malformedLines,
    files: files.length,
    sessions: sessionsWithTurns.size,
    rawAssistantLines,
    duplicateLines,
  };
}
