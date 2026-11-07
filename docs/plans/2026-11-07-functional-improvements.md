# Functional Improvements Implementation Plan

> Execute in the current shared checkout, preserving the existing uncommitted reliability work. User approved the functional review and its six proposed additions by requesting implementation. No deployment or operational configuration changes.

**Goal:** Correct F-01 through F-06 in the functional review and implement all six proposed workflow improvements.

**Architecture:** Keep existing classic-script modules, revision-checked commands, atomic stock verification and offline outbox. Reuse work `parts` as planned materials before completion and actual recorded usage after completion; forecasts do not reserve or deduct stock. Keep immutable completed history and conflict recovery. Patrol observations do not constitute a full formal inspection.

**Tech Stack:** Vanilla JS/CSS, Node test runner, local IndexedDB, optional Firebase, Playwright/Chromium local fixtures.

## 1. Shared command contracts and forecast
- Modify `app/operations-core.js`, `app/work-commands.js`, `firestore.rules` and add `scripts/tests/functional-commands.test.cjs`.
- First test metadata updates retain work status, report/evidence/cost-accounting identity; reject stale revision, invalid values and unauthorized writers. Stock metadata retains quantity/unit/history. Retries use immutable command fingerprints.
- Add `update` work command, `inventory-update` command and stock forecast using net unconsumed parts in active work. Preserve zero stock mutation until verification.
- Check quantity sum bounds. Add relevant emulator cases for supported update transactions.

## 2. Work UI and linked-report recovery
- Modify `app/operations.js`, `app/workflows.js`, `app/operations.css`; add focused regression/browser scenarios.
- Metadata editing includes title, description, type, priority, assignee, deadline and planned materials, with draft retention and revision conflicts.
- Add explicit multi-selection and per-work queued update results for assignee/deadline/priority. Failed selections remain reviewable; no hidden all-results selection.
- Fix F-05 by routing already-linked reports to the existing active work and retaining editable input on concurrent-link rejection.

## 3. Inventory UI and shortage forecast
- Modify `app/management.js`; add focused regression/browser scenarios.
- Add name/base price edits via `inventory-update`; unit and quantity remain associated with existing history.
- Show currently available, net planned and projected shortage per item across all active orders, with complete-source/error indicators and refresh. Do not infer all-work demand from one paged work list.

## 4. Patrol and reports
- Modify `app/staff-app.js`, `app/integration.js`; add focused regression/browser scenarios.
- Reproduce F-01..F-04 and F-06 first, then preserve overall fault/reinspection state on lamp-only observation; bind GPS fix values and age; persist undo order; use eligible progress denominator; reject reversed/invalid report dates and include the whole end day.
- Add estimated-position queue using existing coordinate correction, with dong/circuit filtering and progress.
- Connect saved visit-plan targets to patrol, retain target snapshots in drafts/records, show unconfirmed targets at finish and offer next-patrol carryover without silently changing visit completion.

## 5. Integration and validation
- Run targeted red/green commands per domain, then `node scripts/check.mjs`, relevant local browser suites, Firebase rules emulator where source rules change, and whitespace/source asset checks.
- Update cache version only after code converges; include all new runtime assets. Keep `firebase-config.js` and `report/config.js` unchanged.
- Update user-facing usage and verification documentation with implemented scope and actual test results. Do not overwrite historical release ZIPs or deploy.

## Completion
All five implementation groups are complete. See [implementation and verification](../functional-implementation-2026-11-07.md): 393 root regression tests, 37 browser scripts, 46 authorization tests, 7 server scenarios, 8 restore scenarios, and 9 Functions unit tests passed. Follow-up review also covered cross-account cleanup, patrol commit-time freshness, explicit stale-edit recovery, draft discard, and actionable bulk assignment. No production configuration changes, commit, push, deployment, or replacement of historical release artifacts was performed.
