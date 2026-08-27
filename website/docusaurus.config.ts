import type { Config } from "@docusaurus/types";
import type * as Preset from "@docusaurus/preset-classic";

const config: Config = {
  title: "Retinue",
  tagline: "A reusable, provider-neutral AI agent platform",
  url: "https://docs.retinue.riseexperts.de",
  baseUrl: "/",
  organizationName: "Rise-Experts",
  projectName: "retinue",
  /**
   * The mark in the browser tab — REQ-049 (#208), task #218.
   *
   * An SVG rather than an `.ico`: every browser that matters has supported it since 2020, it stays sharp on a
   * retina tab strip at any size, and it is 759 bytes. It is *not* the brand mark scaled down — see the comment
   * in the file for why five dots become three at 16px.
   */
  favicon: "img/favicon.svg",
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
    /**
     * The social preview — task #218, AC-3.
     *
     * Without this a shared link renders as a grey rectangle with a URL in it, which is the first impression a
     * link in a Slack channel makes. Committed as a PNG rather than generated at build time, because the only
     * rasteriser on the machine that produced it is macOS-only and a build step that works on one developer's
     * machine is a build step that breaks CI.
     */
    image: "img/og-retinue.png",
    metadata: [
      { name: "twitter:card", content: "summary_large_image" },
      { name: "theme-color", content: "#234b7e" },
    ],
    colorMode: {
      defaultMode: "light",
      respectPrefersColorScheme: true,
      disableSwitch: false,
    },
    navbar: {
      title: "Retinue",
      // The mark, at a size where its open sweep is still legible — see brand/tokens.json's `usage.mark`.
      logo: { alt: "Retinue", src: "img/retinue-mark.svg", width: 28, height: 28 },
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
