/**
 * 場所（Place）— 番頭が作業してよい場所の契約（ADR-0010 決定36c・task-0038）。
 *
 * 番頭は複数のリポジトリを相手にする（決定36）。そのとき「**いま許されている場所の
 * 集合**」が分かれば、読み取りも副作用も同じ砦を通せる。契約はそれだけにする。
 *
 * **「作る・壊す」はここに入れない。** ワークツリーを切るのは repo-manager 固有の仕事で、
 * 静的なパスに「ワークツリーを追加」は意味がない——共通化すると片方が空実装になり、
 * それは契約が間違っている印である。
 *
 * **フレームワークは場所の意味を知らない。** `docs/` や `work/` のようなパス構成は
 * プロジェクト側の語彙であって、ここには現れない（決定38f）。
 *
 * D3: 場所の一覧は提供元が毎回導出する。ここで台帳を持たない。
 * D5: 判断は無い。契約の形だけ。
 * D6: 依存なし（型のみ）。
 */

/** 作業してよい場所1つ。 */
export interface Place {
  /**
   * 場所の識別子。番頭と PO がこれで場所を指す。
   * 提供元の中で一意であればよい（例：`github.com/tjst-t/banto`）。
   */
  id: string;
  /** 人に見せる名前。 */
  label: string;
  /** 絶対パス。砦はこの配下かどうかで判定する。 */
  path: string;
  /**
   * 番頭が**書いてよい**範囲（このパスからの相対 glob）。空なら読み取り専用。
   *
   * 既定は読み取り専用で、PO が明示的に許した場所だけが値を持つ（決定38a）。
   * **宣言は番頭が書けない場所（ホスト設定）に置く**——リポジトリ内に置くと番頭が
   * それ自体を書き換えて自分の権限を広げられる（決定38b・I1）。
   */
  writable?: readonly string[];
  /**
   * この場所が属する親の場所のID（任意。PO裁定 2026-08-05）。
   *
   * **ワークツリーは親リポジトリを指す。** 場所としては別（パスが違い、書き込み範囲も別に
   * 決まる）だが、**統治の単位＝プロジェクトとしては同じ**——`spec-multi-project` §1 の
   * 「統治の単位はプロジェクト」に照らすと、同じリポジトリのブランチを切り替えただけで
   * プロジェクトの記憶（ADR-0003）が見えなくなるのは筋が通らない。
   *
   * **砦には効かない。** 書き込み許可・範囲チェックは場所ごとのままで、親を持つことで
   * 権限が広がることはない（決定38：許可は場所ごとに PO が明示する）。
   */
  parent?: string;
}

/**
 * その場所が属するプロジェクトのID（ADR-0003 の第二層の単位）。
 *
 * 親があれば親、無ければ自分。**記憶の層を決めるのはここ1箇所**——呼び出し側が
 * それぞれ `parent ?? id` と書くと、1箇所書き忘れた時点でワークツリーが別の
 * プロジェクトとして記憶を持ち始める。
 */
export function projectIdOf(place: Pick<Place, "id" | "parent">): string {
  return place.parent ?? place.id;
}

/**
 * 場所の一覧を、プロジェクト（統治の単位）の一覧に畳む。
 *
 * ワークツリーが5本あっても、記憶の上では親リポジトリ1つとして現れる。
 * 並び順は入力のまま（先に出てきた親の位置を保つ）。
 */
export function projectScopesOf(
  places: readonly Place[]
): Array<{ id: string; label: string }> {
  return resolveProjects(places).scopes;
}

/** 場所の一覧をプロジェクトへ畳んだ結果。 */
export interface ProjectResolution {
  /** 場所ID → プロジェクトID。記憶の層はこれで決まる。 */
  idByPlace: Map<string, string>;
  /** プロジェクトの一覧（表示用）。入力の並び順を保つ。 */
  scopes: Array<{ id: string; label: string }>;
  /**
   * 畳んだ別名（プロジェクトID → 同じ場所を指す別のID）。
   *
   * **空でないことは異常ではない**が、記憶のファイルが別名側にも残っていないかは
   * 呼び出し側が確かめること（黙って片方だけ読むと、覚えたはずのことが消えて見える）。
   */
  aliases: Map<string, string[]>;
}

/**
 * 場所をプロジェクト（統治の単位）へ畳む。**2段階**（PO裁定 2026-08-05）:
 *
 * 1. **親子**——ワークツリーは親リポジトリへ（`parent`）
 * 2. **同じパス**——`BANTO_PLACES` の静的な場所と repo-manager が出す同じリポジトリのように、
 *    **別名で同じディレクトリを指しているもの**は1つのプロジェクトへ
 *
 * 2 が要る理由：同じ場所なのに名前が2つあると、どちらの名前で覚えたかで記憶が見えなくなる。
 * **畳むのは記憶の層だけで、砦は場所ごとのまま**——書き込み許可は場所ごとに PO が明示する
 * （決定38）ので、畳んだことで権限が広がることはない。
 *
 * 代表IDは**辞書順で最小のもの**を採る。並び順や登録の仕方に依らず決まる規則にしておかないと、
 * 設定を触ったときに代表が入れ替わり、過去の記憶が別のIDの下に取り残される。
 *
 * @param pathKey 場所の同一性を判定する鍵。既定は `place.path` の文字列一致。
 *   **シンボリックリンクを解決したいときは呼び出し側が渡す**（ここは fs に依存しない・D6）
 */
export function resolveProjects(
  places: readonly Place[],
  pathKey: (place: Place) => string = (place) => place.path
): ProjectResolution {
  // ① 親子。親が一覧に無くても、宣言された親IDをそのまま使う
  const declaredOf = new Map<string, string>();
  for (const place of places) declaredOf.set(place.id, projectIdOf(place));

  // ② 同じパス。畳む相手は「宣言された親ID」として一覧に**実在する**場所だけ
  //    （親が一覧に無いものはパスが分からないので畳めない）
  const byId = new Map(places.map((p) => [p.id, p]));
  const groupByPath = new Map<string, string[]>();
  for (const declared of new Set(declaredOf.values())) {
    const place = byId.get(declared);
    if (!place) continue;
    const key = pathKey(place);
    const group = groupByPath.get(key) ?? [];
    group.push(declared);
    groupByPath.set(key, group);
  }
  /** 代表ID。辞書順で最小＝並び順に依らない */
  const canonicalOf = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  for (const group of groupByPath.values()) {
    const sorted = [...group].sort();
    const canonical = sorted[0]!;
    for (const id of group) canonicalOf.set(id, canonical);
    const others = sorted.slice(1);
    if (others.length > 0) aliases.set(canonical, others);
  }

  const idByPlace = new Map<string, string>();
  for (const [placeId, declared] of declaredOf) {
    idByPlace.set(placeId, canonicalOf.get(declared) ?? declared);
  }

  // 表示用の一覧。入力の並び順を保つ（PO が見慣れた順が変わらない）
  const scopes: Array<{ id: string; label: string }> = [];
  const seen = new Set<string>();
  for (const place of places) {
    const id = idByPlace.get(place.id)!;
    if (seen.has(id)) continue;
    seen.add(id);
    // 代表そのものが一覧にあれば、その label を使う。
    //
    // 無ければ**IDから作る**——子の label をそのまま流用すると、親の枠に
    // 「…（ワークツリー: feat/x）」と出て、あたかもそのブランチの記憶であるかのように読める。
    // 実際には親リポジトリ全体の記憶なので、名乗りが中身と食い違う。
    scopes.push({ id, label: byId.get(id)?.label ?? labelFromId(id) });
  }

  return { idByPlace, scopes, aliases };
}

/**
 * IDから表示名を作る。ホスト名の段を落とす（`github.com/tjst-t/banto` → `tjst-t/banto`）。
 * 段が足りないものはそのまま——短くして取り違えるより読みにくい方がよい。
 */
function labelFromId(id: string): string {
  const segments = id.split("/");
  return segments.length >= 3 ? segments.slice(1).join("/") : id;
}

/**
 * 場所の提供元。実装は repo-manager（`ghq`/`gwq` から導出）とホスト設定（静的）。
 *
 * `RuntimeDriver`（決定11）・`EnvDriver`（決定32）と同じ形——契約は中立な共通ライブラリに
 * 置き、具象は差し替えられるようにする。
 */
export interface PlaceProvider {
  /** 提供元の名前。同じ id の場所が複数の提供元から出たときの区別に使う。 */
  readonly name: string;
  /**
   * いま提供できる場所の一覧。**導出すること**（D3：台帳を持たない）。
   *
   * 導出が重い提供元は、**少し古い写しを返してよい**——場所の解決は Tool 呼び出しの
   * たびに起きるので、毎回外部コマンドを起こすと画面が目に見えて遅くなる。その場合は
   * `refresh` を実装して、呼び手が取り直せるようにすること。
   *
   * I2: 提供元が使えない（`ghq` 未導入等）ときは**空を返す**。例外にして番頭を止めない
   * ——他の提供元の場所だけで動けばよい。
   */
  list(): Promise<Place[]>;
  /**
   * 次の `list` で導出し直す（任意）。
   *
   * 呼び手は「探している場所が見つからない」ときにこれを呼んでから、もう一度 `list` を
   * 引く。写しを持たない提供元は実装しなくてよい——毎回導出しているなら、取り直す意味が
   * 無いため。
   */
  refresh?(): void | Promise<void>;
}
