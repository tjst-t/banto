// @ts-check
// banto の公開サイト（ランディングページ＋マニュアル）。置き場は Cloudflare Pages、名前は banto.tjst-t.dev。
// ランディングページは src/pages/index.astro（Starlight の外）、マニュアルは src/content/docs/docs/ の下（/docs/…）。
// 言語は日本語で始め、英語は後から locales に en を足せば /en/… に並ぶ。
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

export default defineConfig({
	site: 'https://banto.tjst-t.dev',
	integrations: [
		starlight({
			title: 'banto',
			description: '複数の AI エージェントに並行して作業を任せても、進捗と確認待ちをひと目で把握できるセルフホスト型のワークスペース。',
			logo: { src: './src/assets/mark.svg', alt: '' },
			defaultLocale: 'root',
			locales: {
				root: { label: '日本語', lang: 'ja' },
			},
			social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/tjst-t/banto' }],
			customCss: ['./src/styles/fonts.css', './src/styles/docs.css'],
			editLink: { baseUrl: 'https://github.com/tjst-t/banto/edit/main/site/' },
			lastUpdated: true,
			sidebar: [
				{
					label: 'はじめに',
					items: [
						{ label: 'banto とは', slug: 'docs' },
						{ label: 'クイックスタート', slug: 'docs/quickstart' },
						{ label: '基本概念', slug: 'docs/concepts' },
						{ label: 'ほかのツールとの比較', slug: 'docs/compare' },
					],
				},
				{
					label: 'インストール',
					items: [
						{ label: 'インストール', slug: 'docs/install' },
						{ label: 'HTTPS の設定', slug: 'docs/install/https' },
						{ label: 'アップデート', slug: 'docs/install/update' },
						{ label: 'トラブルシューティング', slug: 'docs/install/troubleshooting' },
						{ label: 'アンインストール', slug: 'docs/install/uninstall' },
					],
				},
				{
					label: '使い方',
					items: [
						{ label: 'プロジェクト', slug: 'docs/guide/projects' },
						{ label: '会話と Fork', slug: 'docs/guide/threads' },
						{ label: '受信箱と承認', slug: 'docs/guide/inbox' },
						{ label: '自動化', slug: 'docs/guide/automation' },
						{ label: 'スマートフォンで使う', slug: 'docs/guide/mobile' },
						{ label: 'ログインと端末の管理', slug: 'docs/guide/login' },
					],
				},
				{
					label: 'モジュール',
					items: [
						{ label: '概要', slug: 'docs/modules' },
						{ label: 'Shell', slug: 'docs/modules/shell' },
						{ label: 'FileSystem', slug: 'docs/modules/filesystem' },
						{ label: 'Terminal', slug: 'docs/modules/terminal' },
						{ label: 'Browser', slug: 'docs/modules/browser' },
						{ label: 'Subagent', slug: 'docs/modules/subagent' },
						{ label: 'Service と Publish', slug: 'docs/modules/service' },
						{ label: 'Vault', slug: 'docs/modules/vault' },
						{ label: 'Repositories', slug: 'docs/modules/repositories' },
						{ label: 'Backlog', slug: 'docs/modules/backlog' },
						{ label: 'Factory', slug: 'docs/modules/factory' },
					],
				},
				{
					label: '運用',
					items: [
						{ label: 'リソースの管理', slug: 'docs/admin/resources' },
						{ label: '別のサーバーで実行する', slug: 'docs/admin/remote' },
						{ label: 'セキュリティ', slug: 'docs/admin/security' },
					],
				},
				{ label: 'よくある質問', slug: 'docs/faq' },
			],
		}),
	],
});
