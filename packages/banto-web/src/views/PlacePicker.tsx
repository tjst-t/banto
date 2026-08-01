/**
 * 場所を選ぶ部品（ADR-0010 決定36e・task-0043）。
 *
 * `file.*` / `git.*` は場所を引数で受け取る（決定36e）。番頭は会話の中で「loamium の docs を
 * 見せて」と言われた場所を引数に写せばよいが、**POが自分でGUIを開いたときは誰も引数を
 * 埋めていない**——repo-manager が場所を13個返すようになった時点で、既定が決まらず
 * 「Multiple places are registered」で開けなくなっていた。
 *
 * 決定36f のとおり番頭に「いまどの場所か」という状態は持たせない。**選んだ場所を持つのは
 * この画面**で、Tool 呼び出しごとに引数として渡す——人も番頭も同じ契約で、経路が違うだけ
 * （決定25）。
 */

import { useEffect, useState } from "react";
import { useModuleTool } from "./useModuleTool.js";

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
  setPlace(id: string): void;
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

  return { place, places, error: list.error, setPlace };
}

/** 場所を選ぶプルダウン。ツールバーに置く。 */
export function PlacePicker({
  selection,
  title = "どの場所を見るか",
}: {
  selection: PlaceSelection;
  title?: string;
}): React.ReactElement {
  const { place, places, setPlace } = selection;
  if (places.length === 0) {
    return <span className="fb-muted">{selection.error ? "場所を取得できません" : "…"}</span>;
  }
  return (
    <select
      className="place-picker"
      value={place ?? ""}
      title={title}
      onChange={(e) => setPlace(e.target.value)}
    >
      {places.map((p) => (
        <option key={p.id} value={p.id}>
          {p.label}
          {p.writable.length > 0 ? " ✎" : ""}
        </option>
      ))}
    </select>
  );
}
