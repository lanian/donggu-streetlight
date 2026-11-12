# Essential maintenance workflows implementation plan

**Goal:** Implement the eight additions approved in the preceding comparison review, preserving the deployed v60 data and current Firebase/report settings. This implementation turn does not publish a new version.

**Architecture:** Retain revision-checked commands, immutable events and account-bound offline drafts. Extend work metadata without changing the six existing lifecycle statuses: acknowledgement and active hold are explicit attributes; hold never erases deadlines. New topology, incidents, replacement records and preventive plans use separate bounded collections and immutable operation receipts. Physical cabinet/circuit IDs are entered from confirmed records, never inferred from switch type. Add explicit offline work packages with completeness metadata and retained previous complete package on failure. Background delivery needs server configuration; the current build offers an in-app attention list and acknowledgement without claiming closed-app delivery.

## 1. Work lifecycle, attention and recurring maintenance
- Modify `app/operations-core.js`, `app/work-commands.js`, `app/operations.js`, `app/operations.css`.
- Add `app/preventive-core.js`, `app/preventive-commands.js`, `app/preventive.js` if needed for independent preventive plans/occurrences.
- Test acknowledgement authority, reassignment invalidation, structured hold/resume and overdue semantics, diagnosis/action validation and preservation on re-verification.
- Add in-app unacknowledged/overdue attention list, assignee acknowledgement, hold reason/next action/date, and completion cause/action codes.
- Add schedule targets, interval, due occurrence, idempotent work generation and previous unfinished work carryover without duplicate cycle/work IDs. Use bounded atomic transactions and persisted partial progress where a cycle exceeds transaction limits.

## 2. Asset relationships, grouped outages and replacements
- Add `app/asset-maintenance-core.js`, `app/asset-maintenance-commands.js`, `app/asset-maintenance.js`.
- Use confirmed cabinets/circuits and per-light links; validate parent relationships and revision conflicts. Do not treat `light.sw` as a circuit identity.
- Add a parent outage linked to individual facilities/reports/works; keep each work's completion and stock accounting independent.
- Add immutable per-component replacement records with date, manufacturer/model, warranty end and optional matching work reference. Preserve historical component changes and item stock.
- Test wrong-parent/cross-facility references, permissions, duplicates, conflicts and group closure.

## 3. Inspection evidence and departure preparation
- Modify `app/staff-app.js`, `app/integration.js`; add `app/field-kit.js` and a pure validation module if useful.
- Preserve existing inspections. New responses support good/bad/not-inspected/not-applicable, explicit reason and numerical electrical readings with units. Do not silently fill unanswered checks as good; incomplete inspection cannot reset the formal inspection date or clear existing faults.
- Add today's assigned-work package: facilities, work details, reports, recent inspections and required original photos, bounded by count/size. Show complete/missing/time/source and retry. Preserve previous complete package on failure and prevent cross-account publication/deletion.
- Prepared work/photo data must be usable through supported read fallbacks; queue writes retain original targets and existing network requirements. No bulk download of unlicensed map tiles.

## 4. Integration and storage gates
- Root owns `index.html`, `app/legacy-bridge.js`, `app/management.js`, `firestore.rules`, `functions/restore-core.js`, `app/restore.js`, service worker/version and documentation.
- Wire discoverable navigation and all runtime assets into the cached public shell. Replace misleading switch-type circuit aggregation with actual asset links and explicitly label missing circuit data.
- Extend rules, backup collections and restore graph/validators for every persisted field/collection; preserve original attribution and immutable histories. Reject cross-scope and stale writes.
- Keep typed inspection details and measurement validation in separate immutable receipts in the same atomic write as the original inspection/photos/light patch. This preserves the existing inspection payload and six-photo capacity while keeping checks/reasons and ten numerical readings within each Firestore rule evaluation budget. Include both receipts in backup/restore.
- No operational configuration or production deployment changes.

## 5. Verification
- Each domain writes meaningful failing tests first, runs RED, implements and runs GREEN.
- Run all Node regressions; Node22 Functions/restore checks; local rules/server/restore emulators; new browser flows and affected/full browser gate after integration.
- Independently review async ownership, partial generation/package retry and restore support before claiming completion. Record actual results and live-device/background-notification limits.
