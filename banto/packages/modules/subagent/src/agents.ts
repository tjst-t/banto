// サブエージェントの一覧——**エージェントを足すのは、ここに起こし方を1つ足すこと**
// （アーキ仕様 §4.1「backend ごとの橋は書かない」）。どれも ACP で話すので、違うのは
// 起こし方・専用ホームの使い方・受け取る資格情報の変数名だけ。

import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

export interface AgentDefinition {
  id: string;
  title: string;
  /**
   * 本体と、それが読み込む依存の置き場。エージェントの Landlock ドメインで読み取りと実行を許す
   * （node_modules の中のネイティブ実行ファイルを含む）。**資格情報を置かない場所だけ**
   */
  installDirs: string[];
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
}

function packageDir(name: string): string {
  return dirname(require.resolve(`${name}/package.json`));
}

/**
 * その包みを解決した node_modules。**Node で書かれたエージェントは、巻き上げられた依存
 * （`@agentclientprotocol/sdk` 等）をここから読む**——包みの中だけを許すと起動しない
 */
function nodeModulesOf(dir: string): string {
  const at = dir.lastIndexOf("/node_modules/");
  if (at < 0) throw new Error(`${dir} は node_modules の下にありません`);
  return dir.slice(0, at + "/node_modules".length);
}

function claudeCode(): AgentDefinition {
  const installDir = packageDir("@agentclientprotocol/claude-agent-acp");
  return {
    id: "claude-code",
    title: "Claude Code",
    installDirs: [nodeModulesOf(installDir)],
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
    // 単体の実行ファイルなので、包みの中だけでよい
    installDirs: [installDir],
    // postinstall が CPU に合う実行ファイルを置く（ルートの allowScripts で許している）
    command: join(installDir, "bin", "opencode.exe"),
    args: (cwd) => ["acp", "--cwd", cwd],
    homeEnv: () => ({}),
    // OpenCode Go のサブスクも API キー（OPENCODE_API_KEY）。他はプロバイダごとの変数
    credentialEnv: ["OPENCODE_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENROUTER_API_KEY"],
  };
}

/**
 * 試験用の偽エージェント（`testing/fake-agent.ts`）。**本物の代わりに E2E で使う**——
 * `BANTO_SUBAGENT_FAKE_AGENT=1` のときだけ一覧に出る（本物は出さない）。
 */
function fakeAgent(): AgentDefinition {
  const here = dirname(new URL(import.meta.url).pathname);
  return {
    id: "fake",
    title: "Fake Agent（試験用）",
    installDirs: [here, nodeModulesOf(packageDir("@agentclientprotocol/claude-agent-acp"))],
    command: process.execPath,
    args: () => [join(here, "testing", "fake-agent.js")],
    homeEnv: () => ({}),
    credentialEnv: ["FAKE_AGENT_TOKEN"],
    mode: "auto",
  };
}

export function listAgents(env: NodeJS.ProcessEnv = process.env): AgentDefinition[] {
  if (env.BANTO_SUBAGENT_FAKE_AGENT === "1") return [fakeAgent()];
  return [claudeCode(), openCode()];
}
