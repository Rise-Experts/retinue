import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Retinue",
  tagline: "A reusable, provider-neutral AI agent platform",
  url: "https://docs.agentkit.riseexperts.de",
  baseUrl: "/",
  organizationName: "Rise-Experts",
  projectName: "retinue",
  onBrokenLinks: "warn",
  onBrokenMarkdownLinks: "warn",

  // Parse .md as CommonMark (not MDX) so spec/API syntax like `{tenantId}` and `<T>` is literal.
  markdown: { format: "md", mermaid: true },
  themes: [
    "@docusaurus/theme-mermaid",
    // Offline full-text search — no external service.
    [
      "@easyops-cn/docusaurus-search-local",
      { hashed: true, indexBlog: false, docsRouteBasePath: ["/docs", "/specifications", "/api"] },
    ],
  ],

  i18n: { defaultLocale: "en", locales: ["en"] },

  plugins: [
    // Internal specifications (the design docs), kept as a secondary section.
    [
      "@docusaurus/plugin-content-docs",
      {
        id: "specs",
        path: "../docs",
        routeBasePath: "specifications",
        sidebarPath: "./sidebars-specs.ts",
      },
    ],
    // TypeDoc-generated API reference.
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
        // The primary, hand-written developer documentation.
        docs: {
          path: "content",
          routeBasePath: "docs",
          sidebarPath: "./sidebars.ts",
          editUrl: "https://github.com/Rise-Experts/retinue/tree/main/website/content/",
        },
        blog: false,
        theme: { customCss: "./src/css/custom.css" },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: true,
      disableSwitch: false,
    },
    navbar: {
      title: "Retinue",
      items: [
        { type: "docSidebar", sidebarId: "docs", position: "left", label: "Docs" },
        { to: "/api/", label: "API", position: "left" },
        { to: "/specifications/", label: "Specs", position: "left" },
        { href: "https://github.com/Rise-Experts/retinue", label: "GitHub", position: "right" },
      ],
    },
    footer: {
      style: "dark",
      links: [
        {
          title: "Docs",
          items: [
            { label: "Overview", to: "/docs/overview" },
            { label: "Getting Started", to: "/docs/getting-started/installation" },
            { label: "API Reference", to: "/api/" },
          ],
        },
        {
          title: "More",
          items: [
            { label: "Specifications", to: "/specifications/" },
            { label: "GitHub", href: "https://github.com/Rise-Experts/retinue" },
          ],
        },
      ],
      copyright: "© Rise Experts — Retinue",
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
