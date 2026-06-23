import { defineConfig } from 'vitepress';

export default defineConfig({
  title: 'Percussionist',
  description: 'Kubernetes-native orchestration for OpenCode AI agents',
  lang: 'en-US',
  cleanUrls: true,
  ignoreDeadLinks: true,
  srcExclude: ['testing-strategy.md', 'task-lifetime.md'],

  head: [
    ['link', { rel: 'icon', href: '/favicon.svg', type: 'image/svg+xml' }],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://cdn.jsdelivr.net/npm/@fontsource/geist-sans@5/index.css',
      },
    ],
    [
      'link',
      {
        rel: 'stylesheet',
        href: 'https://cdn.jsdelivr.net/npm/@fontsource/jetbrains-mono@5/index.css',
      },
    ],
  ],

  themeConfig: {
    logo: '/favicon.svg',
    siteTitle: false,

    nav: [
      { text: 'Guide', link: '/guide/getting-started' },
      { text: 'Features', link: '/features/git-workspace' },
      { text: 'Dashboard', link: '/dashboard' },
      { text: 'Reference', link: '/reference/cli' },
      { text: 'Architecture', link: '/architecture' },
      { text: 'Security', link: '/security' },
    ],

    sidebar: {
      '/dashboard': [
        {
          text: 'Dashboard',
          items: [{ text: 'Overview', link: '/dashboard' }],
        },
      ],
      '/guide/': [
        {
          text: 'Guide',
          items: [
            { text: 'Getting Started', link: '/guide/getting-started' },
            { text: 'Installation', link: '/guide/installation' },
            { text: 'Configuration', link: '/guide/configuration' },
          ],
        },
      ],
      '/features/': [
        {
          text: 'Features',
          items: [
            { text: 'Git Workspace', link: '/features/git-workspace' },
            { text: 'Code Server', link: '/features/code-server' },
            { text: 'Vector Memory', link: '/features/vector-memory' },
            {
              text: 'Feature Branching',
              link: '/features/feature-branching',
            },
            {
              text: 'Runner Packages',
              link: '/features/runner-packages',
            },
          ],
        },
      ],
      '/reference/': [
        {
          text: 'Reference',
          items: [
            { text: 'CLI (beatctl)', link: '/reference/cli' },
            { text: 'MCP Tools', link: '/reference/mcp-tools' },
            {
              text: 'Task Lifecycle',
              link: '/reference/task-lifecycle',
            },
            { text: 'CRDs', link: '/reference/crds' },
          ],
        },
      ],
    },

    socialLinks: [
      {
        icon: 'github',
        link: 'https://github.com/erkkaha/percussionist',
      },
    ],

    footer: {
      message: 'Build with AI copium',
    },

    search: {
      provider: 'local',
    },
  },
});
