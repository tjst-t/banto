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
			description: 'AI と進める仕事をいくつ並べても、いま何が動いていて何があなたを待っているかを1画面に出す作業場。',
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
						{ label: '考え方', slug: 'docs/concepts' },
					],
				},
				{
					label: '入れる',
					items: [
						{ label: '入れる', slug: 'docs/install' },
						{ label: 'HTTPS の2つの形', slug: 'docs/install/https' },
						{ label: '更新する・打ち直す', slug: 'docs/install/update' },
						{ label: '困ったとき', slug: 'docs/install/troubleshooting' },
						{ label: 'アンインストール', slug: 'docs/install/uninstall' },
					],
				},
				{
					label: '使う',
					items: [
						{ label: '会話と Fork', slug: 'docs/guide/threads' },
						{ label: '受信箱と承認', slug: 'docs/guide/inbox' },
						{ label: 'Module', slug: 'docs/guide/modules' },
					],
				},
			],
		}),
	],
});
