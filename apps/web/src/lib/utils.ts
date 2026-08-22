/**
 * shadcn CLI が `@/lib/utils` を `cn` の置き場として仮定する
 * （既存の `lib/cn.ts` とは別の名前）。二重定義にすると真実が2箇所になる
 * （規則3）ので、既存の実装をそのまま re-export するだけにする
 * （spike, 2026-08-22）。
 */
export { cn } from './cn';
