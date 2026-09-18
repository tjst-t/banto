// **種別ごとに「何を聞くか」は、ここ1枚だけ**（決定・2026-09-13、ユーザー指摘）。
//
// 秘密の登録画面は2枚ある——会話の中の入力欄（`request-app.ts`、backend と窓口の
// 両方が配る）と、窓口の管理 Canvas（`vault-directory/manage-app.ts`）。
// **同じ規則を2箇所に書いていたので、片方だけ直る**ということが実際に起きた：
// 入力欄では「鍵ペアに『作る強さ 32 バイト』を出さない」を直したのに、
// 管理画面では出たままだった（規則3——同じことを2箇所に持つと、いつか食い違う）。
//
// 画面は素の HTML（MCP Apps）なので、**JS の断片として渡す**。
// TypeScript 側からも同じ値を読めるようにしてあるので、試験はこちらを見る。

export interface AliasKindRule {
  /** Vault の中で作れるか。**ファイルの中身はランダムに作れない。** */
  canGenerate: boolean;
  /** 値を貼ってもらうときの見出し。 */
  valueLabel: string;
  /** 1行に入らないか（秘密鍵・ファイルの中身）。 */
  multiline: boolean;
  /** 「作る強さ（形式・バイト数）」を聞くか。**鍵の強さは鍵の種類が決める。** */
  strength: boolean;
  /** 作るときに添える説明（無ければ `null`）。 */
  note: string | null;
  /** 貼る側の補足。 */
  typedHint: string;
  /** 作ったあとに公開鍵が返るか。 */
  returnsPublicKey: boolean;
  /**
   * **人が登録画面から作れる種別か**（追加・2026-09-18）。
   *
   * `false` は「banto が自分で置くもの」——人は**一覧で見て消せる**が、
   * 手で作る対象ではない（OAuth のログイン情報がこれ）。登録画面の選択肢から
   * 外すためだけの印で、**一覧からは隠さない**（何にログインしているかは
   * 見えているべき・規則13）。
   */
  humanCreatable: boolean;
}

export const ALIAS_KIND_RULES: Record<string, AliasKindRule> = {
  secret: {
    canGenerate: true,
    valueLabel: "値",
    multiline: false,
    strength: true,
    note: null,
    typedHint: "打った値は AI には渡りません",
    returnsPublicKey: false,
    humanCreatable: true,
  },
  "ssh-identity": {
    canGenerate: true,
    valueLabel: "秘密鍵（-----BEGIN OPENSSH PRIVATE KEY----- から）",
    multiline: true,
    strength: false,
    note:
      "SSH の鍵ペア（ed25519）を Vault の中で作ります。秘密鍵は誰も見ません。" +
      "作ったあとに出る公開鍵を、GitHub などに登録してください",
    typedHint: "持っている秘密鍵を貼るか、新しく作らせます（AI には渡りません）",
    returnsPublicKey: true,
    humanCreatable: true,
  },
  file: {
    canGenerate: false,
    valueLabel: "ファイルの中身",
    multiline: true,
    strength: false,
    note: null,
    typedHint: "貼った中身は AI には渡りません",
    returnsPublicKey: false,
    humanCreatable: true,
  },
  // **banto が自分で置くもの**（追加・2026-09-18、OAuth）。人は手で作らない
  // ——`putSecret` でしか入らない。一覧には出す（どこにログインしているかは
  // 人が見て、消せる＝ログアウトできるべき）
  "oauth-token": {
    canGenerate: false,
    valueLabel: "（banto が保管します）",
    multiline: true,
    strength: false,
    note: null,
    typedHint: "banto がログインのときに受け取って置いたものです",
    returnsPublicKey: false,
    humanCreatable: false,
  },
};

/**
 * 画面（素の HTML）に埋め込む JS 断片。**`<script>` の中へそのまま入れる。**
 *
 * 中身は上の表そのもの——**別々に書き直さない**（規則3）。埋め込み先が
 * テンプレート文字列なので、ここで生成する文字列に**バッククォートを入れない**
 * （入れると埋め込み先の文字列が途中で閉じる。実際に一度ビルドを壊した）。
 */
export const ALIAS_KIND_RULES_JS = `const ALIAS_KIND_RULES = ${JSON.stringify(
  ALIAS_KIND_RULES,
)};
/** その種別の規則（知らない種別は secret 扱いにせず、素直に落とさない）。 */
function kindRule(kind) { return ALIAS_KIND_RULES[kind] || ALIAS_KIND_RULES.secret; }
/** 作れる種別だけ（選べない道を選択肢に残さない——規則13）。 */
function generatableKinds() {
  return Object.keys(ALIAS_KIND_RULES).filter(function (k) { return ALIAS_KIND_RULES[k].canGenerate; });
}
/** 人が登録画面から作れる種別だけ（banto が自分で置くものは外す）。 */
function humanCreatableKinds() {
  return Object.keys(ALIAS_KIND_RULES).filter(function (k) { return ALIAS_KIND_RULES[k].humanCreatable; });
}`;
