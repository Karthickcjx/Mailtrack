# Tracklet documentation

| Folder | Document | What it covers |
|---|---|---|
| **setup/** | [SETUP_GOOGLE_CLOUD.md](setup/SETUP_GOOGLE_CLOUD.md) | Google Cloud project, Gmail API, OAuth consent screen, Chrome Extension OAuth client |
| | [SETUP_CLOUDFLARE.md](setup/SETUP_CLOUDFLARE.md) | Cloudflare account, D1 database, Worker secrets, deployment |
| | [EXTENSION_ID.md](setup/EXTENSION_ID.md) | How the stable extension ID is pinned, and where the private key lives |
| **design/** | [ARCHITECTURE.md](design/ARCHITECTURE.md) | System design, decisions (D1–D12), data flow, privacy model |
| | [API_SPEC.md](design/API_SPEC.md) | Backend HTTP API (`/v1/*`, `/o/*`, `/c/*`) |
| | [DATABASE_SCHEMA.md](design/DATABASE_SCHEMA.md) | D1 (SQLite) tables, indexes, retention |
| | [IMPLEMENTATION_PLAN.md](design/IMPLEMENTATION_PLAN.md) | Phases and milestones |
| | [OPEN_QUESTIONS.md](design/OPEN_QUESTIONS.md) | Decisions log (Q1–Q17) |
| | [VERIFIED_PLATFORM_FACTS.md](design/VERIFIED_PLATFORM_FACTS.md) | Chrome, Gmail and Cloudflare behaviour verified against the official docs |
| | [RECONNAISSANCE.md](design/RECONNAISSANCE.md) | Initial product research (feature map only; no third-party code) |
| **testing/** | [PROTOTYPE_TEST_PLAN.md](testing/PROTOTYPE_TEST_PLAN.md) | Spike test plan P1–P6 (results in [spikes/RESULTS.md](../spikes/RESULTS.md)) |
| **release/** | [SECURITY_REVIEW.md](release/SECURITY_REVIEW.md) | Threat model, controls, findings |
| | [RELEASE_READINESS.md](release/RELEASE_READINESS.md) | Feature status, verification runs, remaining gates |
