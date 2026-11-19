# 지도보기 묶어 보기 켜기·끄기 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 지도보기에 "묶어 보기" 버튼을 둔다. 끄면 모든 시설을 실제 좌표에 점으로 그리고, 겹친 점은 누를 때 목록으로 고르게 한다.

**Architecture:** `app/staff-app.js`의 지도 상태 `GM`에 `cluster` 값을 더한다. `drawMapMarkers()`는 `GM.cluster`가 꺼져 있고 방문 계획 지도가 아니면 화면 안의 모든 시설을 기존 `single()`로 그린다. 누른 자리 근처의 시설이 여러 개면 기존 `showMapGroup()`을 연다. 설정은 `localStorage`에 기억한다.

**Tech Stack:** 순수 JS, Leaflet(Canvas 렌더러), Playwright 브라우저 검사(`scripts/map-view-browser-smoke.cjs`)

**Spec:** `docs/superpowers/specs/2026-11-19-map-cluster-toggle-design.md`

## Global Constraints
- 기본값은 켜짐이다. 켠 상태의 그리기와 누르기는 지금과 한 줄도 달라지지 않는다.
- 저장 키는 `dg_mapCluster`이고 값은 `"1"`(켜짐) 또는 `"0"`(꺼짐)이다. 읽기 실패 시 켜짐으로 시작한다. 쓰기 실패 시 현재 화면에는 변경을 적용하고, 다음에 열 때는 저장된 값을 읽는다.
- 버튼 문구는 `묶어 보기`이고 상태는 `aria-pressed`로 나타낸다. 토스트 문구는 끌 때 `묶어 보기를 껐어요. 모든 시설을 실제 위치에 점으로 보여 줘요.`, 켤 때 `묶어 보기를 켰어요.`이다.
- 겹침 판단 반경은 기존 `MAP_TAP_PX`(24)를 쓴다.
- 방문 계획 지도(`GM.route`)에서는 버튼을 숨기고 그리기를 바꾸지 않는다.
- 버전은 `v85-map-cluster-toggle`이다. `sw.js` VERSION, `APP_VER`, RELEASE_NOTES 맨 위 한 줄, README 맨 위 단락을 함께 바꾼다.

## Review Focus
- 끈 상태로 구 전체(8,379개)를 볼 때: 점이 모두 그려지고 오류가 없어야 한다. 실제 체감 속도는 휴대폰 확인 항목으로 넘긴다. → Task 1 검사가 "점 개수 = 화면 안 시설 수"를 확인한다.
- 끈 상태에서 상태·종류 필터와 범례 숨기기: 걸러진 시설만 점으로 남아야 한다. → Task 1 검사에 넣는다.
- 저장소를 쓸 수 없는 기기(사생활 보호 모드 등): 오류 없이 켜짐으로 동작해야 한다. → Task 1 검사에서 `localStorage.getItem`이 예외를 던지게 하고 지도를 연다.
- 카드나 목록이 열린 채로 버튼을 누를 때: 선택한 시설 카드가 유지되고 지도만 다시 그려져야 한다. → Task 1 검사에 넣는다.
- 방문 계획 지도: 버튼이 보이지 않아야 한다. → Task 1 검사에서 `openMap('custom', {title:'계획', ordered:true, ...})`로 연다.

---

### Task 1: 묶어 보기 버튼과 점 그리기

**Files:**
- Modify: `app/staff-app.js` — `GM` 선언(:2678), `drawMapMarkers()`(:2709-2747), `mapPickTarget()`(:2791), `openMap()`의 `#mapLegend` 마크업(:2856), 문서 클릭 처리기(:1296 범례 처리 옆)
- Modify: `app/staff.css` — `#mapCluster` 버튼 모양(범례 버튼과 같은 계열)
- Test: `scripts/map-view-browser-smoke.cjs` — 기존 3b 다음에 새 단계 `3c` 추가

**Interfaces:**
- Produces:
  - `GM.cluster: boolean` — `openMap()`이 열릴 때마다 `dg_mapCluster`에서 읽는다(`!== "0"`).
  - `mapNearbyIds(point: L.Point): string[]` — `GM.singles` 중 컨테이너 좌표가 `point`에서 `MAP_TAP_PX` 안인 시설 id를 가까운 순으로 돌려준다.
  - DOM: `#mapLegend` 안의 `<button type="button" id="mapCluster" aria-pressed="true|false">묶어 보기</button>`. `GM.route`면 넣지 않는다.

- [ ] **Step 1: 실패하는 검사 작성** (`scripts/map-view-browser-smoke.cjs`, 3b 다음 `checks.push('묶어 보기 off shows every light at its coordinates')`)
  - 처음 열린 축소 화면에서 `#mapCluster`를 누른다. 확인할 것:
    - `aria-pressed` 값이 `'false'`이고, `localStorage.getItem('dg_mapCluster')`가 `'0'`이다.
    - `#gmap .mapcl`과 `#gmap .mapstack`이 모두 0개다.
    - `gmapLayer`의 `L.CircleMarker` 개수가 `mapVisiblePts().filter(l => gmap.getBounds().pad(.25).contains([l.lat, l.lng])).length`와 같다.
  - 겹침 확인: `gmapPts`에서 시설 두 개(`a`, `b`)를 고르고 `b`의 좌표를 `a`와 같게 바꾼다. 그 위치를 줌 19로 보고 `drawMapMarkers()`를 다시 부른다. `a`의 화면 좌표를 `page.mouse.click`으로 누른 뒤 확인할 것:
    - `GM.group`에 `a.id`와 `b.id`가 모두 들어 있다.
    - `#mapCard`에 `가까운 시설`이 보인다.
    - 목록에서 `b`를 누르면 `GM.sel === b.id`가 된다.
    - 바꾼 좌표는 검사 끝에 되돌린다.
  - 카드 유지 확인: 카드가 열린 상태에서 `#mapCluster`를 다시 누르면 `GM.sel`이 그대로이고 `#mapCard`가 열려 있다. 이때 `aria-pressed`는 `'true'`, 저장값은 `'1'`이다.
  - 필터 확인: 다시 끄고 범례 `정상`을 숨긴다. CircleMarker 개수가 화면 안의 비정상 시설 수와 같아야 한다. 확인 뒤 `정상`을 다시 켠다.
  - 다시 열기 확인: 끈 상태에서 `openMap('all')`을 다시 부르면 `aria-pressed`가 `'false'`이고 `.mapcl`이 0개다. 다시 켜고 축소하면 `.mapcl`이 3개 이상이다.
  - 방문 계획 지도 확인: 위치가 있는 시설 3개 `pts`로 `openMap('custom', {title: '계획', pts, ordered: true, order: pts.map(l => l.id), done: [], next: pts[0].id})`를 열면 `#mapCluster`가 0개다. 같은 시설로 `ordered` 없이 열면 버튼이 1개다.
  - 저장소 오류 확인: 새 페이지에서 `addInitScript`로 `Storage.prototype.getItem`과 `setItem`이 예외를 던지게 한다. 그 상태로 지도를 열면 `aria-pressed`가 `'true'`이고, 버튼을 눌러도 `pageerror`가 생기지 않으며 점 그리기로 바뀐다.

- [ ] **Step 2: 검사가 실패하는지 확인**
  Run: `DONGGU_PLAYWRIGHT_MODULE=D:/Temp/streetlight-maintenance-tools-20261112/node_modules/playwright node scripts/map-view-browser-smoke.cjs`
  Expected: FAIL — `#mapCluster`를 찾지 못한다.

- [ ] **Step 3: 구현** (`app/staff-app.js`)
  - `GM`에 `cluster: true`를 더한다. `openMap()`에서 필터를 복원할 때 `dg_mapCluster`를 읽어 정한다.
  - `#mapLegend`의 `#mapNote` 앞에 버튼을 넣는다. `GM.route`면 넣지 않는다.
  - 문서 클릭 처리기에서 `#mapCluster`를 누르면: `GM.cluster`를 뒤집고, 저장하고(실패는 무시), `aria-pressed`를 바꾸고, 토스트를 띄우고, `drawMapMarkers()`를 부른다.
  - `drawMapMarkers()`: `GM.route` 처리 다음, 기존 `if(z<GM.clusterBelow…)` 앞에 `if(!GM.cluster){inView.forEach(single)}`을 둔다. 그 뒤로는 기존 `if … else …` 분기를 그대로 쓴다.
  - `single()`의 클릭 처리와 `mapPickTarget()`: `GM.cluster`가 꺼져 있으면 `mapNearbyIds(그 점의 컨테이너 좌표)`를 쓴다. 결과가 2개 이상이면 `showMapGroup(ids)`, 아니면 지금처럼 `showMapCard(id)`를 부른다.

- [ ] **Step 4: 검사가 통과하는지 확인**
  Run: Step 2와 같은 명령, 그리고 `node scripts/check.mjs`
  Expected: map-view 검사의 마지막 JSON에 새 check 이름이 있고 `browserErrors: []`. check.mjs는 fail 0.

- [ ] **Step 5: 커밋**
  `git add app/staff-app.js app/staff.css scripts/map-view-browser-smoke.cjs docs/superpowers && git commit` (제목: `Let the map show every light at its coordinates (v85)`)

### Task 2: 버전·안내 문서

**Files:**
- Modify: `sw.js`(VERSION), `app/staff-app.js`(`APP_VER`, RELEASE_NOTES 맨 위 `{v:"v85-map-cluster-toggle",d:"2026-11-19",t:"지도보기 묶어 보기 켜기·끄기 · 끄면 모든 시설을 실제 위치에 점으로 표시"}`), `README.md`(맨 위 단락), `docs/field-check-v74-v79.md`(v85 항목 추가: 끄고 켜기, 겹친 점 고르기, 구 전체를 끈 채로 움직일 때의 속도)
- Test: `scripts/tests/pwa.test.cjs`(기존, VERSION과 APP_VER가 같은지 확인), `scripts/version-info-browser-smoke.cjs`(기존)

- [ ] **Step 1: 버전 문자열 4곳을 바꾸고 문서 단락을 쓴다.**
- [ ] **Step 2: 검사** — `node scripts/check.mjs`의 fail이 0이고, `.github/workflows/browser.yml`의 브라우저 검사 전체가 통과해야 한다.
- [ ] **Step 3: 커밋** (제목: `Release v85-map-cluster-toggle`)
