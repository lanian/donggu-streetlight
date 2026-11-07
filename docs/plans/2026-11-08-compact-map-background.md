# Compact Map Background Implementation Plan

**Goal:** 지도 배경 선택기가 지도를 상시 가리지 않도록 작은 배경 버튼으로 접는다.

**Architecture:** 기존 Leaflet 배경 컨트롤 안에 64×44 버튼과 숨겨진 선택 패널을 둔다. 지도·편집·순찰 모달 안에서만 열고, 선택·Escape·바깥 클릭으로 닫는다. 배경 모드 저장과 지도 레이어 계약은 유지한다.

**Tech Stack:** 기존 classic JavaScript, Leaflet, CSS, Node test runner, Playwright.

---

1. `scripts/satellite-map-browser-smoke.cjs`에 접힌 크기·펼친 경계·닫기/포커스·지도 편집 보호 검사를 먼저 추가하고 현 구현에서 실패를 확인한다.
2. `app/map-layers.js`, `app/map-layers.css`에 버튼·패널을 구현한다. 모드/오류는 버튼 이름·상태 안내에 반영하고 문서 이벤트는 지도 제거 시 해제한다.
3. `app/field-ui.js`의 캡처 단계 Escape 예외를 열린 지도 컨트롤로 한정한다. 첫 Escape는 배경 패널, 이후 Escape는 기존 상위 화면을 처리한다.
4. 기존 지도 단위 검사의 DOM 조회를 새 구조에 맞추고 지도 수명·늦은 이벤트·설정 계약을 유지한다.
5. 배포본 Node 검사와 지도·구역 편집·모달·순찰 검사를 실행하고 화면을 확인한다. 독립 검토 뒤 앱/SW를 같은 v64 버전으로 올린다.
6. 기존 Pages 파이프라인을 통해 배포하고 공개 자산과 접힌 화면을 확인한다. 별도 v61 개발 폴더에는 같은 지도 수정만 반영한다.

바깥 클릭은 선택창을 닫는다. 실제 지도 캔버스의 첫 클릭은 닫기만 수행하여 좌표나 도형을 수정하지 않으며, 위치 찾기 등 다른 버튼은 기존 동작을 유지한다. 키 설정과 서버·업무 저장 코드는 바꾸지 않는다.
