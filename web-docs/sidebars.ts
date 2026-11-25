import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const sidebars: SidebarsConfig = {
  docsSidebar: [
    'intro',
    {
      type: 'category',
      label: 'Getting started',
      collapsed: false,
      items: [
        'getting-started/installation',
        'getting-started/quick-start',
        'getting-started/concepts',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsed: false,
      items: [
        'guides/tickets',
        'guides/board',
        'guides/ai-assistant',
        'guides/agents-and-skills',
        'guides/generate',
        'guides/design-documents',
        'guides/environments',
        'guides/compose-contract',
        'guides/run-tests',
        'guides/code-quality',
        'guides/implement',
        'guides/mcp-server',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      collapsed: false,
      items: [
        'reference/settings',
        'reference/commands',
        'reference/on-disk-format',
        'reference/troubleshooting',
      ],
    },
  ],
};

export default sidebars;
