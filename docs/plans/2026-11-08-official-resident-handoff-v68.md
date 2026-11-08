# Official Resident Report Handoff v68 Implementation Plan

**Goal:** 비공식 주민 안내 페이지에서 실제 운영서비스의 신고·처리현황 화면으로 이동하고 선택적으로 표찰·고장·메모를 복사한다. 접수나 개인정보 전송을 수행한 것처럼 표시하지 않는다.

**Architecture:** 명시적 `backend: official` 전달 방식을 추가한다. 검증된 HTTPS 호스트·공개 경로만 허용하는 순수 helper와 기존 신고 UI를 사용한다. 운영시설번호는 실제 대장 행과 ID가 일치할 때만 복사한다. 실제 접수·전화 인증·연락처·사진은 운영서비스에서 처리한다. 기존 gateway/SMS 모드는 선택 시 보존한다.

**Tech Stack:** classic JavaScript/UMD, 기존 주민 CSS, Web Clipboard의 명시적 사용자 동작, Node test runner, 외부 요청을 차단한 Playwright.

---

## 1. 목적지·메모 helper

Files: `report/official-handoff.js`, `scripts/tests/official-report-handoff.test.cjs`.

- URL의 HTTPS·정확한 호스트·알려진 경로를 허용하고 자격 증명·query/hash·open redirect 후보·유사 도메인을 거부하는 RED부터 시작한다.
- `DGOfficialHandoff.destination(url)`은 루트/`/slamp/` 또는 확인한 신고 지도 `/slamp/repair/map`, `statusDestination(url)`은 `/slamp/repair/status`만 허용한다.
- `summary({code,lightId,facility,issue,desc})`는 접수 전 메모다. 실제 행의 id가 일치할 때만 lampId를 포함하며 p-ID에서 외부 번호를 추정하지 않는다. 연락처·사진·GPS·확인 코드·가짜 접수번호는 구조적으로 포함하지 않는다.
- 함수 실제 동작을 Node에서 RED→GREEN으로 확인한다.

## 2. 주민 화면

Files: `report/index.html`, `report/report.js`, `report/report.css`, `report/config.js`.

- 기본 모드를 official로 바꾸고 첫 화면의 실제 신고 링크와 처리현황 링크를 제공한다. target blank/noopener/noreferrer이며 개인 정보·시설 쿼리를 붙이지 않는다. `/repair/new`는 실제 라우트가 아니므로 사용하지 않는다.
- 기존 표찰 확인을 공유하되, 고장·메모 작성/복사는 선택형 안내로 제공한다. 내용을 여기서 작성하지 않고 곧바로 운영서비스로 갈 수 있다.
- 공식 연결 모드에서는 사진·GPS·연락처 수집과 자체 접수/확인 코드 UI를 숨기고 이벤트도 차단한다. 위치를 자동 요청하지 않는다. 자체 90일 보관 안내를 운영서비스의 약속처럼 표시하지 않는다.
- Clipboard 거부 시 메모를 직접 선택·복사할 수 있고, 두 링크는 복사 성공과 무관하게 동작한다. 연결·복사로 완료 화면·접수번호를 만들지 않는다.
- 대장에 lampId를 포함해 읽고 정확한 QR ID 확인, 표찰 수정 시 연결 해제, 미확인 ID의 추정 연결 금지, 비동기 조회 토큰/오류 재시도를 보완한다.
- gateway·SMS·이메일의 명시적 설정과 실제 전송/수신 동작은 보존한다.

## 3. 회귀·품질

Files: `scripts/official-report-browser-smoke.cjs`, 기존 security-report unit harness 등 필요한 fixture.

- 실제 UI 부재 RED 후 초기 공식 링크·복사·사진/GPS/POST 0건·미확인 시설·수정/지연 조회·Clipboard 거부·잘못된 주소·status 링크·390/1280 주간/야간을 검증한다.
- 대상 사이트는 GET fixture로 대체하며 실제 신고는 보내지 않는다. 기존 report-page/security/QR/접수·상태 회귀도 실행한다.
- 독립 규격/품질 검토 뒤 지적을 수정하고 전체 Node·브라우저 CI를 실행한다.

## 4. 통합·게시

- v68-official-report 버전과 새 주민 helper 자산을 shell cache에 포함한다. 직원 로그인 전 주민 안내와 문서를 현재 모드에 맞춘다.
- v61 WIP를 보존하며 변경한 최소 hunk/파일만 기본 폴더에 동기화하고 재검사한다.
- Pages 배포 뒤 공개 자산 해시·공식 링크·복사·수집/POST 없음·초안 유지 등을 독립 fixture로 확인한다. 실제 운영 인증·접수 성공을 검증한 것으로 주장하지 않는다.

## 검토 중 보완

- 번호 수정 직후 표시되는 기존 표찰이 복사 메모에서 누락되는 문제를 단위 RED→GREEN으로 고쳤다. 시설 연결은 해제하고 표찰은 미확인 입력값으로 유지한다.
- 공식 전달 모드로 전환해도 인증된 직원의 이전 자체 접수 건수 조회와 가져오기를 유지한다. 기존 QR 알림 브라우저 검사가 실패하는 것을 확인한 뒤 수정해 통과했다.
- details 내부 입력칸 경계와 긴 QR 표찰의 가로 넘침을 브라우저 RED로 재현하고 box-sizing·줄바꿈을 수정했다.
