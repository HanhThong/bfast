import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const REPOSITORY = 'https://github.com/HanhThong/bfast';

const config: Config = {
  title: 'BFAST',
  tagline:
    'A ticket tracker that lives in your repository — epics, stories, acceptance criteria and test cases, inside VS Code.',
  favicon: 'img/logo.svg',

  // Future flags, see https://docusaurus.io/docs/api/docusaurus-config#future
  future: {
    v4: true, // Improve compatibility with the upcoming Docusaurus v4
  },

  // Where the site is published, given at build time (the DOCS_URL and DOCS_BASE_URL environment
  // variables, which the Docs workflow sets from the repository's Actions variables). They feed the
  // canonical links and the sitemap; a local build without them works the same.
  url: process.env.DOCS_URL || 'http://localhost:3000',
  baseUrl: process.env.DOCS_BASE_URL || '/',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'BFAST',
      logo: {
        alt: 'BFAST logo',
        src: 'img/logo.svg',
      },
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          to: '/docs/getting-started/quick-start',
          label: 'Quick start',
          position: 'left',
        },
        {
          to: '/docs/reference/settings',
          label: 'Settings reference',
          position: 'left',
        },
        {
          href: REPOSITORY,
          label: 'Source',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Learn',
          items: [
            {label: 'Introduction', to: '/docs/intro'},
            {label: 'Installation', to: '/docs/getting-started/installation'},
            {label: 'Quick start', to: '/docs/getting-started/quick-start'},
          ],
        },
        {
          title: 'Guides',
          items: [
            {label: 'Tickets', to: '/docs/guides/tickets'},
            {label: 'AI assistant', to: '/docs/guides/ai-assistant'},
            {label: 'Environments', to: '/docs/guides/environments'},
            {label: 'MCP server', to: '/docs/guides/mcp-server'},
          ],
        },
        {
          title: 'Reference',
          items: [
            {label: 'Settings', to: '/docs/reference/settings'},
            {label: 'Commands', to: '/docs/reference/commands'},
            {label: 'On-disk format', to: '/docs/reference/on-disk-format'},
            {label: 'Source', href: REPOSITORY},
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} BFAST. Licensed under the <a href="https://www.apache.org/licenses/LICENSE-2.0">Apache License 2.0</a>.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'json', 'yaml', 'powershell', 'toml'],
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
