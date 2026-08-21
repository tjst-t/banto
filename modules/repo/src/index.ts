/**
 * repo モジュール。**ツールインターフェースは core への薄い委譲だけ**（要件 C8a）。
 *
 * この層に条件分岐や整形以上のものが出てきたら、それは core に置くべきもの。
 */

import { defineModule, ok, requiredRoot, type BantoModule } from '@banto/module-kit';
import { z } from 'zod';

import { RepoCore } from './core.js';

export const manifest: BantoModule = {
  id: 'repo',
  description: 'リポジトリの閲覧（log/diff/status/branches）とコミット。push は Vault 経由（Phase 3）',
  // git は shell ほど暴走しやすくはないが、外部プロセスを子として抱える点は同じ。
  // 加えて Phase 3 では ssh-agent の socket（Vault 由来）を扱うようになるので、
  // 早いうちから境界を分けておく（要件 C8b）。
  isolation: 'subprocess',
  mcp: { kind: 'subprocess', command: 'node', args: ['modules/repo/dist/serve.js'] },
  // Repo→Vault の本物の依存（ADR-0001 決定5、要件 D5）。Phase 3 で Vault が
  // ssh-agent の socket を持ち、Repo は秘密鍵に触れず socket のパスだけを受け取って
  // push に使う（要件 D3）。Phase 1 では vault が台帳に無いので push は断る。
  //
  // tools は**相手（vault）の**ツール名で、接続時に tools/list と突き合わせる。
  // usedBy は**自分の**ツール名で、欠けたときに断るものを指す。別の名前空間である。
  optional: [{ module: 'vault', tools: ['get_ssh_agent_socket'], usedBy: ['push'] }],
  /**
   * 作業ツリーと取り込みの役割（要件 C13・決定17）。
   *
   * **Factory はこれを役割で頼む。** 以前は Factory が `RepoCore` を直接握っていて、
   * 「worktree の持ち主は Repo」（決定5）が**言葉の上でだけ**成り立っていた。
   */
  provides: ['repo'],
};

export const repoModule = defineModule({
  manifest,
  createCore: () => new RepoCore(requiredRoot('BANTO_REPO_ROOT')),
  tools: (tool) => [
    tool({
      name: 'log',
      description: 'Show recent commits (hash, author, date, subject), most recent first.',
      input: { maxCount: z.number().int().positive().optional().describe('How many commits to show (default 20)') },
      run: async (core, { maxCount }) => ok(await core.log(maxCount)),
    }),
    tool({
      name: 'status',
      description: 'Show working tree status (porcelain v1) including the current branch.',
      input: {},
      run: async (core) => ok(await core.status()),
    }),
    tool({
      name: 'diff',
      description: 'Show the working tree diff, optionally scoped to one path relative to the repo root.',
      input: { path: z.string().optional().describe('Path relative to the repo root; omit for the whole diff') },
      run: async (core, { path: p }) => ok(await core.diff(p)),
    }),
    tool({
      name: 'branches',
      description: 'List local and remote branches with their latest commit.',
      input: {},
      run: async (core) => ok(await core.branches()),
    }),
    tool({
      name: 'commit',
      description: 'Stage the given paths (relative to the repo root) and commit them with a message.',
      input: {
        message: z.string().describe('Commit message'),
        paths: z.array(z.string()).describe('Paths to stage and commit'),
      },
      run: async (core, { message, paths }) => ok(await core.commit(message, paths)),
    }),
    // ---- 役割 `repo`：作業ツリーと取り込み（要件 B2・B7、決定17）----
    //
    // **どれも何度呼んでも同じ状態に着く。** 耐久ワークフローは再開のたびに同じ段を
    // 呼ぶので、冪等でないと再開できない（要件 B5）。
    tool({
      name: 'add_worktree',
      description:
        'Create (or reuse) a branch and a working tree for it. Idempotent: returns the same path if it already exists.',
      input: {
        branch: z.string().describe('Branch name'),
        path: z.string().describe('Working tree path, relative to the repo root'),
      },
      run: async (core, { branch, path: p }) => ok(await core.addWorktree(branch, p)),
    }),
    tool({
      name: 'has_worktree',
      description: 'Report whether a working tree exists at that path: "yes" or "no".',
      input: { path: z.string().describe('Working tree path, relative to the repo root') },
      run: async (core, { path: p }) => ok((await core.hasWorktree(p)) ? 'yes' : 'no'),
    }),
    tool({
      name: 'remove_worktree',
      description: 'Remove a working tree. Does nothing if it is not there.',
      input: { path: z.string().describe('Working tree path, relative to the repo root') },
      run: async (core, { path: p }) => ok(await core.removeWorktree(p)),
    }),
    tool({
      name: 'head_of',
      description: 'Return the commit sha a ref points at.',
      input: { ref: z.string().describe('Branch name or any git ref') },
      run: async (core, { ref }) => ok(await core.headOf(ref)),
    }),
    tool({
      name: 'is_ahead',
      description: 'Report whether a branch has commits the base does not: "yes" or "no".',
      input: {
        branch: z.string().describe('Branch to check'),
        base: z.string().optional().describe('Base branch (default "main")'),
      },
      run: async (core, { branch, base }) => ok((await core.isAhead(branch, base)) ? 'yes' : 'no'),
    }),
    tool({
      name: 'merge',
      description:
        'Merge a branch into the target branch with --no-ff. Conflicts abort the merge and are reported as an error — nothing is auto-resolved.',
      input: {
        branch: z.string().describe('Branch to merge'),
        into: z.string().optional().describe('Target branch (default "main")'),
      },
      run: async (core, { branch, into }) => ok(await core.merge(branch, into)),
    }),
    tool({
      name: 'rebase_onto',
      description:
        'Replay a working tree’s branch on top of another branch. Conflicts abort the rebase and are reported as an error.',
      input: {
        path: z.string().describe('Working tree path, relative to the repo root'),
        onto: z.string().optional().describe('Branch to rebase onto (default "main")'),
      },
      run: async (core, { path: p, onto }) => ok(await core.rebaseOnto(p, onto)),
    }),
    tool({
      name: 'push',
      description:
        'git push. Needs an ssh-agent socket from the vault module — not available until Phase 3, ' +
        'so this declines until vault is wired in.',
      input: {
        remote: z.string().describe('Remote name, e.g. "origin"'),
        branch: z.string().describe('Branch to push'),
      },
      run: async (core, { remote, branch }) => ok(await core.push(remote, branch)),
    }),
  ],
});

export { RepoCore } from './core.js';
export type { GitOutput } from './core.js';
