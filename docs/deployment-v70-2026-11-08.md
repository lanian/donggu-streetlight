# v70 신고 파일 검토 준비 화면 배포 기록

- 기능 구현: `36c9d5991bbb02471093c4be228d01c7e372b1dd`
- 공개 배포: `350bb97b017d4ec159c13daeb0b43f96bfa584e5`
- 앱·서비스워커: `v70-report-import`
- [배포 파이프라인](https://github.com/lanian/donggu-streetlight/actions/runs/42479573803)
- [공개 앱](https://lanian.github.io/donggu-streetlight/)
- [사용 방법·협의 사항](official-report-import-prep.md), [반영 범위](release-v70-2026-11-08.md)

사용자의 공개 반영 요청에 따라 준비 기능을 배포했다. 실서비스 접속·실제 신고 수집·운영 저장소 반입 차단은 유지한다. 기능 브랜치를 v69 공개 기준에 fast-forward로 합치고 공개 버전·안내·캐시만 갱신했다. 기본 폴더의 v61 개발분은 보존했으며 Firebase·주민·지도 설정, 규칙·Functions는 변경하지 않았다.

## 배포 전 확인

- 새 코어/실행기 19개를 포함한 배포 후보 Node 507개 통과.
- 기존 개발분이 있는 기본 폴더 Node 595개 통과. 소유 코드·문서는 공개 커밋과 일치하며 별도 v61 모듈과 shell 자산을 유지한다.
- 신규 Chromium 15개·버전 정보 회귀 통과. 독립 검토에서 읽기 전 local 계정/DB·Firebase 없음·관리자/쓰기 권한 차단, 비동기 scope·중복·신규 생성·개인정보 원문 제외·큐 미사용을 재확인했다.
- 전체 파이프라인의 앱·서버/Firestore 규칙 검사·브라우저 46개 스크립트·Pages 배포가 모두 성공했다.

## 공개 자산과 체험 동작 확인

2026-11-08 21:22 KST 이후 새 브라우저 문맥 두 개로 확인했다. 공개 파일 9개의 SHA-256이 커밋 Git blob과 일치했다. 각 문맥에서 실제 읽은 UI 자산 8종의 응답도 일치했다. 서비스워커는 차단했으며 `sw.js`는 파일 해시로 확인했다.

Firebase 설정을 null로 대체한 체험 저장소와 local 계정을 확인한 뒤 공개 대장의 유일 활성 운영 시설번호를 골라 합성 JSON 2행만 넣었다. 이름·연락처·설명·사진·위치 marker를 추가했으며 미리보기와 저장 자료에 남지 않았다. 한 건만 정확히 연결해 로컬 신규 생성했고, 원본 내용을 바꿔 재반입해도 0건 생성·직원이 변경한 완료 상태와 메모 유지·기존 원문 보존을 확인했다.

LocalStorage·SessionStorage·앱 IndexedDB와 모듈 상태에 추가 개인정보 marker가 없고, 반입으로 생긴 서버 재시도 큐도 없었다. 이는 일시적 JavaScript 메모리의 안전 삭제를 보장하는 검증은 아니다.

별도 문맥에서는 실제 서비스에 연결하지 않고 DB/Firebase 객체를 운영 환경으로 모사했다. 파일·샘플·적용 버튼이 비활성화되고, 강제 파일/텍스트/적용/실행기 호출도 모사 DB 읽기·쓰기·파일 읽기 모두 0회로 거절됐다. 실제 Firebase 로그인·서버 저장·배포 권한을 확인한 결과는 아니다.

브라우저 오류·비조회 HTTP 요청·Firebase SDK 요청·실제 GPS·운영서비스 활동은 모두 0건이다. 390/1280px·light/dark의 기본/미리보기 화면 8장을 `#sheet`만 캡처해 독립 시각 검토했다. 준비·미연결 표시, 모바일 가로 스크롤, 카드 경계와 주버튼을 확인했다.

- 공개 JSON: `D:\Temp\streetlight-v70-public-import-verification\2026-11-08T12-22-55-559Z\verification.json`
- 공개 화면: 위 폴더의 `import-{390,1280}-{light,dark}-{entry,preview}.png` 8개
- 공개 로그: `D:\Temp\streetlight-v70-public-import-verification.log`
- 로컬 배포 후보: `D:\Temp\streetlight-v70-release-check.log`, `streetlight-v70-release-browser.log`
- 기본 폴더: `D:\Temp\streetlight-v70-main-check.log`

## 사용 범위

**새 버전 적용 → 관리 현황 → 운영 시스템 연계 → 운영 신고 파일 검토**에서 준비 화면을 연다. 실제 저장소에서는 안내·준비 양식만 제공하고 파일 검토·적용은 관리자 체험 모드로 제한한다. 실제 운영서비스의 양식/API·반출 근거·권한·보관·첨부 정책은 담당 부서 및 운영 업체 협의 후 별도 연결 작업이 필요하다.
