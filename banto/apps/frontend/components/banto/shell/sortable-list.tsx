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
import { useEffect, useId, useRef, type MouseEvent, type ReactNode } from "react";
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
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
  children: (handle: Record<string, unknown>) => ReactNode;
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
        transform: CSS.Transform.toString(transform),
        transition,
        // 掴んでいるものは上に重ね、薄くする（どれを動かしているかが見える）
        zIndex: isDragging ? 30 : undefined,
        opacity: isDragging ? 0.6 : undefined,
      }}
    >
      {children({ ...listeners })}
    </Tag>
  );
}
