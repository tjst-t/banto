/**
 * 場所を選ぶ部品（ADR-0010 決定36e・task-0043）。
 *
 * `file.*` / `git.*` は場所を引数で受け取る（決定36e）。番頭は会話の中で言われた場所を
 * 引数に写せばよいが、**POが自分でGUIを開いたときは誰も引数を埋めていない**——
 * だから「選んだ場所を持つのはこの画面」で、Tool 呼び出しごとに引数として渡す。
 * 人も番頭も同じ契約で、経路が違うだけ（決定25）。
 *
 * 決定36f のとおり番頭に「いまどの場所か」という状態は持たせない。
 */

import { useEffect, useMemo, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";
import { Modal, SearchField } from "./ui.js";

export interface PlaceInfo {
  id: string;
  label: string;
  path: string;
  writable: string[];
}

interface PlaceList {
  places: PlaceInfo[];
  total: number;
}

export interface PlaceSelection {
  /** 選ばれている場所。まだ分かっていなければ undefined（この間はデータを取りにいかない）。 */
  place: string | undefined;
  places: PlaceInfo[];
  error: string | undefined;
  loading: boolean;
  setPlace(id: string): void;
  /** 選ばれている場所の詳細（パス・書ける範囲）。 */
  current: PlaceInfo | undefined;
}

/**
 * 場所の一覧を引き、1つを選んだ状態を持つ。
 *
 * @param initial 番頭が `canvas.open` で指定した場所（省略可）
 */
export function usePlaceSelection(endpoint: string, initial?: string): PlaceSelection {
  const list = useModuleTool<PlaceList>(endpoint, "place.list");
  const [place, setPlace] = useState<string | undefined>(initial);
  const places = list.data?.places ?? [];

  useEffect(() => {
    if (places.length === 0) return;
    // 指定が無い、または指定が消えた（リポジトリが減った等）なら先頭に落とす。
    // I2 の例外ではない——ここは「どこを見るか」の初期値であって、書き込み先ではない。
    // 番頭側は今までどおり、複数あるのに省略したら聞き返される
    if (!place || !places.some((p) => p.id === place)) setPlace(places[0]!.id);
  }, [places, place]);

  return {
    place,
    places,
    error: list.error,
    loading: list.loading,
    setPlace,
    current: places.find((p) => p.id === place),
  };
}

// ── 場所の並べ方 ─────────────────────────────────────────────────────────────

/**
 * ワークツリーの枝名。repo-manager は `<id>（ワークツリー: <branch>）` という label を作る
 * （`discovery.ts`）。**枝名が主役**なので、そこだけ取り出して前に出す。
 * 形が変わったら単に取り出せなくなるだけで、id と path はそのまま出る（壊れない）。
 */
function branchOf(place: PlaceInfo): string | undefined {
  return /（ワークツリー:\s*(.+?)）\s*$/.exec(place.label)?.[1];
}

export interface PlaceGroup {
  /** 束ねている元（リポジトリ）。無い場合は undefined。 */
  head?: PlaceInfo;
  title: string;
  items: PlaceInfo[];
}

/**
 * 場所を**リポジトリごとに束ねる**。
 *
 * ghq のリポジトリ（`user/project`）と gwq のワークツリー（`user/project/branch-dir`）が
 * 平らに並ぶと、リポジトリを2つ3つ並行で触った時点で選べなくなる。id の前方一致で
 * 「どのリポジトリのものか」を導き、親の下にぶら下げる。
 *
 * D3: 台帳は持たない。届いた一覧から**導出する**だけ——モジュール側に構造を足させると、
 * 場所を出すすべての提供元がその形に合わせる羽目になる。
 */
export function groupPlaces(places: PlaceInfo[]): PlaceGroup[] {
  /** その場所が属するリポジトリの鍵（`user/project`）。分からなければ undefined。 */
  const keyOf = (place: PlaceInfo): string | undefined => {
    // ① 別の場所の id が前方一致するなら、それが束ね元（リポジトリ本体が場所として在る場合）
    let best: string | undefined;
    for (const other of places) {
      if (other.id === place.id) continue;
      if (!place.id.startsWith(`${other.id}/`)) continue;
      if (best === undefined || other.id.length > best.length) best = other.id;
    }
    if (best !== undefined) return best;
    // ② ワークツリーなら id の末尾（枝の置き場）を落とした残りがリポジトリ。
    //    **本体が場所として登録されていなくても束ねられる**——設定（BANTO_PLACES）で
    //    足した場所が同じパスを先取りすると、ghq 由来の本体は一覧に出てこない
    if (branchOf(place)) {
      const cut = place.id.lastIndexOf("/");
      if (cut > 0) return place.id.slice(0, cut);
    }
    return undefined;
  };

  /** 鍵 → その下のワークツリー。 */
  const children = new Map<string, PlaceInfo[]>();
  /** 誰かの下に入る場所（＝それ自身は上位に出さない）。 */
  const isChild = new Set<string>();
  for (const place of places) {
    const key = keyOf(place);
    if (key === undefined) continue;
    (children.get(key) ?? children.set(key, []).get(key)!).push(place);
    isChild.add(place.id);
  }

  /**
   * 鍵に対する「本体」。id が一致するもの、無ければ**パスの末尾が鍵と一致する場所**
   * （ghq の並びなら `.../user/project`）——名前を別に付けていても同じリポジトリだと分かる。
   */
  const headOf = (key: string): PlaceInfo | undefined =>
    places.find((p) => p.id === key) ??
    places.find((p) => p.path.replace(/\/+$/, "").endsWith(`/${key}`));

  /**
   * **上位の場所は、枝を持つかどうかに関わらず1つずつ並べる。**
   *
   * 以前は「子を持つ場所だけ」を束ねの頭にしていたため、ワークツリーを1つも切っていない
   * リポジトリが「そのほかの場所」へ落ちていた（PO報告 2026-08-05）——リポジトリで
   * あることと、枝を切ってあることは関係がない。
   */
  const groups: PlaceGroup[] = [];
  const claimed = new Set<string>();
  for (const place of places) {
    if (isChild.has(place.id)) continue;
    const key = [...children.keys()].find((k) => headOf(k)?.id === place.id);
    const items = key === undefined ? [] : children.get(key) ?? [];
    if (key !== undefined) claimed.add(key);
    groups.push({ head: place, title: place.id, items });
  }

  // 本体が場所として出てこない鍵（設定が同じパスを先取りした等）は、鍵を見出しにして並べる
  for (const [key, items] of children) {
    if (claimed.has(key)) continue;
    groups.push({ title: key, items });
  }
  return groups;
}

/** 一覧に出す1行分の見出し。ワークツリーは枝名、それ以外は名前。 */
function displayOf(place: PlaceInfo): { name: string; sub: string } {
  const branch = branchOf(place);
  return branch ? { name: branch, sub: place.id } : { name: place.label, sub: place.path };
}

/**
 * 場所を選ぶ口。道具立ての先頭に置く。
 *
 * **`<select>` をやめた**——選択肢の見た目は OS が描くので、行を2段にすることも、
 * リポジトリごとに束ねることも、絞り込むこともできない。場所は10も20も増えるものなので、
 * 探せない一覧は使えない。押すと面（Modal）が開き、絞り込みと束ねた一覧から選ぶ。
 *
 * **書ける場所には印を付ける**（✎）——読み取り専用かどうかは、開く前に見えている必要がある。
 */
export function PlacePicker({
  selection,
  title = "どの場所を見るか",
}: {
  selection: PlaceSelection;
  title?: string;
}): React.ReactElement {
  const { places, setPlace, current } = selection;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched =
      q.length === 0
        ? places
        : places.filter((p) => `${p.id} ${p.label} ${p.path}`.toLowerCase().includes(q));
    return groupPlaces(matched);
  }, [places, query]);

  if (places.length === 0) {
    return (
      <span className="cv-muted">
        {selection.error ? "場所を取得できません" : selection.loading ? "…" : "場所がありません"}
      </span>
    );
  }

  const shown = current ? displayOf(current) : undefined;

  return (
    <>
      <button
        type="button"
        className="place-btn"
        onClick={() => setOpen(true)}
        aria-label={title}
        title={
          current
            ? `${current.path}${
                current.writable.length > 0
                  ? `（書込可: ${current.writable.join(", ")}）`
                  : "（読み取り専用）"
              }`
            : title
        }
      >
        <span className="place-btn-icon" aria-hidden="true">
          {current && branchOf(current) ? "⑂" : "▤"}
        </span>
        <span className="place-btn-label">{shown?.name ?? "場所を選ぶ"}</span>
        {current && current.writable.length > 0 && (
          <span className="place-btn-write" title="書き込みが許された範囲があります">
            ✎
          </span>
        )}
        <span className="place-btn-caret" aria-hidden="true">
          ▾
        </span>
      </button>

      {open && (
        <Modal
          title={title}
          onClose={() => {
            setOpen(false);
            setQuery("");
          }}
        >
          <div className="place-search">
            <SearchField
              value={query}
              onChange={setQuery}
              placeholder="リポジトリ名・枝名・パスで絞る"
              autoFocus
            />
          </div>
          {groups.length === 0 ? (
            <p className="catalog-empty">「{query}」に当てはまる場所はありません。</p>
          ) : (
            groups.map((group) => (
              <div
                key={group.head?.id ?? group.title}
                className={`place-group ${group.items.length > 0 ? "is-nested" : ""}`}
              >
                <div className="place-group-head">
                  {group.head ? (
                    <PlaceRow
                      place={group.head}
                      current={current?.id === group.head.id}
                      /* 「本体」と言えるのは、下に枝がぶら下がっているときだけ——
                         枝の無い場所に付けると、リポジトリでないものまで本体に見える */
                      isHead={group.items.length > 0}
                      onPick={(id) => {
                        setPlace(id);
                        setOpen(false);
                        setQuery("");
                      }}
                    />
                  ) : (
                    <div className="catalog-group-label">{group.title}</div>
                  )}
                </div>
                {group.items.map((place) => (
                  <PlaceRow
                    key={place.id}
                    place={place}
                    current={current?.id === place.id}
                    indented={group.head !== undefined}
                    onPick={(id) => {
                      setPlace(id);
                      setOpen(false);
                      setQuery("");
                    }}
                  />
                ))}
              </div>
            ))
          )}
        </Modal>
      )}
    </>
  );
}

function PlaceRow({
  place,
  current,
  isHead = false,
  indented = false,
  onPick,
}: {
  place: PlaceInfo;
  current: boolean;
  /** 下に枝を持つリポジトリ本体か（札を出すかどうか）。 */
  isHead?: boolean;
  indented?: boolean;
  onPick: (id: string) => void;
}): React.ReactElement {
  const shown = displayOf(place);
  const branch = branchOf(place);
  return (
    <button
      type="button"
      className={`place-row ${current ? "is-current" : ""} ${isHead ? "is-head" : ""} ${
        indented ? "is-child" : ""
      }`}
      onClick={() => onPick(place.id)}
      title={place.path}
    >
      <span className="place-row-mark" aria-hidden="true">
        {branch ? "⑂" : "▤"}
      </span>
      <span className="place-row-main">
        <span className="place-row-name">
          {shown.name}
          {isHead && <span className="place-row-tag">リポジトリ本体</span>}
        </span>
        <span className="place-row-sub">{place.path}</span>
      </span>
      {place.writable.length > 0 ? (
        <span className="place-row-write" title={`書込可: ${place.writable.join(", ")}`}>
          ✎ 書ける
        </span>
      ) : (
        <span className="place-row-ro">読み取り専用</span>
      )}
      {current && <span className="place-row-check">✓</span>}
    </button>
  );
}
