import type { SidebarsConfig } from "@docusaurus/plugin-content-docs";

// The primary developer documentation IA: Learn (getting started + concepts) → Guides →
// Examples → Reference (API lives in its own instance at /api).
const sidebars: SidebarsConfig = {
  docs: [
    "overview",
    {
      type: "category",
      label: "Getting Started",
      collapsed: false,
      items: [
        "getting-started/installation",
        "getting-started/quick-start",
        "getting-started/configuration",
      ],
    },
    {
      type: "category",
      label: "Core Concepts",
      items: [
        "concepts/architecture",
        "concepts/agents",
        "concepts/tools",
        "concepts/memory",
        "concepts/sessions",
        "concepts/durable-runtime",
        "concepts/human-in-the-loop",
        "concepts/retrieval",
        "concepts/frontend",
      ],
    },
    {
      type: "category",
      label: "Guides",
      items: [
        "guides/build-an-agent",
        "guides/persistent-memory",
        "guides/approvals-and-safety",
      ],
    },
    {
      type: "category",
      label: "Examples",
      items: ["examples/simple-agent", "examples/persistent-memory"],
    },
    "troubleshooting",
  ],
};

export default sidebars;
