# 시설 방문계획 차량 노선 구현 계획

**Goal:** 방문계획의 미완료 시설 전체를 차량 경유 구간으로 구성하고, 사용자가 카카오·네이버 지도에서 운전 경로를 열 수 있게 한다.

**Architecture:** 기존 계획 생성·직선 순서·방문 완료·로컬 저장 계약을 유지한다. 별도 순수 모듈은 남은 시설을 최대 6곳씩 나누고 공식 차량 URL만 만든다. 기존 방문계획 안의 차량 패널은 전체 구간·출발점·시설 순서를 표시하며 외부 지도 선택 직전 계획·시설·계정·화면을 재검사한다.

**Tech Stack:** 기존 classic JavaScript, Leaflet, DGOperations/DGOffline, Node test runner, Playwright Chromium.

## 사용자 선택과 설계

- 사용자는 추가 API 키 없이 방문계획의 차량 경로를 네이버·카카오 지도앱으로 안내받는 방식을 선택했다.
- 실제 도로 경로는 외부 지도에서 계산한다. 앱 지도와 거리 표시는 직선 기준 방문 순서로 유지하며 운전 거리·시간이라고 표시하지 않는다.
- 6곳 단위 구간은 새 방문지 5곳을 경유하고 마지막 1곳을 목적지로 사용한다. 두 번째 구간부터는 직전 구간의 목적지가 출발점이다. 1곳만 남아도 노선 동작을 제공한다.
- 첫 출발점이 없으면 네이버 앱이 현재 위치를 사용한다. 카카오의 출발점을 첫 시설로 몰래 바꾸지 않는다. 사용자가 '내 위치 확인'으로 신선하고 정확한 좌표를 확보하면 카카오 웹·앱을 사용할 수 있다. 위치 거부/실패 시 네이버의 현재 위치 안내가 남는다.
- 내 위치는 차량 패널 문맥에만 보관한다. 지도 열기·위치 확인은 기존 계획 저장이나 방문 완료를 바꾸지 않는다.
- 새 화면은 기존 글꼴·색·패널 체계를 따른다. 구간 번호와 순서 목록, 구간별 주동작을 명확히 하고 390px·1280px 및 밝음/어두움을 확인한다.

## Task 1: 순수 구간·URL 모듈

Create `app/visit-driving-core.js`, `scripts/tests/visit-driving.test.cjs`.

1. 0/1/6/7/200곳 분할·모든 목적지 보존·구간 출발 연속성·불변 입력·잘못된 좌표/중복 거절·차량 URL·출발점 없는 카카오 거절 테스트 작성.
2. `node --test scripts/tests/visit-driving.test.cjs`로 기능 부재 RED 확인.
3. UMD `DGVisitDriving.makeBatches(stops, origin)`와 `makeUrl(batch, provider)` 최소 구현. provider는 `naver`, `kakao-web`, `kakao-app`만 허용.
4. 같은 테스트 GREEN 확인. 실제 외부 지도 호출은 하지 않는다.

## Task 2: 방문계획 차량 패널

Modify `app/operations.js`, `app/operations.css`, `index.html`, `sw.js`.

1. 기존 브라우저 하네스 기반 신규 `scripts/visit-driving-browser-smoke.cjs`의 차량 버튼 부재 RED 확인.
2. 미완료 시설이 있으면 '차량 이동 노선 만들기' 제공. 패널은 모든 구간의 출발점·시설 순서·도착점과 '지도에서 열기'를 보여 준다.
3. 명시적 위치 확인, 위치 정확도/수명, 거부·오류·늦은 응답 폐기 구현. 기본 계획·정렬 위치·서버 데이터는 수정하지 않는다.
4. 외부 선택은 값이 provider인 기존 DGDialog를 쓴다. 선택 전후 소유 문맥, 같은 계획 객체·내용, 현재 시설 좌표/완료·철거/추정 위치, 화면이 같을 때만 URL을 열어 stale 링크를 막는다.
5. 신규 모듈을 index와 SW shell에 포함. 기존 설정·Functions·규칙은 수정하지 않는다. 공개 배포는 이 작업의 필수 범위가 아니다.

## Task 3: 회귀·독립 검토·개발 폴더 반영

1. 신규 브라우저에서 전체 구간/단일 시설/완료 제외/차량 링크/위치 거부/비동기 문맥 변경/레이아웃 검사. 외부 요청·Firebase·실GPS는 격리한다.
2. 기존 `visit-plan-browser-smoke.cjs`, `operations-browser-smoke.cjs`, `version-info-browser-smoke.cjs`와 `node scripts/check.mjs` 수행.
3. 독립 코드·시각 검토 후 문제 수정, 필요한 검사만 반복한다.
4. 소유 변경만 기본 폴더에 패치·신규 모듈 복사하여 v61 WIP를 보존한다. 기본 폴더 검사와 diff check 후 구현 기록을 남긴다.

## 공식 규격

- Kakao Web: https://apis.map.kakao.com/web/guide/#routeurl (차량 `car`, 경유 최대 5개)
- Kakao App: https://apis.map.kakao.com/android_v2/docs/api-guide/urlscheme/ (`by=car`, `sp`, `vp`~`vp5`, `ep`)
- Naver App: https://guide-gov.ncloud-docs.com/docs/naveropenapiv3-maps-url-scheme-url-scheme (`route/car`, `v1`~`v5`, 출발 생략 시 현 위치, `appname` 필수)

실제 기기의 앱 설치·지도앱 전환·도로 경로·현장 차량 진입은 자동 격리 검사의 확인 범위와 구분한다.
