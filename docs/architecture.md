# Application boundaries

The project remains a static PWA. `index.html` contains the staff page structure; `app/staff-app.js` is its compatibility entry point and `app/staff.css` contains the original staff and Leaflet styles. `report/index.html`, `report/report.js`, and `report/report.css` form the independent resident page. HTML does not embed the large application programs.

Feature modules expose a single named interface. `DGOperationsCore` owns pure work-order, inventory, registry-quality and visit-order calculations. `DGPrivacy` owns reporter-retention policy and cleanup commands; the management screen supplies the active account and storage adapter. `DGData` supplies storage and full-query semantics. `DGOffline` owns account-scoped drafts and queued commands. `app/legacy-bridge.js` adapts the existing field views to these interfaces.

The compatibility entry point still uses classic scripts and shared UI state. Moving it to external assets does not make it an ES-module application. New business rules belong in independently tested modules instead of adding globals to the entry point. `scripts/check.mjs` parses every deployed local script and their combined page scope, detects duplicate top-level names, checks public assets, and runs the regression suite. Source-level tests use `scripts/tests/source.cjs` to read entry code after extraction.

## Configuration and public intake

Localhost and loopback hosts use device demo storage. Hosted staff pages use the explicit public Firebase web configuration; Functions administration is enabled separately. An initialization failure never falls back to another shared/local account.

Residents can submit through the App Check and rate-limited Functions gateway or prepare a message for a configured external contact. Public Firestore creation is denied even when an old client requests direct filing. Until gateway URL, App Check, allowed origins and server secret are deployed, the page reports that intake is not ready and never manufactures a successful receipt. Existing original reports remain available to authorized staff for import and cleanup.

Deploy the gateway, secret, App Check and allowed origins, then the Firestore rules and resident configuration as one operational rollout. Old direct-intake clients stop accepting reports when the closed rules are deployed. This source change does not deploy any of those resources.

## Retention and coordinate quality

Manual cleanup includes original `citizen_reports` and imported `reports`. It uses the earlier of each record's explicit expiry and the current retention policy, with creation-time fallback for legacy records. Confirmation fixes the cutoff time and selected identities. Execution rechecks the record in a Firestore transaction or local conditional commit and preserves the original administrator binding. Previously queued jobs retain their original report IDs and cutoff semantics. Adapters without conditional writes cannot start cleanup; the screen explains the supported Firebase/device storage choices before confirmation or queueing.

Approximate distribution-box coordinates remain in the source registry with their flags. They are excluded from visit optimization and the brightness model, listed as requiring position verification, and identified before opening an individual navigation link. Stored visit plans are reconciled with current registry coordinates on restore and before navigation; visits and original order are preserved, and locations changed while choosing a map cannot open a stale route. During delayed Firebase snapshots, `pendingPositions` retains complete stop snapshots and `positionOrder` retains their placement; current records can restore those stops without losing visits or work links. An empty excluded-only plan is shown as requiring coordinate verification. Verified coordinate edits can clear the approximation flag through the existing audited edit workflow. No real-world coordinate is invented.

## Release assets

`sw.js` precaches both entry scripts/styles and all feature dependencies, including `app/privacy.js`. Its version must match `APP_VER` in `app/staff-app.js`. Pages publishes the existing allowlisted directories, so new assets inside `app/` and `report/` are included. Preserve the existing update confirmation, unsent-work checks, focus return and history-stack contracts when changing the compatibility entry point.
