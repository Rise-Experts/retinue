import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "@agentkit",
  tagline: "A reusable, provider-neutral AI agent platform",
  url: "https://agentkit.rise-experts.dev",
  baseUrl: "/",
  organizationName: "Rise-Experts",
  projectName: "agentkit",
  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  // Parse .md as CommonMark (not MDX) so spec syntax like `{tenantId}` and `<T>` is literal.
  markdown: { format: "md", mermaid: true },
  themes: ["@docusaurus/theme-mermaid"],

  i18n: { defaultLocale: "en", locales: ["en"] },

  plugins: [
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "api",
        path: "api",
        routeBasePath: "api",
        sidebarPath: "./sidebars-api.ts",
      },
    ],
  ],

  presets: [
    [
      "classic",
      {
        docs: {
          // The specs and generated API reference live in the repo's docs/ folder.
          path: "../docs",
          routeBasePath: "/",
          sidebarPath: "./sidebars.ts",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    navbar: {
      title: "@agentkit",
      items: [
        { type: "docSidebar", sidebarId: "specs", position: "left", label: "Docs" },
        { to: "/api/", label: "API", position: "left" },
        { href: "https://github.com/Rise-Experts/agentkit", label: "GitHub", position: "right" },
      ],
    },
    footer: { style: "dark", copyright: "© Rise Experts — @agentkit" },
    // AI search (kapa/Inkeep/Algolia AskAI) is wired via env at deploy; see README.
  } satisfies Preset.ThemeConfig,
};

export default config;
