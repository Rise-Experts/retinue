/**
 * The old runtime's capability surface, extracted from its source — REQ-041 AC-1 (#190).
 *
 * **Generated. Do not edit.** Produced by `scripts/scan-old-runtime-capabilities.mjs --write`, which reads
 * `social_integgration` and refuses rather than reporting a smaller old runtime when it cannot.
 *
 * Committed so the inventory tests run without that repository checked out, and so a change to the old runtime
 * arrives as a **reviewable diff** instead of silently widening the gap the inventory claims to have closed.
 * `npm run scan:old-runtime-capabilities -- --check` fails when this file and the source disagree.
 */

import type { OldRuntimeManifest } from "./manifest.js";

export const OLD_RUNTIME_MANIFEST: OldRuntimeManifest = {
  "repository": "social_integgration",
  "tools": [
    {
      "name": "generate_content",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:52"
    },
    {
      "name": "search_web",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:79"
    },
    {
      "name": "read_url",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:110"
    },
    {
      "name": "read_pdf",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:133"
    },
    {
      "name": "convert_media",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:198"
    },
    {
      "name": "check_conversion",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:246"
    },
    {
      "name": "replace_post_media",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:264"
    },
    {
      "name": "check_media_compatibility",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:290"
    },
    {
      "name": "add_post_media",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:317"
    },
    {
      "name": "remove_post_media",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:340"
    },
    {
      "name": "duplicate_post",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:361"
    },
    {
      "name": "repost_post",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:387"
    },
    {
      "name": "create_artifact",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:413"
    },
    {
      "name": "update_artifact",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:441"
    },
    {
      "name": "get_artifact",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:465"
    },
    {
      "name": "render_diagram",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:482"
    },
    {
      "name": "generate_pdf",
      "confirmationStated": "absent",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:542"
    },
    {
      "name": "get_post_stats",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:620"
    },
    {
      "name": "get_comments",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:644"
    },
    {
      "name": "reply_to_comment",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:679"
    },
    {
      "name": "delete_post",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:703"
    },
    {
      "name": "get_post",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:732"
    },
    {
      "name": "create_draft",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:758"
    },
    {
      "name": "publish_now",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:835"
    },
    {
      "name": "schedule_post",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:845"
    },
    {
      "name": "get_branding",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:864"
    },
    {
      "name": "update_branding",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:881"
    },
    {
      "name": "list_agent_skills",
      "confirmationStated": "false",
      "requiresConfirmation": false,
      "source": "ai_backend/app/assistant/tools.py:927"
    },
    {
      "name": "save_agent_skill",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:941"
    },
    {
      "name": "delete_agent_skill",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:976"
    },
    {
      "name": "set_agent_skill_enabled",
      "confirmationStated": "true",
      "requiresConfirmation": true,
      "source": "ai_backend/app/assistant/tools.py:992"
    }
  ],
  "agents": [
    {
      "id": "chorus-assistant",
      "kind": "generalist",
      "tools": [
        "search_web",
        "read_url",
        "read_pdf",
        "check_media_compatibility",
        "convert_media",
        "check_conversion",
        "generate_pdf",
        "render_diagram",
        "create_artifact",
        "update_artifact",
        "get_artifact",
        "generate_content",
        "create_draft",
        "get_post",
        "get_post_stats",
        "get_comments",
        "reply_to_comment",
        "delete_post",
        "add_post_media",
        "remove_post_media",
        "replace_post_media",
        "duplicate_post",
        "publish_now",
        "schedule_post",
        "repost_post"
      ],
      "source": "ai_backend/app/assistant/agent.py:160"
    },
    {
      "id": "chorus-research",
      "kind": "specialist",
      "tools": [
        "search_web",
        "read_url",
        "read_pdf"
      ],
      "source": "ai_backend/app/assistant/specialists.py:111"
    },
    {
      "id": "chorus-writer",
      "kind": "specialist",
      "tools": [
        "generate_content",
        "create_draft",
        "get_post"
      ],
      "source": "ai_backend/app/assistant/specialists.py:124"
    },
    {
      "id": "chorus-media",
      "kind": "specialist",
      "tools": [
        "check_media_compatibility",
        "convert_media",
        "check_conversion",
        "add_post_media",
        "remove_post_media",
        "replace_post_media"
      ],
      "source": "ai_backend/app/assistant/specialists.py:135"
    },
    {
      "id": "chorus-documents",
      "kind": "specialist",
      "tools": [
        "generate_pdf",
        "render_diagram",
        "create_artifact",
        "update_artifact",
        "get_artifact"
      ],
      "source": "ai_backend/app/assistant/specialists.py:167"
    },
    {
      "id": "chorus-publisher",
      "kind": "specialist",
      "tools": [
        "publish_now",
        "schedule_post",
        "repost_post",
        "duplicate_post",
        "get_post"
      ],
      "source": "ai_backend/app/assistant/specialists.py:194"
    },
    {
      "id": "chorus-community",
      "kind": "specialist",
      "tools": [
        "get_post_stats",
        "get_comments",
        "reply_to_comment",
        "delete_post",
        "get_post"
      ],
      "source": "ai_backend/app/assistant/specialists.py:205"
    },
    {
      "id": "chorus-team",
      "kind": "team",
      "tools": [],
      "source": "ai_backend/app/assistant/specialists.py:240"
    },
    {
      "id": "chorus-studio",
      "kind": "generalist",
      "tools": [
        "generate_pdf",
        "render_diagram",
        "create_artifact",
        "update_artifact",
        "get_artifact",
        "check_media_compatibility",
        "convert_media",
        "check_conversion",
        "search_web",
        "read_url",
        "read_pdf",
        "get_branding",
        "update_branding",
        "list_agent_skills",
        "save_agent_skill",
        "delete_agent_skill",
        "set_agent_skill_enabled"
      ],
      "source": "ai_backend/app/assistant/factory.py:123"
    }
  ],
  "routes": [
    {
      "method": "GET",
      "path": "/health",
      "source": "ai_backend/app/main.py:53"
    },
    {
      "method": "POST",
      "path": "/generate",
      "source": "ai_backend/app/main.py:64"
    },
    {
      "method": "POST",
      "path": "/api/ai/generate",
      "source": "ai_backend/app/main.py:125"
    },
    {
      "method": "POST",
      "path": "/campaign",
      "source": "ai_backend/app/main.py:133"
    },
    {
      "method": "POST",
      "path": "/campaign/suggest",
      "source": "ai_backend/app/main.py:164"
    },
    {
      "method": "POST",
      "path": "/campaign/evaluate",
      "source": "ai_backend/app/main.py:193"
    },
    {
      "method": "POST",
      "path": "/enhance-media-prompt",
      "source": "ai_backend/app/main.py:218"
    },
    {
      "method": "POST",
      "path": "/plan-video-scenes",
      "source": "ai_backend/app/main.py:251"
    },
    {
      "method": "POST",
      "path": "/llm/validate",
      "source": "ai_backend/app/main.py:288"
    },
    {
      "method": "POST",
      "path": "/reply",
      "source": "ai_backend/app/main.py:302"
    },
    {
      "method": "POST",
      "path": "/capture",
      "source": "ai_backend/app/main.py:335"
    },
    {
      "method": "POST",
      "path": "/campaign/agent",
      "source": "ai_backend/app/main.py:361"
    },
    {
      "method": "POST",
      "path": "/repurpose",
      "source": "ai_backend/app/main.py:401"
    },
    {
      "method": "POST",
      "path": "/vision/describe",
      "source": "ai_backend/app/main.py:428"
    },
    {
      "method": "POST",
      "path": "/assistant/session-name",
      "source": "ai_backend/app/main.py:506"
    }
  ],
  "skills": [
    {
      "name": "analytics-reporting",
      "source": "ai_backend/skills/analytics-reporting/SKILL.md"
    },
    {
      "name": "document-generation",
      "source": "ai_backend/skills/document-generation/SKILL.md"
    },
    {
      "name": "mermaid-diagrams",
      "source": "ai_backend/skills/mermaid-diagrams/SKILL.md"
    },
    {
      "name": "platform-media-rules",
      "source": "ai_backend/skills/platform-media-rules/SKILL.md"
    },
    {
      "name": "post-composition",
      "source": "ai_backend/skills/post-composition/SKILL.md"
    },
    {
      "name": "publishing-safety",
      "source": "ai_backend/skills/publishing-safety/SKILL.md"
    },
    {
      "name": "research-and-citation",
      "source": "ai_backend/skills/research-and-citation/SKILL.md"
    }
  ],
  "webhooks": [
    {
      "path": "/api/leads/webhook",
      "methods": [
        "GET",
        "PUT"
      ],
      "source": "web/src/app/api/leads/webhook/route.ts"
    },
    {
      "path": "/api/webhooks/meta/data-deletion",
      "methods": [
        "POST"
      ],
      "source": "web/src/app/api/webhooks/meta/data-deletion/route.ts"
    },
    {
      "path": "/api/webhooks/meta/events",
      "methods": [
        "GET",
        "POST"
      ],
      "source": "web/src/app/api/webhooks/meta/events/route.ts"
    },
    {
      "path": "/api/webhooks/stripe",
      "methods": [
        "POST"
      ],
      "source": "web/src/app/api/webhooks/stripe/route.ts"
    },
    {
      "path": "/api/webhooks/tiktok",
      "methods": [
        "POST"
      ],
      "source": "web/src/app/api/webhooks/tiktok/route.ts"
    }
  ],
  "scheduled": [
    {
      "job": "chorus-schedule-sweep",
      "schedule": "*/5 * * * *",
      "command": "select public.run_schedule_sweep();",
      "source": "supabase/migrations/20260802120000_schedule_sweep_cron.sql:95"
    }
  ]
} as const;
