# Streetlight reliability implementation plan

**Goal:** Resolve the privacy, public intake, configuration, maintainability, and coordinate-quality issues found in the project review without changing work-order or inventory accounting contracts.

**Architecture:** Keep the existing static PWA and Firebase architecture. Extract privacy policy and commands into an independently tested module, require the existing App Check and rate-limited gateway for public submissions, and keep local development separate from hosted Firebase configuration. Move executable application code out of HTML while retaining the compatibility boundary used by existing field workflows.

**Tech stack:** Classic browser JavaScript, IndexedDB, Firestore rules, Firebase Functions (Node 22), Node 24 regression tests, Playwright.

1. Privacy: reproduce missing original reports and per-record expiry with regression tests; implement expiry-aware cleanup for both collections, recheck eligibility at execution, preserve legacy queued jobs and account ownership.
2. Intake and configuration: test rejection of direct intake, close public Firestore creation, retain gateway retries/receipts and staff import, default local development to demo mode, remove placeholder contact details, document the required gateway deployment.
3. Source organization: extract staff/resident scripts and styles from HTML, provide a shared source reader for tests, keep script ordering and service-worker release assets synchronized, validate the complete combined global scope.
4. Position quality: test quality summaries and approximate-position exclusions, surface the count and limitations in relevant workflows, preserve source coordinates and facility IDs.
5. Verification: run app regressions, Functions tests, isolated Firestore emulator tests when available, and local browser workflows. Review the final diff and report local evidence separately from production deployment.

**Design decisions:** Hosted staff Firebase settings remain explicit. Public intake fails closed until a gateway URL and App Check are configured; changing client configuration alone must not reopen anonymous database writes. Source coordinates are never guessed or replaced with invented precision. Production deployment is outside this local implementation.

**Progress:** Implementation and verification complete. See `../verification-2026-11-07.md`. Review follow-ups also cover unsupported storage adapters, empty plans, navigation changes while the chooser is open, and delayed Firebase snapshots without losing saved visits or work links. Production deployment remains a separate operational task.
