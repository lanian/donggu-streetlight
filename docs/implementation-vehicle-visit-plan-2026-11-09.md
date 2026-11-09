# 시설 방문계획 차량 노선 구현 기록

`v72-vehicle-plan`을 별도 작업 폴더와 기본 개발 폴더에 구현했다. 사용자는 추가 API 키 없이 네이버·카카오 지도로 안내받는 방식을 선택했다. 이번 작업은 로컬 구현이며 push·공개 앱 배포는 수행하지 않았다. 공개 기준 작업 폴더는 `f785d8d`를 유지한다.

위 내용은 로컬 구현 커밋 `685bc60` 당시 기록이다. 이후 사용자의 진행 요청에 따른 공개 반영은 [v72 공개·검증 범위](release-v72-2026-11-09.md)를 참고한다. 실제 지도앱 전환·도로 경로와 운영 백엔드 확인은 아래 로컬 검사 범위와 구분한다.

## 구현 범위

- **미점검·방문 계획 → 차량 이동 노선 만들기**에서 미완료 시설 전체를 기존 방문 순서대로 최대 6곳씩 나눈다. 1곳도 지원하며 최대 200곳의 방문지를 누락 없이 보존한다.
- 첫 구간에서 출발 위치가 없으면 네이버 지도앱의 현재 위치를 쓴다. 명시적 **내 위치 확인** 후에는 카카오 웹·앱도 선택한다. 첫 시설을 몰래 출발점으로 바꾸지 않는다. 두 번째 구간부터는 이전 구간의 마지막 시설에서 이어진다.
- 위치는 해당 차량 패널 문맥에만 보관한다. ±100m 이내의 새 위치만 사용하고 5분이 지나면 다시 확인한다. GPS 거부·저정확도·실패 시 네이버 현재 위치 경로가 남는다.
- 지도 선택과 GPS 응답 대기 중 계정·저장소·계획 객체·계획 순서·시설 좌표·완료 상태·화면을 재검사한다. 이전 문맥의 결과로 외부 링크를 열거나 화면을 다시 열지 않는다.
- 카카오 웹은 `link/by/car`, 카카오 앱은 `by=car`, 네이버 앱은 `route/car`만 생성한다. 경유지는 최대 5곳이며 이름은 URL 구분자와 분리해 인코딩한다.
- 기존 계획 저장·방문 완료·점검 결과·작업 연결을 수정하지 않는다. 실제 도로 경로와 운전 시간은 외부 지도에서 확인하며 앱의 직선 방문 순서·거리·지도 표시는 유지한다.

새 모듈 `app/visit-driving-core.js`를 index와 SW shell에 포함했다. 신규 브라우저 검사는 CI 목록에 등록했으며 공개 배포 시 전체 파이프라인에서 실행된다. 기존 Firebase·지도·주민 신고 설정, Firestore 규칙·Functions는 수정하지 않았다. 기본 폴더의 v61 업무 기능·모듈·SW 자산을 유지했다.

## 검증

- 별도 작업 폴더 baseline Node 531개 통과 후 구현했다.
- 새 코어 22개: 기능 부재 RED → GREEN, 루트와 독립 검토자의 직접 재실행도 22/22 통과.
- 신규 Chromium 18개 통과: 단일 시설, 13곳의 6+6+1 분할과 모든 방문지/경유지 보존, 현재 좌표·완료 제외, 출발점 미확인·GPS 거부·저정확도·만료, 계획/시설/계정/화면 변경, 기존 기록 불변, 모바일·PC 레이아웃.
- 만료 직전 위치를 갱신할 때 새 GPS까지 폐기되던 문제를 RED로 확인하고, GPS 수신에는 계획 내용만 비교하도록 수정했다. 지도 선택에는 출발 위치까지 포함한 엄격한 비교를 유지한다.
- 모바일 details 안의 경로 버튼이 content-box로 계산되어 패널을 넘던 문제를 실제 좌표·스크린샷으로 재현했다. 해당 버튼만 border-box·최대 폭·줄바꿈을 지정해 RED → GREEN을 확인했다.
- 전체 Node 검사는 별도 작업 폴더 553개, 기본 개발 폴더 641개 통과. 기존 단일 함수 VM 시험에 새 `drivingView` 의존성의 빈 출력 stub만 추가했으며 기존 좌표 제외 검증은 유지했다.
- 기본 개발 폴더에서도 신규 Chromium 18개를 직접 실행해 모두 통과했다. 차량 동작 코드 블록과 새 모듈·테스트·스타일은 별도 폴더와 일치하며 기존 v61 업무 handler를 보존했다.
- 기존 방문계획·업무 흐름·버전 정보 Chromium 세 스크립트 통과. 방문 완료/재정렬/지도/기존 길찾기/재시작 유지와 업무 저장 충돌 처리를 확인했다.
- 390/1280px·밝음/어두움의 진입·하단 화면 8장(모두 높이 844px)을 `#sheet`만 캡처하고 독립 시각 검토를 통과했다. 제목·출발점·상태·주요 버튼, 마지막 구간과 모바일 가로 넘침을 확인했다.

브라우저 검사는 Firebase 설정을 null로 대체한 새 로컬 시험 문맥, 합성 GPS와 외부 열기 stub을 사용했다. 브라우저 오류·비조회 HTTP 요청·운영서비스 요청은 0건이었다. 실제 위치 수집·지도앱 설치/전환·실제 도로 경로·현장 차량 진입·운영 Firebase 저장을 검증한 결과는 아니다.

## 근거와 사용법

- 코어 RED/GREEN: `D:\Temp\streetlight-vehicle-core-{red,green}.log`
- 브라우저 RED/최종 GREEN: `D:\Temp\streetlight-driving-browser-{red,green}.log`
- 위치 만료 경계: `D:\Temp\streetlight-driving-refresh-{red,green}.log`
- 모바일 넘침: `D:\Temp\streetlight-driving-layout-diagnostic.log`, `streetlight-driving-layout-green.log`
- 진입 화면: `D:\Temp\streetlight-driving-layout-entry-green.log`
- 화면 8장: `D:\Temp\streetlight-driving-ui\driving-{390,1280}-{light,dark}[-entry].png`
- 전체 Node: `D:\Temp\streetlight-vehicle-feature-check.log`, `streetlight-vehicle-main-check.log`
- 기본 폴더 신규 브라우저: `D:\Temp\streetlight-driving-main-browser.log`
- 기존 브라우저 회귀: `D:\Temp\streetlight-vehicle-{visit-plan,operations,version-info}-regression.log`
- [사용 방법과 공식 지도 연결 규격](vehicle-visit-plan.md)
- [구현 계획](plans/2026-11-09-vehicle-visit-plan.md)
