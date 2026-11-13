# v73 유지보수 기능 배포 기록

공개 상태: 최종 Pages 검사·배포와 공개 파일·합성 화면 검증을 통과했다. 앱과 필요한 Firestore 보안 규칙 모두 반영했다.

- 앱·서비스워커: `v73-maintenance`
- 통합: `665cd8a` (유지보수·규칙·점검 소유권), `a8d543f` (브라우저 실행 환경), `8e570fb` (버전·안내)
- 병합: [PR #53](https://github.com/lanian/donggu-streetlight/pull/53), `a63be0773e410810832304d694c5fff1a701a177`
- 회로 목록 경합 수정·최종 공개 대상: `30db7b9fa193375dd9155ed55d454bcde7744b1b`
- [최종 배포 파이프라인](https://github.com/lanian/donggu-streetlight/actions/runs/43228744960), [공개 앱](https://lanian.github.io/donggu-streetlight/)
- [기능 범위·사용 위치](release-v73-2026-11-12.md), [통합 검증](implementation-maintenance-release-2026-11-12.md)

## 반영 범위

별도 v61 유지보수 개발분을 공개 v72 기준에 통합했다. 배정 확인·보류/재개·긴급/기한 알림함, 실제 분전함·회로·시설 연결과 공동 장애, 명시적 점검 응답·미실시 사유·측정값, 정기점검 계획/회차, 부품·보증 이력과 오프라인 출동 자료를 포함한다. 기존 지도·차량 방문 노선·보고서·주민 신고 화면 연결은 유지한다.

공개 후보 `E:\Projects\streetlight-maintenance-20261112`와 공개 작업 폴더 `E:\Projects\streetlight-release-v63-20261108`는 `30db7b9`다. 기본 개발 폴더는 기존 미커밋 작업을 보존하며 관련 파일만 동기화했고 전체 Node 657개를 확인했다. 기본 폴더 전체를 초기화하거나 미커밋 작업을 한꺼번에 공개하지 않았다.

새 11개 컬렉션의 보안 규칙과 백업/복원 검증을 추가했다. 기록 이전·삭제, 실제 직원 역할 변경이나 실제 업무 자료 입력은 수행하지 않았다. 정기점검 회차는 앱 안에서 관리자가 생성하며 백그라운드 예약 실행·푸시는 활성화하지 않는다.

## 실제 서버 규칙

사용자가 이 컴퓨터의 Firebase CLI에 직접 로그인한 뒤 고정 대상 `donggu-light`의 기본 Firestore 규칙을 읽었다. v72 원본과 정규화 기준 일치함을 확인하고, 최종 PR 검사 성공 후 `deploy --only firestore:rules --project donggu-light --non-interactive`로 규칙만 배포했다. 비밀번호·토큰·인증코드를 저장소에 기록하지 않았다.

- 이전 규칙: `projects/donggu-light/rulesets/d3eace6b-0ebe-40fd-a050-37d20cc913b2`
- 이전 규칙 LF 정규화 SHA-256: `c8f52264d92c4ba4441eda471655a0017a58ec036b46ce713ace56fc01de7028`
- 새 규칙: `projects/donggu-light/rulesets/4da32faf-af30-4172-886f-a570ff7ebe6d`
- 새 규칙 LF 정규화 SHA-256: `66952a2b4489ecee16e0ec174d341284750f4b30a9003e76f7b17e89f58bea83`
- release: `projects/donggu-light/releases/cloud.firestore`

배포 CLI exit 0과 활성 규칙의 후보 원본 일치를 확인했다. 공개 후에도 같은 활성 규칙과 후보 일치를 재확인했다. 컴파일에는 `Invalid type (null/map)`, 미사용 함수, 사용되지 않는 보조 함수의 `exists`, 미사용 인자 경고가 남았다. 이를 경고 없는 배포로 보고하지 않는다. 실제 문서를 쓰는 검증은 하지 않았다. Functions·인덱스·Firebase Hosting을 배포하지 않았고, 서버 복원 호출은 기존 `functionsEnabled:false`와 App Check 미설정 조건으로 계속 차단한다.

## 결함 수정과 검사

확인 시각 0인데 확인자가 있는 작업 생성, 작업 시작과 함께 타인 명의 보류를 넣는 요청을 거절하도록 규칙을 수정했다. 실제 loopback Firestore 에뮬레이터에서 수정 전 허용되는 RED와 수정 후 거절되는 GREEN을 확인했다. 점검 초안/전송 중 계정·DB·저장 범위·화면이 바뀐 경우 이전 작업이 새 초안을 저장·삭제하지 않도록 하고 기존 작업 ID·시각·재시도 payload와 추가 입력을 보존했다.

최초 main Pages 실행 `43225690264`는 회로 목록 경합으로 브라우저 검사가 실패해 배포가 건너뛰어졌다. 회로 DB 저장 뒤 초안 정리가 끝나기 전에 새 시설 연결 편집창이 이전 빈 목록을 쓰는 문제였다. 초안 정리를 지연한 실제 UI 재현과 이전 캐시·진행 중 옛 조회의 단위 재현을 추가했다. 편집 진입에서 기존 강제 조회/재조회 루프를 사용해 수정했으며 이전 저장의 늦은 완료가 새 입력·선택·포커스를 바꾸지 않는 것도 확인했다.

- 최종 후보와 기본 개발 폴더 전체 Node **657/657** 통과.
- 실제 Node **22.23.4** Functions 단위 **9/9** 통과.
- Node 22·Java 24의 규칙 **66/66**, 서버 **7/7**, 복원 **8/8** 통과. demo 프로젝트만 사용했다.
- 로컬 전체 Chromium 스크립트 **51/51** 통과 후, 회로 수정의 자산 브라우저 **5개 검사**를 다시 통과했다.
- 회로 단위 2개와 기존 자산·소유권 16개 **18/18** 통과. 점검 소유권 신규 14개와 기존 7개 **21/21** 통과.
- 업무·현장·서버/복원·점검 소유권·회로 경합을 독립 검토했다.
- 자산·정기점검·배정/보류·출동 자료·점검 5개 화면의 390/1280px·light/dark 합성 로컬 캡처 **20장**을 독립 검토했다.
- 최종 원격 실행 `43228744960`의 앱 **657개**, Functions **9개**, 규칙 **66개**·서버 **7개**·복원 **8개**, 전체 브라우저 스크립트 **51종**과 Pages 배포가 모두 성공했다. 공개 소스는 `30db7b9`다.

## 공개 앱 확인

최종 Pages 성공 후 공개 앱 자산 **19개**와 시설 대장 **8,379건**의 SHA-256을 `30db7b9` Git blob과 비교해 모두 일치했다. 새 브라우저 문맥 4개에서 각각 실제 읽은 앱 파일 18종, 총 **72개 응답**도 일치했다. 서비스워커 실행은 차단했고 `sw.js`는 파일 해시와 기존 회귀 검사로 확인했다. 기존 사용자의 실제 기기 업데이트를 직접 확인한 결과는 아니다.

Firebase 설정을 null로 대체하고 local 계정·local DB·Firebase 연결 없음·v73을 먼저 확인한 뒤 합성 자료만 기록했다. 실제 UI의 분전함 수정·시설 회로 연결·공동 장애, 정기점검 두 시설의 회차 생성·일정 전진, 배정 수신 확인·보류와 원래 상태/기한 보존을 확인했다. 실제 회차 생성 명령을 동일 ID로 재생해 `alreadyApplied`와 계획·회차·작업·명령 영수증·작업 이력의 전후 완전 일치를 확인했다. 성공한 큐의 명령 원문 삭제도 확인했다.

미실시 1항목과 측정값 2개를 저장해 부모 점검·상세 증빙·측정 증빙이 일치하고 기존 고장·정식 점검일·재점검 안내가 보존되는 것을 확인했다. 출동 준비 후 합성 통신 오류로 시설·최근 점검·신고·작업·원본 사진의 준비자료 조회를 확인했다. 신고 연락처는 준비자료에서 제외됐다.

390/1280px·light/dark의 자산·정기점검·배정/보류·출동 자료·점검 화면 **20장**을 844px 높이의 `#sheet`로 캡처해 전부 독립 검토했다. 주요 버튼 20/20의 표시·폭을 확인했고 겹침·잘림·가로 넘침·toast 가림의 차단 문제는 없었다. 자산 화면은 회로·시설 연결·공동 장애 위치로, 점검 화면은 측정값·메모·저장 위치로 스크롤한 범위이며 전체 내용을 한 장에서 확인한 결과는 아니다. 화면의 1970년 점검일은 이전 날짜 보존 시험을 위한 합성 값 1000이다.

브라우저 오류·자산 불일치·비조회 HTTP·Firebase SDK·실운영 서비스·서비스워커 실행·외부 지도 열기는 **0건**이었다. 외부 호스트를 차단했고 GPS 12회는 합성 callback이었다. 실제 운영 계정의 저장·현장 통신 중단·실제 지도앱 전환·실제 서버 복원 검증으로 해석하지 않는다.

최초 공개 검증기는 성공 후 원문이 제거된 큐 영수증에서 원본 명령을 찾으려다 실패했다. 앱을 변경하지 않고 실제 `synced` 이벤트에서 원본 명령을 관찰하는 방식으로 검사 도구를 수정했다. 회차 생성과 일정 갱신의 실제 완료를 기다린 뒤 동일 명령 재생·전후 불변 검증을 유지했고, 최종 4개 문맥 전체가 통과했다. 최초 실패 폴더는 최종 공개 근거에서 제외한다.

실제 접수대장은 공식 명세·허용 조회 경로가 없어 계속 미연결이고 운영 저장소 반입도 차단한다. Firebase 프로젝트·지도·주민 신고 설정을 유지한다.

## 사용

기존 앱의 **새 버전 적용**으로 v73을 연다. **관리 현황**에서 분전함·회로/시설 이력, 정기점검 계획, 출동 자료 준비를 사용한다. 작업 상세에서 배정 확인·보류/재개를, 시설 점검표에서 항목별 응답·미실시 사유·측정값을 기록한다. 관리자 기능은 기존 권한이 필요하다.

## 근거 파일

기준 폴더: `D:\Temp\streetlight-maintenance-20261112`

- 최종 후보·기본 폴더 Node: `circuit-fix-full-node.log`, `main-circuit-fix-node.log`
- Node 22 Functions·에뮬레이터: `functions-node22.log`, `emulator-all.log`
- 규칙 RED/GREEN: `rules-red.log`, `rules-green.log`
- 점검 소유권: `inspection-session-{red,green,affected-green}.log`
- 전체 로컬 브라우저: `browser-suite.log`, `browser/results.json`
- 회로 경합: `circuit-race-{red,green}.log`, `circuit-loading-unit-{red,green}.log`, `circuit-fix-independent-browser.log`
- 로컬 시각 확인: `visual/2026-11-12T12-51-05-897Z/capture.json` 및 PNG 20장
- 원격 검사: `pr-final-checks.log`, `pr-final-browser.log`, `pages-browser-failed.log`, `pages-final-watch.log`, `pages-final-full.log`, `pages-final-metadata.json`
- 규칙 배포·원본 보존: `firebase-rules-deploy.log`, `live-before/firestore-v72-original.rules`, `live-before/metadata-v72-original.json`, `live-after/metadata.json`
- 공개 후 규칙 재확인·설정 보존: `live-rules-post-public.log`, `configuration-preservation.json`
- 최종 공개 검증: `public-verification-final.log`, `public/2026-11-12T13-45-29-855Z/verification.json` 및 PNG 20장
