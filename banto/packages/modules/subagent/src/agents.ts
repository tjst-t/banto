// サブエージェントの一覧——**エージェントを足すのは、ここに起こし方を1つ足すこと**
// （アーキ仕様 §4.1「backend ごとの橋は書かない」）。どれも ACP で話すので、違うのは
// 起こし方・専用ホームの使い方・受け取る資格情報の変数名だけ。

import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export interface AgentDefinition {
  id: string;
  title: string;
  command: string;
  args: (cwd: string) => string[];
  /** 専用ホームの中に置き場を向ける変数（HOME・TMPDIR・XDG は共通で向ける） */
  homeEnv: (home: string) => Record<string, string>;
  /**
   * 受け取れる資格情報の変数名。値は Vault の alias から env で渡す——ファイルに写さない
   * （§4.1）。**渡したものはサブエージェントのシェルから読める**（v4-security.md）
   */
  credentialEnv: string[];
  /** 既定で掛けるモード（main の Runner と揃える） */
  mode?: string;
  /**
   * **banto 本体の Claude ログインを共有する**（決定・2026-09-24、ユーザー）。本物のトークンは渡さず、
   * Module の中継（`claude-login-proxy.ts`）の合言葉だけを渡す
   */
  sharesHostClaudeLogin?: boolean;
  /**
   * **この機械のエージェント自身の設定から、鍵を取り込む口**（決定・2026-09-24、ユーザー
   * 「OpenCode の Secret は設定から入れられるといい」）。人が設定画面で押したときだけ読み、
   * Vault に写す——**写しなので、元で鍵を変えたら取り込み直す**
   */
  importFrom?: {
    label: string;
    file: () => string;
    /** 変数名 → 設定ファイルから値を拾う（無ければ undefined） */
    pick: Record<string, (auth: AuthFile) => string | undefined>;
  };
}

/** OpenCode の `auth.json` の形（プロバイダ → 資格情報）。`type: "api"` だけが鍵そのもの */
export type AuthFile = Record<string, { type?: string; key?: string } | undefined>;

const apiKey = (auth: AuthFile, provider: string) => (auth[provider]?.type === "api" ? auth[provider]?.key : undefined);

function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

function claudeCode(): AgentDefinition {
  const installDir = packageDir("@agentclientprotocol/claude-agent-acp");
  return {
    id: "claude-code",
    title: "Claude Code",
    command: process.execPath,
    args: () => [join(installDir, "dist", "index.js")],
    // 会話の記録（session/load で拾う）はここに残る。人の ~/.claude には書かない
    homeEnv: (home) => ({ CLAUDE_CONFIG_DIR: join(home, ".claude") }),
    // 既定は本体のログイン（sharesHostClaudeLogin）。これらを envSecrets で渡したときだけ、そちらを使う
    credentialEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    mode: "auto",
    sharesHostClaudeLogin: true,
  };
}

function openCode(): AgentDefinition {
  const installDir = packageDir("opencode-ai");
  return {
    id: "opencode",
    title: "OpenCode",
    // postinstall が CPU に合う実行ファイルを置く（ルートの allowScripts で許している）
    command: join(installDir, "bin", "opencode.exe"),
    args: (cwd) => ["acp", "--cwd", cwd],
    homeEnv: () => ({}),
    // OpenCode Go のサブスクも API キー（OPENCODE_API_KEY）。他はプロバイダごとの変数
    credentialEnv: ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
    importFrom: {
      label: "この機械の OpenCode",
      // OpenCode 自身と同じ解決（XDG_DATA_HOME）
      file: () => join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), "opencode", "auth.json"),
      pick: {
        // OpenCode Go（サブスク）と Zen は同じ変数を読む——サブスクを先に
        OPENCODE_API_KEY: (a) => apiKey(a, "opencode-go") ?? apiKey(a, "opencode"),
        ANTHROPIC_API_KEY: (a) => apiKey(a, "anthropic"),
        OPENAI_API_KEY: (a) => apiKey(a, "openai"),
        OPENROUTER_API_KEY: (a) => apiKey(a, "openrouter"),
      },
    },
  };
}

/**
 * 試験用の偽エージェント（`testing/fake-agent.ts`）。**本物の代わりに E2E で使う**——
 * `BANTO_SUBAGENT_FAKE_AGENT=1` のときだけ一覧に出る（本物は出さない）。2つ並べる：
 * 鍵を受け取るもの（OpenCode と同じ形）と、本体のログインを共有するもの（Claude Code と同じ形）
 */
function fakeAgents(env: NodeJS.ProcessEnv): AgentDefinition[] {
  const here = dirname(new URL(import.meta.url).pathname);
  const base = {
    command: process.execPath,
    args: () => [join(here, "testing", "fake-agent.js")],
    homeEnv: () => ({}),
    mode: "auto",
  };
  return [
    {
      ...base,
      id: "fake",
      title: "Fake Agent（試験用）",
      credentialEnv: ["FAKE_AGENT_TOKEN"],
      // 取り込み元は試験が用意する（人の OpenCode の鍵を読まない）
      ...(env.BANTO_SUBAGENT_FAKE_IMPORT_FILE
        ? {
            importFrom: {
              label: "試験用の設定ファイル",
              file: () => env.BANTO_SUBAGENT_FAKE_IMPORT_FILE as string,
              pick: { FAKE_AGENT_TOKEN: (a: AuthFile) => apiKey(a, "fake") },
            },
          }
        : {}),
    },
    {
      ...base,
      id: "fake-host",
      title: "Fake Agent（本体のログイン・試験用）",
      credentialEnv: ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
      sharesHostClaudeLogin: true,
    },
  ];
}

export function listAgents(env: NodeJS.ProcessEnv = process.env): AgentDefinition[] {
  if (env.BANTO_SUBAGENT_FAKE_AGENT === "1") return fakeAgents(env);
  return [claudeCode(), openCode()];
}

/** その エージェントが Vault に置く既定の鍵の名前（banto 全体で1つ——どの Project でも使う） */
export function defaultAliasName(agentId: string, envName: string): string {
  return `subagent.${agentId}.${envName}`;
}

/** 設定画面で鍵を扱うエージェントか（本体のログインを共有するものは鍵を持たない） */
export function usesStoredKeys(agent: AgentDefinition): boolean {
  return !agent.sharesHostClaudeLogin && agent.credentialEnv.length > 0;
}
