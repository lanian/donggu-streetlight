# 접수대장 연결 준비 구현 기록

## 최초 로컬 구현 단계와 남은 연결

`v71-ledger-prep`를 로컬 구현했다. **실운영 접수대장을 가져오는 실제 연결은 미완료**다. 사용자가 아직 협의 자료가 없다고 확인했으므로 공식 API 명세·허용 조회 경로·승인된 대장 예제 없이 endpoint·인증·업체 필드를 추정하지 않았다.

공개 앱 v70·운영 설정은 변경하지 않았고 push·Pages/Firebase 배포·실서비스 조회·로그인·숨은 API 탐색·번들 역분석을 수행하지 않았다. 구현은 별도 `feature/ledger-connector-prep`와 기본 개발 폴더에 보관하며 기존 v61 작업을 유지한다.

위 내용은 로컬 커밋 `83846d3` 당시 기록이다. 이후 사용자의 진행 요청에 따른 준비 화면 공개는 [v71 반영 범위](release-v71-2026-11-09.md)를 참고한다. 실제 조회·운영 저장소 반입은 계속 미연결/차단 상태다.

## 구현한 연결부

- 엄격한 KST 조회 기간, 명시적 항목 경로·고장/상태 코드·시각 형식 profile, 주입형 `readPage` 인터페이스.
- 전체 건수·완료 표시·기간·반복 cursor·중복 ID·최대 1,000건/50페이지를 검증한 후에만 전체 결과를 반환한다. 중간 오류·불완전 응답은 부분 결과를 반환하지 않는다.
- 최소 항목 정규화, 추가 원문·원본 키 제거와 제외 개수, getter/prototype 경로 거절, 원문/URL/토큰을 포함하지 않는 오류.
- 401/403·timeout·AbortSignal·현재 화면/계정 polling·늦은 응답을 처리한다. callback·timer·abort listener를 정리한다.
- 기존 화면의 **실운영 접수대장 연결** 카드: 기간·연결정보 미등록·비활성 실제 조회·합성 연계 흐름 확인. 합성 응답이 모두 확인되면 기존 중복/시설 검토와 local-only 실행기에 연결한다.
- 조회 기간 변경은 조회에서 만든 미리보기만 비운다. 기존 파일 미리보기는 유지한다. 오류·취소 뒤 기존 선택이나 늦은 결과가 되살아나지 않는다.
- `queryLive()`는 실제 주소·transport·로그인을 갖지 않으며 즉시 `not-configured`로 거절한다. 클라이언트에서 켜는 승인 체크박스·쿠키·비밀번호 입력을 제공하지 않는다.

신규 엔진을 HTML·서비스워커·VM 초기화 fixture·향후 브라우저 CI에 등록했다. Firebase·주민·지도 설정, 규칙·Functions와 기존 로컬 전용 실행기는 변경하지 않았다. 합성 명세와 수신기는 실제 업체의 규격이 아니다.

## 검증

- 초기 미구현 엔진·UI를 RED로 확인한 뒤 구현했다.
- 신규 엔진 단위 24개, 기존 반입 코어와 합쳐 43개 통과.
- 별도 구현 폴더 전체 Node 531개, v61 보존 기본 폴더 전체 Node 619개 통과.
- 새 Chromium 12개를 두 폴더에서 통과했다. 2페이지 완료 후 체험 반입·기존 완료 상태 보존·범위/권한·중간 오류·취소/timeout·늦은 응답·운영 환경 강제 호출·기간/파일 미리보기 분리를 확인했다.
- 기존 파일 반입 Chromium 15개와 버전 정보 회귀도 통과했다.
- 실조회 호출 후 비우기를 하면 미설정 오류가 되살아나는 문제, 반복 이름 경로의 제외 개수, 예외 객체 descriptor 경계를 RED→GREEN으로 보완했다.
- 390/1280px·주야간 기본/미리보기 8장을 확인했다. 실제 조회 비활성·합성 결과 표시·기간·카드 경계·가로 스크롤과 버튼의 차단 결함은 없었다.
- 브라우저 오류·변경 요청·운영 사이트 요청은 모두 0이다. 실제 업체 조회·인증·운영 저장·실기기 또는 공식 계약 호환을 검증한 결과는 아니다. 원문 일시 메모리의 안전 삭제를 보장하지 않는다.

## 근거

- `D:\Temp\streetlight-ledger-connector-core-final.log`
- `D:\Temp\streetlight-ledger-live-clear-red.log`
- `D:\Temp\streetlight-ledger-browser-final.log`
- `D:\Temp\streetlight-ledger-connector-check.log`
- `D:\Temp\streetlight-ledger-connector-main-check.log`
- `D:\Temp\streetlight-ledger-connector-main-browser.log`
- `D:\Temp\streetlight-ledger-old-import-browser.log`
- `D:\Temp\streetlight-ledger-version-browser.log`
- 화면: `D:\Temp\streetlight-ledger-connector-ui-final`

다음 실제 연결 작업에는 담당 부서가 허용한 조회/반출 범위와 공식 문서 또는 승인된 비식별 샘플이 필요하다. 인증·ID 범위·시간대·페이지 완료·변경/삭제/종결 정책을 확정한 뒤 승인된 입력 어댑터와 transport를 연결한다. 현재 코드의 미연결 표시를 해제하는 것만으로 실제 연결이 완성되지는 않는다.
