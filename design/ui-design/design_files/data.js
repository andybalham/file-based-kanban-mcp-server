// Mock backend data for the read-only project board.
// Shapes mirror the described API:
//   GET /api/projects          -> [{ projectId, title, root }]
//   GET /api/:project/board    -> { epics: [ { id, title, children:[stories] } ] }
// Tasks carry a STORED status + deps. Stories/Epics have NO stored status;
// their badge is a computed rollup (see logic.js).

window.PROJECTS = [
  { projectId: "acme-web", title: "Acme Web App", root: "~/code/acme-web" },
  { projectId: "mobile", title: "Mobile Client", root: "~/code/mobile-client" },
  { projectId: "internal", title: "Internal Tools", root: "~/work/internal-tools" },
];

// Helper to keep the data terse: t(id, title, status, deps?)
function t(id, title, status, deps) {
  return { kind: "task", id, title, status, deps: deps || [] };
}
function s(id, title, children) {
  return { kind: "story", id, title, children };
}
function e(id, title, children) {
  return { kind: "epic", id, title, children };
}

window.BOARDS = {
  // ---- Rich project: deep nesting, mixed children, a task blocked by 3 ----
  "acme-web": {
    epics: [
      e("E-001", "User authentication", [
        s("S-014", "Login flow", [
          t("T-101", "Session model", "done"),
          t("T-102", "Auth API client", "done"),
          // blocked by THREE different tasks
          t("T-103", "Login form", "blocked", ["T-141", "T-160", "T-190"]),
          t("T-104", '"Remember me" persistence', "todo", ["T-101"]), // ready
        ]),
        s("S-020", "Password reset", [
          t("T-130", "Reset token model", "todo"), // ready
          t("T-131", "Reset email template", "todo", ["T-130"]), // not ready
        ]),
        // story with truly mixed children: done + in-progress + blocked + todo
        s("S-021", "OAuth providers", [
          t("T-140", "Google OAuth", "done"),
          t("T-141", "GitHub OAuth", "in-progress"),
          t("T-142", "Apple OAuth", "blocked", ["T-141"]),
          t("T-143", "SSO config", "todo", ["T-140", "T-141", "T-103"]), // not ready; makes T-103 a blocker
          // archived entity, still surfaced in the tree but de-emphasized
          { kind: "task", id: "T-149", title: "Twitter (X) OAuth", status: "todo", deps: [], archived: true },
        ]),
      ]),
      e("E-002", "Billing & subscriptions", [
        s("S-030", "Checkout", [
          t("T-160", "Stripe integration", "in-progress"),
          t("T-161", "Cart summary", "done"),
        ]),
        s("S-031", "Invoices", [
          t("T-170", "Invoice PDF export", "todo"), // ready
        ]),
      ]),
      // deeply nested epic with several stories and many tasks
      e("E-003", "Search & discovery", [
        s("S-040", "Indexing pipeline", [
          t("T-180", "Document crawler", "done"),
          t("T-181", "Index writer", "done"),
          t("T-182", "Incremental sync", "done"),
        ]),
        s("S-041", "Query parsing", [
          t("T-190", "Tokenizer", "in-progress"),
          t("T-191", "Synonym expansion", "todo", ["T-190"]), // not ready
          t("T-192", "Fuzzy matching", "blocked", ["T-190"]),
        ]),
        s("S-042", "Ranking", [
          t("T-200", "BM25 scorer", "todo"), // ready
          t("T-201", "Learn-to-rank model", "todo", ["T-200"]), // not ready
          t("T-202", "Personalization signals", "in-progress"),
          t("T-203", "Freshness boost", "done"),
          t("T-204", "A/B harness", "blocked", ["T-202"]),
          t("T-205", "Tie-breaking rules", "todo"), // ready
        ]),
        s("S-043", "Filters UI", [
          t("T-210", "Facet sidebar", "done"),
          t("T-211", "Range sliders", "done"),
        ]),
        s("S-044", "Search analytics", [
          t("T-220", "Query logging", "todo"), // ready
          t("T-221", "Zero-result report", "todo"), // ready
        ]),
      ]),
      // fully complete epic -> rolls up to done
      e("E-004", "Onboarding", [
        s("S-050", "Welcome tour", [
          t("T-230", "Tour framework", "done"),
          t("T-231", "Step content", "done"),
        ]),
      ]),
    ],
  },

  // ---- Smaller project ----
  "mobile": {
    epics: [
      e("E-001", "Push notifications", [
        s("S-001", "APNs setup", [
          t("T-001", "Certificates & keys", "done"),
          t("T-002", "Device token registration", "in-progress"),
        ]),
        s("S-002", "Notification center", [
          t("T-003", "Inbox screen", "todo"), // ready
          t("T-004", "Mark-as-read sync", "blocked", ["T-002"]),
        ]),
      ]),
      e("E-002", "Offline mode", [
        s("S-010", "Local cache", [
          t("T-020", "SQLite schema", "todo"), // ready
        ]),
      ]),
    ],
  },

  // ---- Empty project (no entities yet) ----
  "internal": { epics: [] },
};
