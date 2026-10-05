// **走っている仕事の記録**（追加・2026-10-05、アーキ仕様 §2.5「起こし直しをまたいで続ける」の「2. Module の仕事を続ける」）。
//
// 待たない形（runInBackground）で頼まれた仕事を、走っている間この Module の置き場に1件1ファイルで残す
// （`<置き場>/running/<仕事の id>.json`）。banto を起こし直すと Module もエージェントも止まる——起き直した host に
// 「続けるか」を聞かれたら（`server.ts` の `resumeAfterRestart`）、この記録から `session/load` で続ける。
// 終われば消す（終わった仕事は今までどおり `runs.jsonl`）。
//
// **書かないもの**：資格情報・起動の env（鍵・中継の合言葉）、返信用の札そのもの。札は指紋（`replyToFingerprint`）だけ
// 残し、問われたときに host が渡す札と照らす。資格情報は続けるときに同じ alias 名（`envSecrets`——名前であって値では
// ない）から受け取り直す。
//
// **頼んだ文は全文残す**（仕様の挙げた「頼んだ文の頭」より多い）：最初の頼みが記録される前に切れた仕事（claude-agent-acp
// は load できない）は、同じ頼みで最初からやり直すため。終わった仕事の記録（`runs.jsonl`）も全文を持っている。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunningRecord {
  /** 仕事の id（`runs.ts` の id と同じ。続けても変えない） */
  id: string;
  agent: string;
  agentTitle: string;
  /** 作業場所（Project の根） */
  cwd: string;
  /** エージェントの会話の id。`session/new` の返事で分かった時点で書く（prompt を送る前） */
  sessionId?: string;
  model?: string;
  effort?: string;
  /** 頼んだときの envSecrets（環境変数名 → Vault の alias 名。**値ではない**） */
  envSecrets?: Record<string, string>;
  /** 返信用の札の指紋（札そのものは書かない） */
  replyToFingerprint: string;
  /** 頼んだ Thread（host の刻印 `dev.banto/thread`） */
  requestedBy?: { projectId: string; threadId: string };
  /** 頼んだ文（全文——上の注記） */
  prompt: string;
  /** 頼んだ文の頭（一覧・ログ用） */
  promptHead: string;
  /** 続きから頼んだ仕事なら元の session id（runSubagent の sessionId） */
  resumedFrom?: string;
  startedAt: number;
  /** 何か進んだか（tool を呼んだ・返答を書き始めた）。進む前に切れて load できないなら、最初からやり直せる */
  progressed: boolean;
  /** 実行中の tool（呼んで、まだ終わりが来ていないもの。古い順） */
  toolsInFlight: Array<{ id?: string; title: string }>;
  /** 起こし直しのあと続けた回数 */
  resumes: number;
  /**
   * 仕事は終わったが、届ける前に止まった（host が落ちていた等）。続けるときは走らせ直さずにこれを届ける
   */
  finished?: { title: string; text: string };
}

const HEAD = 80;

export function promptHeadOf(prompt: string): string {
  const flat = prompt.replace(/\s+/g, " ").trim();
  return flat.length > HEAD ? `${flat.slice(0, HEAD)}…` : flat;
}

export class RunningStore {
  private readonly dir: string;

  constructor(moduleDataDir: string) {
    this.dir = join(moduleDataDir, "running");
  }

  /** 書く（一時ファイル→rename。置き場は人だけが読める） */
  write(record: RunningRecord): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.fileOf(record.id);
    writeFileSync(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  }

  /** 書き足す（無ければ何もしない——もう終わって消えた） */
  update(id: string, change: (r: RunningRecord) => void): void {
    const r = this.get(id);
    if (!r) return;
    change(r);
    this.write(r);
  }

  get(id: string): RunningRecord | undefined {
    const file = this.fileOf(id);
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RunningRecord) : undefined;
  }

  remove(id: string): void {
    rmSync(this.fileOf(id), { force: true });
  }

  /** 残っている記録（起動したとき＝前の走行で走っていたもの）。壊れたファイルは読み飛ばさず投げる（規則2） */
  list(): RunningRecord[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as RunningRecord);
  }

  private fileOf(id: string): string {
    return join(this.dir, `${id.replace(/[^A-Za-z0-9-]/g, "")}.json`);
  }
}
