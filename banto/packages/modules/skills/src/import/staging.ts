// 取り込みの2段（アーキ仕様 §5.7「取り込むかどうかは人が決める。AI は提案できる」）。
//
//   ① 取ってきて**仮置き**する（`prepare`）——ここまでは AI も起こせる。置き場には入らない
//   ② 人が中身を見て**押す**（`confirm`）——ここで初めて置き場に入り、配られる
//
// 仮置きは `<置き場の親>/staging/<id>/`。出所は `<置き場の親>/sources/<名前>.json`
// に残す——**取り込んだ写しの中には書かない**（原文のまま置く、§5.7）。

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseSkillMd } from "../skill-md.js";
import { findUnreachableHints, hasScripts, type UnreachableHint } from "./analyze.js";
import { assertSafeRelativePath, type ImportedFile } from "./limits.js";
import type { SkillSource } from "./source.js";

export interface SkillImportPaths {
  /** 配っている Skill の置き場（`listStoredSkills` が見るところ）。 */
  skillsDir: string;
  stagingDir: string;
  sourcesDir: string;
}

export function importPathsFor(dataDir: string): SkillImportPaths {
  return {
    skillsDir: join(dataDir, "skills"),
    stagingDir: join(dataDir, "staging"),
    sourcesDir: join(dataDir, "sources"),
  };
}

/** 人に見せるもの（§5.7「承認の前に出すもの」）。 */
export interface ImportPreview {
  stagingId: string;
  source: SkillSource;
  name: string;
  description: string;
  /** `SKILL.md` の中身そのもの。 */
  skillMd: string;
  files: Array<{ path: string; bytes: number }>;
  /** `scripts/` が同梱されているか——banto では実行されない。 */
  hasScripts: boolean;
  /** 実行やファイルの直接読み込みを前提にしていそうな行——banto では届かない。 */
  unreachable: UnreachableHint[];
  /** 同じ名前の Skill がもう在るか（在れば、押すと入れ替わる）。 */
  replaces: { source: SkillSource | null } | null;
}

/** 仮置きを残しておく長さ。押されないまま残ったものは、次の仮置きのときに片づける。 */
const STAGING_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * 押されていない仮置きの上限。仮置きは AI も起こせる（取り込みはしない）ので、
 * 繰り返し呼ばれても置き場の親を埋めないようにする。
 */
export const MAX_PENDING_IMPORTS = 20;

export async function prepareImport(
  paths: SkillImportPaths,
  files: ImportedFile[],
  source: SkillSource,
): Promise<ImportPreview> {
  await sweepStaging(paths.stagingDir);
  const pending = (await readdir(paths.stagingDir).catch(() => [] as string[])).filter((e) => /^[0-9a-f-]{36}$/.test(e));
  if (pending.length >= MAX_PENDING_IMPORTS) {
    throw new Error(
      `取り込む前の確認が ${pending.length} 件たまっています——押すか取りやめてから、もう一度取ってきてください（24時間で自動で片づきます）`,
    );
  }
  const skillMdFile = files.find((f) => f.path === "SKILL.md");
  if (!skillMdFile) throw new Error("SKILL.md がありません");
  const skillMd = new TextDecoder("utf-8", { fatal: false }).decode(skillMdFile.bytes);
  // **名前はフォルダ名にもなる**ので、取り込む前に仕様の形を満たしているかを見る
  const parsed = parseSkillMd(skillMd);
  if (!parsed.ok) throw new Error(`SKILL.md が読めません: ${parsed.problem}`);

  const stagingId = randomUUID();
  const root = join(paths.stagingDir, stagingId);
  for (const f of files) {
    assertSafeRelativePath(f.path);
    const target = join(root, "files", ...f.path.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, f.bytes);
  }
  const preview: ImportPreview = {
    stagingId,
    source,
    name: parsed.skill.name,
    description: parsed.skill.description,
    skillMd,
    files: files.map((f) => ({ path: f.path, bytes: f.bytes.byteLength })).sort((a, b) => (a.path < b.path ? -1 : 1)),
    hasScripts: hasScripts(files.map((f) => f.path)),
    unreachable: findUnreachableHints(skillMd),
    replaces: (await exists(join(paths.skillsDir, parsed.skill.name)))
      ? { source: await readSource(paths, parsed.skill.name) }
      : null,
  };
  await writeFile(join(root, "preview.json"), JSON.stringify(preview));
  return preview;
}

/** 仮置きのいまの状態。**押した後も、何が起きたかは残す**——会話を読み直したとき、
 *  画面が「取り込み済み」「取りやめ」を言えるように（仮置きと同じく24時間で片づける）。 */
export type ImportState =
  | { state: "pending"; preview: ImportPreview }
  | { state: "confirmed" | "discarded"; stagingId: string; name: string };

export async function getImport(paths: SkillImportPaths, stagingId: string): Promise<ImportState> {
  assertStagingId(stagingId);
  const root = join(paths.stagingDir, stagingId);
  if (await exists(join(root, "preview.json"))) {
    return { state: "pending", preview: JSON.parse(await readFile(join(root, "preview.json"), "utf8")) as ImportPreview };
  }
  try {
    return JSON.parse(await readFile(outcomePath(paths, stagingId), "utf8")) as ImportState;
  } catch {
    throw new Error("この取り込みはもう残っていません（期限切れ）。もう一度取ってきてください");
  }
}

function outcomePath(paths: SkillImportPaths, stagingId: string): string {
  return join(paths.stagingDir, `${stagingId}.outcome.json`);
}

async function recordOutcome(
  paths: SkillImportPaths,
  stagingId: string,
  state: "confirmed" | "discarded",
  name: string,
): Promise<void> {
  await writeFile(outcomePath(paths, stagingId), JSON.stringify({ state, stagingId, name }));
}

/**
 * **人が押したときだけ**置き場に入れる。同じ名前が在れば入れ替える
 * （仮置きの時点で `replaces` として見せてある）。
 */
export async function confirmImport(paths: SkillImportPaths, stagingId: string): Promise<{ name: string }> {
  const root = await stagingRoot(paths, stagingId);
  const preview = JSON.parse(await readFile(join(root, "preview.json"), "utf8")) as ImportPreview;
  const target = join(paths.skillsDir, preview.name);
  await mkdir(paths.skillsDir, { recursive: true });
  await mkdir(paths.sourcesDir, { recursive: true });
  // 入れ替えは「古いものを脇へ → 新しいものを置く → 古いものを消す」の順
  // ——途中で落ちても、置き場に半端なフォルダが残らない
  const previous = join(paths.stagingDir, `${stagingId}.previous`);
  const hadPrevious = await exists(target);
  if (hadPrevious) await rename(target, previous);
  try {
    await rename(join(root, "files"), target);
  } catch (err) {
    if (hadPrevious) await rename(previous, target);
    throw err;
  }
  await writeFile(
    join(paths.sourcesDir, `${preview.name}.json`),
    JSON.stringify({ ...preview.source, importedAt: new Date().toISOString() }, null, 2),
  );
  await rm(root, { recursive: true, force: true });
  if (hadPrevious) await rm(previous, { recursive: true, force: true });
  await recordOutcome(paths, stagingId, "confirmed", preview.name);
  return { name: preview.name };
}

export async function discardImport(paths: SkillImportPaths, stagingId: string): Promise<void> {
  const root = await stagingRoot(paths, stagingId);
  const preview = JSON.parse(await readFile(join(root, "preview.json"), "utf8")) as ImportPreview;
  await rm(root, { recursive: true, force: true });
  await recordOutcome(paths, stagingId, "discarded", preview.name);
}

/** 出所の記録（取り込んだものだけにある。置き場に直接置いたものには無い）。 */
export async function readSource(
  paths: SkillImportPaths,
  name: string,
): Promise<(SkillSource & { importedAt?: string }) | null> {
  try {
    return JSON.parse(await readFile(join(paths.sourcesDir, `${name}.json`), "utf8")) as SkillSource & {
      importedAt?: string;
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Skill を消す（フォルダと出所の記録）。 */
export async function removeSkill(paths: SkillImportPaths, name: string): Promise<void> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`Skill の名前が読めません: ${name}`);
  const target = join(paths.skillsDir, name);
  if (!(await exists(target))) throw new Error(`Skill「${name}」はありません`);
  await rm(target, { recursive: true, force: true });
  await rm(join(paths.sourcesDir, `${name}.json`), { force: true });
}

/** id はこちらが振った UUID だけを受ける——任意のパスを読ませない・消させない。 */
function assertStagingId(stagingId: string): void {
  if (!/^[0-9a-f-]{36}$/.test(stagingId)) throw new Error(`取り込みの id が読めません: ${stagingId}`);
}

async function stagingRoot(paths: SkillImportPaths, stagingId: string): Promise<string> {
  assertStagingId(stagingId);
  const root = join(paths.stagingDir, stagingId);
  if (!(await exists(join(root, "preview.json")))) {
    throw new Error("この取り込みはもう残っていません（取り込み済み・取りやめ・期限切れ）。もう一度取ってきてください");
  }
  return root;
}

async function sweepStaging(stagingDir: string): Promise<void> {
  const entries = await readdir(stagingDir).catch(() => [] as string[]);
  const now = Date.now();
  for (const entry of entries) {
    const path = join(stagingDir, entry);
    const info = await stat(path).catch(() => undefined);
    if (info && now - info.mtimeMs > STAGING_TTL_MS) await rm(path, { recursive: true, force: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
