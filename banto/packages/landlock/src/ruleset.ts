// docs/specs/v4-security.md「許可リストの組み方」参照。
// 生のLandlockアクセス権名を使う——意味のある束ね方（readExec等）はここだけで持つ
// （真実は一箇所、規則3）。banto-landlock-exec（Rust側）はこの語彙をそのまま解釈する。

export type AccessFsName =
  | "execute"
  | "write_file"
  | "read_file"
  | "read_dir"
  | "remove_dir"
  | "remove_file"
  | "make_char"
  | "make_dir"
  | "make_reg"
  | "make_sock"
  | "make_fifo"
  | "make_block"
  | "make_sym"
  | "refer"
  | "truncate";

export interface LandlockRule {
  path: string;
  access: AccessFsName[];
}

export interface LandlockRulesetFile {
  version: 1;
  requireAbi: number;
  rules: LandlockRule[];
}

/** kernel 6.7+ で導入されたABI。docs/specs/v4-security.mdの決定どおり固定する。 */
export const REQUIRE_ABI = 4;

export const READ_EXEC: AccessFsName[] = ["execute", "read_file", "read_dir"];
export const READ_ONLY: AccessFsName[] = ["read_file", "read_dir"];
export const READ_WRITE: AccessFsName[] = [
  "read_file",
  "read_dir",
  "write_file",
  "make_reg",
  "make_dir",
  "make_sym",
  "remove_file",
  "remove_dir",
  "refer",
  "truncate",
];
/** /dev はShellがgit等を動かすのに書き込みも要る（/dev/null等、実測済み）。 */
export const DEV_READ_WRITE: AccessFsName[] = ["read_file", "read_dir", "write_file"];
