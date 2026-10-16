"use client";

// **並べ替えられる縦の一覧**（決定・2026-09-11、ユーザー要望）。
//
// 並べ替えは既に名前のある問題（規則12）なので自作しない——dnd-kit を使う。
// 自作すると、掴む判定・自動スクロール・キーボード操作・読み上げの通知を
// 同じだけ作り直すことになる（依存を足す理由、規則10）。
//
// **掴んでいる間は host に書かない。** 落とした1回だけ書く——動かしている
// 途中の順番は「まだ決まっていない」ので、記録に残す意味が無い。
//
// 並べ替えの口は**この1つ**（規則3）。Project の一覧（開いたサイドバー・
// 畳んだレール）と Fork の一覧が、同じ振る舞いをする。
//
// **グループのあるサイドバーは「落とす先」で考える**（追加・2026-10-16、v4-frontend.md §6.43）——行の上＝その前、
// グループの見出し＝その最後、「Project」の見出し＝グループの外。並びを入れ替えて見せる（sortable）のではなく、
// 落とす先に線を引く・見出しを塗る（`DropList`・`DraggableRow`・`useDropZone`）。掴み方・書くのは落とした1回だけ、
// は上と同じ
import { createContext, useContext, useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";
import {
  DndContext,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  closestCenter,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

/** 掴み方は並べ替えと同じ（下の `SortableList` のコメントを見よ） */
function useRowSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
  );
}

export function SortableList({
  ids,
  onReorder,
  children,
}: {
  ids: readonly string[];
  /** 落としたときに1回だけ呼ばれる。渡すのは**並び全体**（1件ずつの番号は持たない） */
  onReorder: (orderedIds: string[]) => void;
  children: ReactNode;
}) {
  // （掴み方は `useRowSensors` と同じ。理由はここに書いてある）
  const sensors = useSensors(
    // **押しただけでは掴まない**——マウスは 8px 動かして初めて掴む
    // （これが無いと、Project を開こうとしただけで動く）。
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    // **指は「距離」で見分けられない**——一覧を縦にスクロールする動きと
    // 並べ替えの動きが同じ形になる。指だけは「長く押してから」で見分ける
    // （dnd-kit の定石。1つのセンサーで両方をまかなうと、どちらかが壊れる）
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    // キーボードでの並べ替えは付けない——代わりに右クリック（長押し）の
    // メニューに「上へ／下へ」を置いた（`sidebar-item-menu.tsx`）。dnd-kit の
    // KeyboardSensor は掴む対象に `role="button"` 等を付ける必要があり、
    // 行が Link のここでは意味が壊れる
  );
  const id = useId();

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(arrayMove([...ids], from, to));
  }

  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis, restrictToParentElement]}
      // **運んでいる間に高さが変わるので、測り直す**（実測・2026-09-11、ユーザー報告）。
      // 子（Thread の目次）を開いている Project は背が高く、掴んだ瞬間に目次を
      // 畳むので、掴む前に測った大きさのままだと行き先の計算が合わない
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={[...ids]} strategy={verticalListSortingStrategy}>
        {children}
      </SortableContext>
    </DndContext>
  );
}

/**
 * 一覧の1件。**掴む取っ手は別に出さない**——行そのものを掴む。
 * 取っ手を出すと、畳んだレール（58px）には置く場所が無い。
 */
export function SortableRow({
  id,
  as: Tag = "div",
  children,
  className,
}: {
  id: string;
  /** 置かれる場所に合わせる（一覧の中なら `"li"`）——`div` を `ul` に入れない */
  as?: "div" | "li";
  /** 掴むための props（`{...handle}`）を受け取って、掴ませたい要素に付ける。
   *  **行全体ではなく「その行の見出し」に付ける**——入れ子の一覧（Project の中の
   *  Fork）があるので、親の取っ手が子の行まで覆うと掴み合いになる */
  children: (handle: Record<string, unknown>, isDragging: boolean) => ReactNode;
  className?: string;
}) {
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });

  // **運び終わりのクリックを、行き先として扱わない**（実測・2026-09-11）。
  // 行そのものが Link なので、掴んで落とした直後の `click` がそのまま
  // 「その Project を開く」になり、**並べ替えただけで画面が移っていた**。
  // 掴んだ事実を1回だけ覚えて、その直後のクリックを捨てる。
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);
  function onClickCapture(event: MouseEvent) {
    if (!dragged.current) return;
    dragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <Tag
      ref={setNodeRef}
      // 掴み終わりのクリックは、ここ（捕捉の段）で止める——下の Link に届く前
      onClickCapture={onClickCapture}
      data-sortable-id={id}
      data-dragging={isDragging ? "" : undefined}
      className={className}
      style={{
        // **潰さない**（実測・2026-09-11、ユーザー報告）。`CSS.Transform` は
        // dnd-kit が出す拡大縮小まで反映するので、背の高い行（子を開いた Project）を
        // 掴むと**行き先の高さに合わせて `scaleY(0.33)` が掛かり、中身ごと潰れて**
        // 見えた。運ぶのは位置だけ——大きさは変えない
        transform: CSS.Translate.toString(transform),
        transition,
        // 掴んでいるものは上に重ね、薄くする（どれを動かしているかが見える）
        zIndex: isDragging ? 30 : undefined,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      {children({ ...listeners }, isDragging)}
    </Tag>
  );
}

/** 掴んでいる行の id（落とす先の見た目に使う）。`DropList` の外では null */
const DragStateContext = createContext<{ activeId: string | null }>({ activeId: null });

/**
 * **指の下にある落とす先**。行と行の間（隙間）に指があれば、いちばん近いもの——落とした瞬間に先が無くて
 * 何も起きない、を減らす
 */
const pointerFirst: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : closestCenter(args);
};

/**
 * **落とす先で決める一覧**（追加・2026-10-16、v4-frontend.md §6.43）。`onDrop` は落とした1回だけ、掴んだ行の id と
 * 落とした先の id（`DraggableRow` の `dropId`・`useDropZone` の id）で呼ばれる。先が無い・自分の上なら呼ばない
 */
export function DropList({
  onDrop,
  children,
}: {
  onDrop: (activeId: string, overId: string) => void;
  children: ReactNode;
}) {
  const sensors = useRowSensors();
  const id = useId();
  const [activeId, setActiveId] = useState<string | null>(null);
  return (
    <DndContext
      id={id}
      sensors={sensors}
      collisionDetection={pointerFirst}
      modifiers={[restrictToVerticalAxis]}
      // 掴んだ行は目次を畳むので高さが変わる（`SortableList` と同じ理由）
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={(e) => setActiveId(String(e.active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={(e) => {
        setActiveId(null);
        if (e.over) onDrop(String(e.active.id), String(e.over.id));
      }}
    >
      <DragStateContext.Provider value={{ activeId }}>{children}</DragStateContext.Provider>
    </DndContext>
  );
}

/**
 * `DropList` の中の1行。掴めて、自分の見出し（`children` の第3引数の ref を付けた要素）が落とす先にもなる。
 * 落とす先は**行の見出しだけ**——下にぶら下がる目次の上に落としても、その Project の前にはしない。
 * 指が載っていれば見出しの上に線を引く（`isOver`）
 */
export function DraggableRow({
  id,
  dropId,
  as: Tag = "div",
  children,
  className,
}: {
  id: string;
  /** この行を落とす先として呼ぶ id（掴む id と分ける——見出しの id と混ざらないように） */
  dropId: string;
  as?: "div" | "li";
  children: (
    handle: Record<string, unknown>,
    isDragging: boolean,
    drop: { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean },
  ) => ReactNode;
  className?: string;
}) {
  const { listeners, setNodeRef, transform, isDragging } = useDraggable({ id });
  const { activeId } = useContext(DragStateContext);
  // **掴んでいる行の見出しは落とす先から外す**——見出しは動いている行の中にあり、指の下にいつもあるので、
  // 外さないと自分の上に落としたことになり続ける
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: dropId, disabled: isDragging });
  // 掴み終わりのクリックを行き先として扱わない（`SortableRow` と同じ）
  const dragged = useRef(false);
  useEffect(() => {
    if (isDragging) dragged.current = true;
  }, [isDragging]);
  function onClickCapture(event: MouseEvent) {
    if (!dragged.current) return;
    dragged.current = false;
    event.preventDefault();
    event.stopPropagation();
  }
  return (
    <Tag
      ref={setNodeRef}
      onClickCapture={onClickCapture}
      data-sortable-id={id}
      data-dragging={isDragging ? "" : undefined}
      className={className}
      style={{
        transform: CSS.Translate.toString(transform),
        zIndex: isDragging ? 30 : undefined,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      {children({ ...listeners }, isDragging, { setNodeRef: setDropRef, isOver: isOver && activeId !== null })}
    </Tag>
  );
}

/** 行ではない落とす先（グループの見出し・「Project」の見出し）。`isOver` で塗る */
export function useDropZone(id: string): { setNodeRef: (el: HTMLElement | null) => void; isOver: boolean } {
  const { setNodeRef, isOver } = useDroppable({ id });
  const { activeId } = useContext(DragStateContext);
  return { setNodeRef, isOver: isOver && activeId !== null };
}
