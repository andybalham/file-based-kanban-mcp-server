// Per-entity detail payload, as if returned by GET /api/:project/entity/:id.
// Keyed by entity id (ids are unique within a project here).
// Each: { body (Markdown), created, updated, estimate?, tags?, archived? }
// Entities without an entry fall back to a minimal generated body.

window.ENTITY_META = {
  // --- rich task: deps, blockers, estimate, full body ---
  "T-103": {
    created: "2026-04-09",
    updated: "2026-05-29",
    estimate: "3 pts",
    tags: ["frontend", "auth", "forms"],
    body: `## Description

Build the **login form** component and wire it to the auth API client. Handles
email + password entry, inline validation, and the loading / error states
returned by \`POST /sessions\`.

Currently blocked: the form depends on the session token contract still being
finalized in the tokenizer work, and on the Stripe-gated account check.

## Acceptance criteria

- [x] Email + password fields with labels and accessible error messaging
- [x] Client-side validation (required, email format)
- [ ] Submit calls the auth API client and handles 401 / 429
- [ ] "Remember me" persists the session per T-104
- [ ] Loading state disables submit and shows a spinner
- [ ] Error banner renders the server message verbatim

## Notes

> Design spec in Figma frame *Auth / Login v3*. Match the marketing site's
> field styling, not the legacy admin theme.

See \`src/features/auth/LoginForm.tsx\` for the scaffold.`,
  },

  // --- epic: rollup only, no deps/blocks, overview body ---
  "E-001": {
    created: "2026-03-30",
    updated: "2026-05-30",
    tags: ["q2-goal"],
    body: `## Overview

Everything required for a user to create an account, sign in, and stay signed
in across sessions and devices. Spans first-party email/password, OAuth
providers, and password recovery.

## Scope

- First-party email + password with secure session handling
- OAuth providers (Google, GitHub, Apple)
- Password reset via emailed token
- "Remember me" / persistent sessions

## Out of scope

- Enterprise SSO / SCIM provisioning (tracked separately)
- Multi-factor authentication (next quarter)`,
  },

  "T-141": {
    created: "2026-04-15",
    updated: "2026-05-28",
    estimate: "5 pts",
    tags: ["auth", "oauth", "backend"],
    body: `## Description

Implement the **GitHub OAuth** provider end to end: authorization redirect,
callback handling, token exchange, and account linking.

Several downstream items are waiting on this provider to land.

## Acceptance criteria

- [x] Register OAuth app + store client secret in the vault
- [x] Authorization redirect with \`state\` + PKCE
- [ ] Callback exchanges code for token
- [ ] Link to existing account by verified email`,
  },

  "S-014": {
    created: "2026-04-02",
    updated: "2026-05-29",
    tags: ["auth"],
    body: `## Login flow

Covers the primary email + password sign-in path, from rendering the form to
establishing a persisted session.

Tasks here move roughly in dependency order — the session model first, then the
API client, then the form on top.`,
  },

  // --- minimal body ---
  "T-205": {
    created: "2026-05-12",
    updated: "2026-05-12",
    estimate: "1 pt",
    body: `Define deterministic tie-breaking rules for equal relevance scores (stable by document id).`,
  },

  // --- archived entity ---
  "T-149": {
    created: "2025-11-03",
    updated: "2026-02-18",
    tags: ["oauth", "deprecated"],
    archived: true,
    body: `## Description

Twitter / X OAuth provider.

> **Archived.** Dropped after the X API pricing change in early 2026. Kept for
> historical reference; do not pick up. Superseded by the Google and GitHub
> providers.`,
  },

  "T-160": {
    created: "2026-04-20",
    updated: "2026-05-30",
    estimate: "8 pts",
    tags: ["billing", "stripe"],
    body: `## Description

Integrate Stripe for checkout: payment intents, webhooks, and the customer
portal handoff.

## Acceptance criteria

- [x] Stripe SDK + keys wired per environment
- [ ] Create payment intent on checkout
- [ ] Handle \`payment_intent.succeeded\` webhook
- [ ] Reconcile subscription state`,
  },

  "T-190": {
    created: "2026-04-25",
    updated: "2026-05-27",
    estimate: "5 pts",
    tags: ["search", "parsing"],
    body: `## Description

Query tokenizer: normalize, fold case, strip punctuation, and emit tokens for
the parser. Foundation for synonym expansion and fuzzy matching.

## Acceptance criteria

- [x] Unicode normalization (NFC)
- [ ] Configurable stopword list
- [ ] Emit position spans for highlighting`,
  },
};
