import type { BadgeTone } from '../components/ui/badge';

/**
 * Factory の段（`packages/factory/src/stage.ts` の `STAGES`/`Outcome`）を
 * 人向けの日本語と札の色に直す。**段そのものの判定はここでは持たない**
 * ——host（`modules/factory`）が`nextStage`で決めたものをそのまま受け取るだけ（規則3）。
 */
const STAGE_LABELS: Record<string, string> = {
  worktree: '作業ツリーを用意',
  environment: '環境を用意',
  implement: '実装中',
  test: 'テスト中',
  review: '判断待ち',
  merge: '取り込み中',
  teardown: '後片付け',
  done: '完了',
  failed: '失敗',
  rejected: '却下',
};

const STAGE_TONES: Record<string, BadgeTone> = {
  worktree: 'accent',
  environment: 'accent',
  implement: 'accent',
  test: 'accent',
  review: 'attention',
  merge: 'accent',
  teardown: 'accent',
  done: 'done',
  failed: 'stopped',
  rejected: 'caution',
};

export function stageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

export function stageTone(stage: string): BadgeTone {
  return STAGE_TONES[stage] ?? 'neutral';
}
