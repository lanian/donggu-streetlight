# Roadlighting Bridge v67 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 비공식 현장 앱에서 gjd.roadlighting.kr 운영 자료를 안전하게 반입하고, 결과·사진을 전달용 파일로 내보내며 실제 등록 확인을 따로 기록한다.

**Architecture:** 기존 운영 시스템을 대장·등록 처리의 기준으로 둔다. 브라우저의 순수 변환/패키지 코어와 관리자용 연계 화면을 추가한다. 공식 API 계약이 없으므로 파일 준비·다운로드와 운영 등록 확인을 구분한다. 조회는 기존 권한과 전체 페이지 읽기를 사용하고, 연계 이력은 계정/저장소별 기기 저장소에 보관한다. Firebase·주민 접수·지도 설정과 서버 규칙은 유지한다.

**Tech Stack:** 기존 classic JavaScript/UMD, CSS, DGData/DGOffline, UTF-8 CSV/JSON, 무압축 ZIP, Node test runner, Firebase-null Chromium.

---

## 1. 운영 대장 반입

Files: `app/roadlighting-registry.js`, `app/operations-core.js`, `app/management.js`, `scripts/build-registry.mjs`, focused Node/browser regressions.

1. 실제 누락 필드 삭제와 혼합 출처 누락 철거를 먼저 실패시키는 회귀를 작성한다.
2. `getPoint.json`의 DATA/시설 배열을 브라우저에서 변환한다. lamp_id는 lampId와 p-ID로 유지한다. 중복·잘못된 ID/좌표·빈 자료·불완전 자료는 거부한다.
3. 도로조명 범위는 lampId와 대응하는 p-ID가 확인된 시설로 한정한다. 다른 공개대장 시설은 누락 목록에 넣지 않는다.
4. 원본에서 제공하지 않은 필드와 현장 변경은 보존한다. 명시된 null과 미제공을 구분하며 새 registryValues가 기존 제공 필드를 잃지 않게 한다.
5. 운영 자료의 미제공 시설은 v67에서 자동 철거하지 않는다. 일반 전체 대장 비교의 기존 정책과 구분한다.
6. 비동기 파일 읽기·적용은 계정/DB/역할/화면 범위를 검증한다. 기존 안정 작업 ID·CAS·재시도를 재사용한다.
7. `node --test scripts/tests/roadlighting-registry.test.cjs` 및 기존 대장 회귀를 실행한다.

## 2. 전달용 묶음 코어

Files: `app/roadlighting-core.js`, `scripts/tests/roadlighting-package.test.cjs`.

1. 안정 ID, 반복 내보내기, 정상 포함 전체 점검, 검수 대기/완료 구분, 연락처 기본 제외, 원본/미리보기/누락 사진 표시를 먼저 실패시킨다.
2. 인터페이스: `DGRoadlightingCore.buildPackage(input, {resolvePhoto,isCurrent,onProgress})` → Promise `{batchId,contentHash,bytes,filename,manifest,entries,summary,missingPhotos,fallbackPhotos}`.
3. input은 lights/inspections/reports/workOrders/workEvents/patrols, from/to(밀리초), includePhotos/includeContacts, generatedAt을 갖는다. 선택 기간과 정렬은 결정적이고 자료를 임의 개수로 자르지 않는다.
4. package는 manifest.json, records.json, 형식별 CSV, photos.csv, 사진 파일, 사용 안내를 포함한다. 공식 업체 업로드 양식으로 표시하지 않는다.
5. 모든 기록에 entity/internalId/lightId/lampId, 원본 시각·버전과 내용 해시를 보존한다. batchId는 생성 시각을 제외한 실제 전달 자료로 결정한다. 사진 해시/관계/전후 구분/원본 여부도 보존한다.
6. HTML/실행 스크립트 없이 안전한 UTF-8 파일 이름과 CSV 수식 중립화를 적용한다. ZIP 경로·크기 한계를 검증하며 초과는 오류로 설명한다. 사진 조회는 제한 병렬·실패 표시를 사용한다.
7. 상태는 원래 업무 의미를 유지한다. completed=검수 대기, verified=검수 완료이며 내보내기로 원래 기록을 수정하지 않는다.
8. `node --test scripts/tests/roadlighting-package.test.cjs`로 실제 ZIP 헤더/CRC/한글 파일 내용/매니페스트를 검사한다.

## 3. 관리자 연계 화면과 등록 확인

Files: `app/roadlighting.js`, `app/roadlighting.css`, `scripts/roadlighting-bridge-browser-smoke.cjs`; root integration in legacy-bridge/index/staff/sw.

1. 관리의 `운영 시스템 연계`에서 대장 비교, 기간·동·자료 유형별 조회, 사진 포함, 연락처 필드 포함(기본 끔), 전달 묶음 준비·저장을 제공한다.
2. 전체 읽기와 provenance를 유지하며 미완료/실패/조건 변경 후 이전 자료로 내보내지 않는다. 계정·DB·offline namespace·역할·내비게이션과 요청 순서로 늦은 응답을 거부한다.
3. `DGOffline`의 `roadlighting-batch` 종류에 메타데이터·기록별 해시·수동 등록 확인 이력을 보관한다. 사진 바이트·업체 자격 증명은 보관하지 않는다. CAS로 다른 탭의 확인 내용을 보호한다.
4. 파일 준비/내보냄/사용자 등록 확인/등록 실패를 구별한다. 기록별 선택 후 등록번호·상태·사유를 기록한다. 실제 운영 응답을 확인한 것처럼 표시하거나 원래 작업을 자동 완료하지 않는다.
5. 같은 묶음을 다시 내려받아도 확인 이력은 유지한다. 다른 내용은 다른 묶음이며 과거 확인을 현재 기록에 전파하지 않는다.
6. 외부 사이트 열기는 확인된 루트 URL만 사용한다. 실제 접수·수정 요청, 로그인 자동화, 비밀키 설정은 추가하지 않는다.
7. 실제 앱 브라우저 회귀로 기간·동 선택, 전체 건수·ZIP 다운로드, 취소·재시도·새로고침·계정 전환·권한·다중 탭 CAS·수동 확인과 원본 불변을 검증한다.

## 4. 통합·검증·배포

1. 앱/SW v67-roadlighting, 새 로컬 자산을 원자적 shell cache에 포함하고 CI에 연계 브라우저를 추가한다.
2. 독립 규격 검토 → 코드/동시성 검토 → 지적 수정 → 새 회귀로 확인한다.
3. `node scripts/check.mjs`, 연계·기존 대장/업무·출력 브라우저, 전체 CI를 통과한다.
4. v61 WIP를 보존하며 변경한 파일/최소 hunk만 기본 폴더에 동기화하고 해당 폴더의 검사도 실행한다.
5. 기존 배포 경로로 게시한 뒤 실제 공개 자산 버전·해시·연계 화면과 합성 내보내기를 확인한다. 실서비스 등록 성공으로 주장하지 않는다.
