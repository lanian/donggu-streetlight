# Satellite map implementation plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add the approved ordinary map, satellite/aerial imagery and imagery-with-labels selector while preserving map position, overlays and the current Firebase/report configuration.

**Architecture:** Retain Leaflet and the shared `DongguPWA.tileLayer` entry point. A new map-layer controller manages the background layers and a compact accessible selector on each map. Keep the ordinary provider unchanged; use a separate optional VWorld public API key for online Satellite and Hybrid tiles. No credentials, production activation or deployment are part of this implementation.

**Tech Stack:** Existing classic JavaScript/IIFE modules, Leaflet, Node test runner and local Playwright Chromium.

## Approved design

The user approved the preceding three-mode recommendation by asking to implement it. Switching replaces background tiles without recreating the map or touching facility markers, GPS, routes or editor shapes. A domain-restricted public VWorld key can later be set in `app/map-config.js`; its default remains empty. Missing configuration disables imagery modes with a brief explanation while the ordinary map stays usable. The selected mode is remembered as a local display preference. Hybrid uses imagery plus a transparent label layer. Image failures fall back to the ordinary map, retain map state, and explain the fallback. Satellite tiles are online only and never added to the service-worker tile archive.

## Task 1: Controller and tests

- Create `app/map-layers.js`, `app/map-layers.css` and `scripts/tests/map-layers.test.cjs`.
- First run failing tests for key absence, mode validity, exact layer composition, safe encoded tile URLs, preference persistence, view/overlay retention, current-generation failure fallback and disposal.
- Implement a Leaflet layer-group-compatible controller, forwarding the existing `tileerror` event and emitting `mapmodechange` on effective changes. Expose `getMode()` and `setMode(mode)` on its returned layer.
- Render a compact `지도 배경` select with ordinary/satellite/imagery-with-labels options. Reuse existing colors, type and focus styles, and isolate map gestures.
- Run targeted Node tests and a new real-Leaflet browser script with synthetic image tiles.

## Task 2: Application integration

- Add optional `DONGGU_SATELLITE_CONFIG` to `app/map-config.js` without replacing `DONGGU_MAP_PROVIDER`.
- Write a failing PWA delegation test, then delegate `DongguPWA.tileLayer` to `DongguMapLayers.create(L, ordinaryProvider, extraOptions)` when available.
- Add the runtime script/style to `index.html` and the public service-worker shell.
- Reset the existing main-map error notice on `mapmodechange` so handled imagery failures do not leave a stale background warning.
- Bump the app and service-worker version together to `v62-satellite` and add a release note.
- Keep Firebase/report configuration, stored data, drafts and all prior v61 changes intact.

## Task 3: Verification and handover

- Add `scripts/satellite-map-browser-smoke.cjs` to the browser workflow.
- Test missing-key behavior, all three modes with controlled tiles, saved preference, maps opened in different workflows, mobile/desktop layout, keyboard access, tile failure, removal and late events.
- Run `node scripts/check.mjs`, the browser suite and whitespace checks. No backend/rule changes are planned, so rerun backend gates only if an actual integration concern requires them.
- Independently review lifecycle, event propagation, zoom limits, key exposure and service-worker behavior.
- Document key setup and clearly distinguish synthetic-image browser evidence from live VWorld imagery, which cannot be verified without a valid key.

## Ownership

- Map implementation agent: new controller/style and its Node/browser tests only.
- Root: PWA/config/index/version/service worker/CI/docs and root integration tests.
- Independent reviewers: read-only review; do not alter either implementation's files.

No existing uncommitted v61 files are reset or committed wholesale. Work continues in the current feature checkout because this addition builds on those already authorized changes.
