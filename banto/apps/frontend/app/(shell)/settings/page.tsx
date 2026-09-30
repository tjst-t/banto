// `/settings` を直接開いたとき（ブックマーク・古い URL）。**設定の面は外枠（AppShell）が重ねて出す**
// （改訂・2026-09-28、`lib/settings-link.ts`）——ここは下に何も描かない。ふだんはいまの画面の上に
// `?settings=1` で開くので、このページは通らない
export default function SettingsPage() {
  return null;
}
