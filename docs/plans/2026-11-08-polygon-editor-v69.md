# 다각형 구역 편집 개선 계획

**Goal:** 지도에서 점을 찍고 끌어 고치며 실수를 되돌릴 수 있도록 다각형 설정을 개선한다.

**Architecture:** 기존 `shape/vertices` 저장·검증과 `changed → writeDraft` 경로를 유지한다. 원형 구역도 유지한다. UI 전용 점 편집·이력 helper를 추가하고 좌표 직접 입력을 고급 설정으로 접는다. 기존 v61 개발분은 기본 폴더에 보존하고 v68 공개 기준의 분리된 worktree에서 v69를 검증한다.

**Tech Stack:** 기존 classic JavaScript/UMD·Leaflet·테마 CSS, Node test runner·격리 Chromium.

## 1. 순수 점 편집과 되돌리기

- 새 `app/polygon-editor.js`, `scripts/tests/polygon-editor.test.cjs`.
- raw 좌표·선택점 undo/redo, 점 추가·이동·삭제·닫힌 경계의 중간점 삽입, 최대 32점·이력 50개를 RED→GREEN으로 검증한다.
- 형상 타당성은 기존 `DGLightingAreaCore`가 최종 검증한다. 편집 중 0~2점과 잘못된 수동 좌표도 초안에 유지하고 오류를 표시한다. 저장 데이터 계약은 바꾸지 않는다.

## 2. 지도 중심 편집 화면

- `app/lighting-areas.js`, 새 `app/lighting-areas.css`, `index.html` 자산 등록.
- 범위 방식 바로 아래에 지도와 도구를 배치한다. 좌표 textarea의 기존 ID/내용은 details에 유지한다.
- 새 다각형은 점 추가 모드, 기존 유효 경계는 모양 수정 모드. 지도 바탕 클릭은 점 추가 모드에서만 추가한다. 완성 버튼은 기존 형상 검증을 통과한 경우에만 수정 모드로 전환한다.
- 번호 있는 꼭짓점은 선택·키보드 접근·드래그로 수정한다. 선택 점 삭제·선 중간점 추가·되돌리기/다시하기·전체 범위 보기를 제공한다. 전체 비우기는 확인 후 실행하고 복구할 수 있다.
- 지도 이벤트는 view/draft/editor sequence/account generation 및 관리자 권한·pending/readonly/conflict를 확인한다. 드래그는 이동 중 지도 미리보기, 종료 때 한 번 초안에 반영한다. 오래된 이벤트는 새 구역이나 계정에 반영하지 않는다.
- 화면 재렌더링·역할 변경·저장 중에는 도구가 이전 편집을 수행하지 못한다. 재전송/초안/CAS/저장 실패/보관 정책은 유지한다.

## 3. 검증

- 새 `scripts/polygon-editor-browser-smoke.cjs`의 미구현 UI RED를 확인한다. 실제 Leaflet pointer drag·선택점 삭제·중간점·undo/redo·그리기 완료 후 바탕 클릭·수동 좌표·최대점·잘못된 형상·권한/저장/이전 view 이벤트를 검증한다.
- 기존 `scripts/lighting-areas-browser-smoke.cjs`는 고급 좌표를 명시적으로 펼쳐 이전 업무 검증을 유지한다.
- 390/1280px light/dark 지도·도구·고급 입력의 가로 넘침과 주요 동작을 확인한다. 새/이전 구역·원형 구역·저장 복구·영수증 회귀를 실행한다.
- `node scripts/check.mjs`, 관련 브라우저와 전체 CI를 통과한다. Firebase·외부 API를 격리하고 실제 운영 데이터에는 쓰지 않는다.

## 4. 통합과 게시

- `v69-polygon-editor` 버전·서비스워커 필수 자산과 브라우저 CI를 갱신한다. 기존 설정·서버/규칙·지도 공급자 설정은 유지한다.
- 기본 개발 폴더에는 최소 hunk와 새 파일만 동기화하고 v61 모듈을 보존한다.
- 기존 배포 권한 범위에서 Pages 게시 후 커밋 자산 해시와 공개 UI를 격리 브라우저로 확인한다. 실제 주민 신고나 Firebase 변경은 하지 않는다.
