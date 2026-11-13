# v71 접수대장 연결 준비 화면 배포 기록

- 최초 기능 구현: `83846d3e1240d0b1e9ffa04375a0b968660415b2`
- 공개 배포: `f785d8d16d6e9aa332636fb39424bded1a765ef4`
- 앱·서비스워커: `v71-ledger-connector`
- [배포 파이프라인](https://github.com/lanian/donggu-streetlight/actions/runs/42624004668)
- [공개 앱](https://lanian.github.io/donggu-streetlight/)
- [사용 방법·필요 자료](official-report-import-prep.md), [공개 반영 범위](release-v71-2026-11-09.md)

사용자가 “아직 없음 — 준비 기능만 반영”으로 확인한 범위만 공개했다. 실제 접수대장 조회는 미연결이며 `queryLive()`와 실제 조회 버튼, 운영 저장소 반입 차단을 유지한다. 공식 API·조회 경로·인증·업체 필드를 추정하거나 운영서비스를 조회하지 않았다.

배포용 작업 폴더에서 기존 v70 공개 기준에 준비 기능 커밋을 fast-forward로 합치고 공개 버전·설명·서비스워커 캐시를 갱신했다. 기본 개발 폴더의 v61 작업은 보존했다. 공개 v70 대비 Firebase·주민·지도 설정, Firestore 규칙과 Functions는 변경하지 않았다.

## 배포 전 확인

- 새 연결부 24개를 포함한 배포 후보 Node 531개 통과. 기본 개발 폴더 Node 619개 통과.
- 신규 Chromium 12개, 기존 파일 반입 15개와 버전 정보 회귀 통과.
- 별도 검토에서 실제 조회 즉시 거절, 항상 비활성인 실제 조회 버튼, 전체 수신 후 반영·실패/취소/조건 변경 시 폐기, 읽기 전 로컬 관리자 조건과 기존 신고 덮어쓰기 방지를 확인했다.
- GitHub의 앱·서버/Firestore 규칙 검사·브라우저 47개 스크립트·Pages 배포가 모두 성공했다. 이는 Firebase 실운영 배포나 운영 계정 접근 권한 검증을 뜻하지 않는다.

## 공개 자산과 격리 브라우저 확인

배포 성공을 확인한 뒤 공개 파일 10개의 SHA-256을 공개 커밋 Git blob과 비교해 모두 일치했다. 새 브라우저 문맥 두 개에서 실제 읽은 UI 자산도 각각 9종 모두 일치했다. 서비스워커는 실행을 차단하고 `sw.js`는 파일 해시로 확인했다.

Firebase 설정을 null로 대체하고 `FB` 없음·DB local·계정 local을 먼저 확인했다. 공개 시설 대장에서 유일한 활성 운영 시설번호를 골라 실제 제품의 합성 응답 2쪽을 미리보기 2건으로 변환한 뒤 이 시험 문맥의 로컬 신고함에만 신규 2건을 만들었다. 재조회·강제 중복 반입에서 신규 0건·중복 2건이고 직원이 변경한 완료 상태와 메모를 유지했다. 추가 개인정보 표식은 미리보기·모듈 상태·LocalStorage·SessionStorage·앱 IndexedDB에서 검출되지 않았고 서버 재시도 큐는 0건이었다. 일시적 JavaScript 메모리의 안전 삭제를 보장하는 검증은 아니다.

실제 조회 비활성 표시와 직접/UI 강제 호출의 `not-configured` 거절을 확인했다. 이때 DB 읽기·합성 fixture 생성·페이지 reader 호출은 0회였다. 날짜 오류는 페이지를 읽지 않았고, 두 번째 쪽의 모사 403과 취소 후 늦은 응답도 부분 미리보기나 반입을 만들지 않았다.

다른 새 문맥에서는 운영 DB/Firebase를 모사 객체로 바꿔 확인했다. 실제 조회·합성·파일·적용 버튼이 비활성이고 강제 호출도 DB 읽기·쓰기·파일 읽기·페이지 읽기·fixture 생성 모두 0회로 거절됐다. 실제 Firebase 로그인이나 운영 저장을 수행한 결과가 아니다.

브라우저 오류·자산 불일치·비조회 HTTP 요청·Firebase SDK 요청·서비스워커 실행·실제 GPS·운영서비스 요청은 모두 0건이었다. 외부 호스트는 차단했다.

390/1280px·light/dark의 진입/미리보기 화면 8장을 `#sheet`만 캡처해 독립 시각 검토를 통과했다. 미연결·합성 표시와 컨트롤의 잘림·겹침을 확인했다. 진입 캡처는 조회·반입 컨트롤 전체를 보기 위한 3000px 높이이며, 미리보기는 844px 높이에서 고정 제목 아래 주버튼과 모바일 표의 가로 스크롤을 확인했다. 이 결과를 모든 기기·로그인 상태·서비스워커 갱신 동작의 검증으로 확대하지 않는다.

## 근거 파일

- 공개 JSON·화면: `D:\Temp\streetlight-v71-public-ledger-verification\2026-11-09T13-21-27-676Z\verification.json`, 같은 폴더의 PNG 8개
- 공개 로그: `D:\Temp\streetlight-v71-public-ledger-verification.log`
- 배포 파이프라인 로그: `D:\Temp\streetlight-v71-pages-pipeline.log`
- 배포 후보: `D:\Temp\streetlight-v71-release-check.log`, `streetlight-v71-release-official-ledger-connector.log`, `streetlight-v71-release-official-report-import.log`, `streetlight-v71-release-version-info.log`
- 기본 개발 폴더: `D:\Temp\streetlight-v71-main-check.log`

## 사용 범위

**새 버전 적용 → 관리 현황 → 운영 시스템 연계 → 운영 신고 파일 검토 → 실운영 접수대장 연결**에서 미연결 상태와 필요한 자료를 확인한다. 관리자 체험 모드에서만 기간 설정·합성 2쪽 수신·로컬 반입 흐름을 사용할 수 있다.

실제 접수대장 수신에는 담당 부서의 허용 범위와 공식 API/내보내기 규격 또는 승인된 예제가 필요하다. 실제 인증·페이지 완료·ID 범위·시각/코드 변환·변경/삭제/첨부 정책은 아직 검증하지 않았다. 준비 화면 공개는 실운영 연계 완료를 뜻하지 않는다.
