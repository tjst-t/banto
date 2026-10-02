// clone の間だけ、git に資格情報を渡す窓口（docs/specs/v4-modules.md §2.4、段階3）。
//
// **トークンをコマンドの引数・環境に置かない**：引数（`https://user:token@…`）は ps に、環境（`GIT_ASKPASS` に渡す
// 値・`http.extraHeader` を `GIT_CONFIG_*` で）は `/proc/<pid>/environ` に出る。代わりに、持ち主だけが入れる一時の
// フォルダに unix socket を立て、git の credential helper（`git-credential-helper.js`、引数は socket の場所だけ）が
// そこから受け取る。**答えるのは決めた相手（protocol と host）にだけ**——リダイレクト先など別の相手には渡さない。
// clone が終わったら閉じて、フォルダごと消す。

import { existsSync } from "node:fs";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "./git.js";

const HELPER = fileURLToPath(new URL("./git-credential-helper.js", import.meta.url));

/**
 * 窓口を置く親のフォルダ。**unix socket のパスは 108 字まで**——`os.tmpdir()` は長いことがある（banto の
 * サブエージェントの home 等）ので、持ち主だけが入れる短い場所（`XDG_RUNTIME_DIR`、無ければ `/run/user/<uid>`、
 * それも無ければ `/tmp`）に置く
 */
export function credentialParent(): string {
  const candidates = [process.env.XDG_RUNTIME_DIR, process.getuid ? `/run/user/${process.getuid()}` : undefined, "/tmp"];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return tmpdir();
}

export interface CredentialWindow {
  /** git の `credential.helper` に入れる値（秘密は入っていない） */
  helperCommand: string;
  /** 何回渡したか（試験が見る） */
  served(): number;
  close(): Promise<void>;
}

export async function openCredentialWindow(input: {
  protocol: string;
  host: string;
  username: string;
  password: string;
}): Promise<CredentialWindow> {
  const dir = await mkdtemp(join(credentialParent(), "banto-git-cred-"));
  await chmod(dir, 0o700);
  const socketPath = join(dir, "s");
  let served = 0;
  const server = createServer((conn) => {
    let line = "";
    conn.setEncoding("utf8");
    conn.on("data", (c: string) => {
      line += c;
      if (!line.includes("\n")) return;
      let asked: { protocol?: unknown; host?: unknown } = {};
      try {
        asked = JSON.parse(line.slice(0, line.indexOf("\n"))) as typeof asked;
      } catch {
        // 読めない問い——何も渡さない
      }
      if (asked.protocol === input.protocol && asked.host === input.host) {
        served += 1;
        conn.end(`username=${input.username}\npassword=${input.password}\n`);
      } else conn.end("");
    });
    conn.on("error", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  // 窓口がプロセスを生かし続けない（閉じ忘れても、Module の終わりを止めない）
  server.unref();
  const quote = shellQuote;
  return {
    helperCommand: `!${quote(process.execPath)} ${quote(HELPER)} ${quote(socketPath)}`,
    served: () => served,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}
