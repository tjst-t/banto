import { describe, expect, it } from 'vitest';

import { parseDeclaration } from './declaration.js';

describe('リポジトリの宣言（仕様 §6）', () => {
  it('テストの走らせ方を読む', () => {
    const d = parseDeclaration('{"test": {"command": "npm", "args": ["test"]}}');
    expect(d.test).toEqual({ command: 'npm', args: ['test'] });
  });

  // 省いたのと空なのは同じ意味。**2つの形を残すと、いつか食い違う**（規則3）。
  it('args は省ける', () => {
    expect(parseDeclaration('{"test": {"command": "make"}}').test.args).toEqual([]);
  });

  // 黙って既定を当てると、テストの無いリポジトリで「0件が通った」になる（規則2）。
  it.each([
    ['{', 'JSON として読めない'],
    ['{}', 'test が無い'],
    ['{"test": {}}', 'test.command が文字列でない'],
    ['{"test": {"command": ""}}', 'test.command が文字列でない'],
    ['{"test": {"command": "npm", "args": "test"}}', 'test.args が文字列の配列でない'],
    ['{"test": {"command": "npm", "args": [1]}}', 'test.args が文字列の配列でない'],
  ])('壊れていたら止まる: %s', (raw, reason) => {
    expect(() => parseDeclaration(raw)).toThrow(reason);
  });
});
