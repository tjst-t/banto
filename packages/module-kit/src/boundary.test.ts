import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { resolveInside } from './boundary.js';

describe('resolveInside', () => {
  const root = '/tmp/banto-boundary-test-root';

  it('root の内側の相対パスは解決できる', () => {
    expect(resolveInside(root, 'a/b.txt')).toBe(path.resolve(root, 'a/b.txt'));
  });

  it('.. で root の外に出ようとすると投げる', () => {
    expect(() => resolveInside(root, '../outside.txt')).toThrow('許された範囲の外');
  });

  it('絶対パスで root の外を指しても投げる', () => {
    expect(() => resolveInside(root, '/etc/passwd')).toThrow('許された範囲の外');
  });

  it('root 自身は許される', () => {
    expect(resolveInside(root, '.')).toBe(path.resolve(root));
  });
});
