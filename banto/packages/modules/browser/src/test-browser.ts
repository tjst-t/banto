// 試験が使うブラウザ。**入っていなければ試験を飛ばす**——入れるのは Module の仕事で、その経路は E2E が通す。
// `BANTO_BROWSER_TEST_EXECUTABLE` でブラウザを差し替えられる（Google Chrome を apt で入れていない機械で、展開した包みを使う）。
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { browserExecutablePath } from "./install.js";

export const browsersPath = process.env.BANTO_BROWSER_TEST_BROWSERS ?? join(homedir(), ".cache", "ms-playwright");
process.env.PLAYWRIGHT_BROWSERS_PATH = browsersPath;
const override = process.env.BANTO_BROWSER_TEST_EXECUTABLE;
export const executable = override ?? browserExecutablePath();
export const installed = existsSync(executable);
/** createBrowserContextFromDataDir に渡す */
export const browserOpts = { browsersPath, ...(override ? { executable: override } : {}) };
export const skipReason = installed ? false : `ブラウザ（${executable}）が入っていない`;
