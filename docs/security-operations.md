# 서버 운영 기능과 접근 경계

## 구현과 실제 운영 연결의 구분

이 저장소는 서버 코드, 규칙, 초기 설정 도구와 로컬 검사를 제공합니다. 실제 Firebase 프로젝트 생성, Auth 제공자 설정, App Check 등록, 비밀값 발급, 서버 배포, 예약 작업 활성화는 수행하지 않았습니다. `firebase-config.js`와 `report/config.js`의 기본값은 비어 있으므로 현재 사이트는 체험 모드이며 신고 접수를 성공으로 표시하지 않습니다.

## 최초 관리자

임의 로그인 사용자의 `내가 관리자 되기`는 Firebase에서 사용할 수 없습니다. 프로젝트 운영자가 실제 Auth 계정의 UID를 확인하고 `node scripts/admin-setup.cjs --project PROJECT_ID --uid VERIFIED_UID`로 계획을 확인합니다. 이 명령은 SDK에 연결하지 않습니다. 승인된 운영자가 자격증명과 프로젝트를 준비하고 `--apply`를 추가해야 역할과 `meta/setup`이 한 transaction으로 저장됩니다. 이미 초기 설정이 있으면 재실행을 거부합니다. 도구를 공개 웹 페이지에서 실행하거나 서비스 계정 키를 저장소에 넣지 마세요.

아티팩트·체험 모드의 역할은 화면 구분이며 서버 인증을 대신하지 않습니다.

## 직원 신청과 초대

역할 없는 로그인 사용자는 자신의 `joinRequests/{uid}`에 가입 요청을 남길 수 있습니다. 이름·업무 설명은 본인만 수정할 수 있고, 관리자만 승인·반려합니다. 승인과 역할 생성은 원자적입니다. 관리자 화면의 신청 목록에서 승인할 수 있습니다.

`functionsEnabled: true`를 설정하고 서버 기능을 배포하면 확인된 이메일 한 명에 묶인 7일 초대 코드를 만들 수 있습니다. 코드는 1회 사용하고 서버에는 코드 해시만 저장합니다. 초대는 점검자 권한만 부여하며 관리자 역할을 덮어쓰지 않습니다. 메일은 자동 발송하지 않습니다. 관리자에게 코드를 표시하므로 수신자를 확인해 직접 전달해야 합니다. 초대 수락은 확인된 이메일과 로그인 UID를 검사하며 잘못된 코드 시도에도 빈도 제한을 적용합니다.

담당 동은 현장 목록을 좁히는 필터입니다. 모든 기존 시설·점검 문서의 접근을 담당 동별로 분리하는 서버 권한은 아닙니다. 작업 지시의 시작·완료는 해당 작업에 배정된 점검자에게만 허용합니다.

## Functions 준비

1. `cd functions && npm ci && npm test`로 서버 의존성과 검사를 준비합니다. Node 22 런타임을 사용합니다.
2. 프로젝트의 Google Auth, Firestore, Functions, App Check를 설정합니다. 서버 지역은 `asia-northeast3`입니다.
3. `PUBLIC_REPORT_ORIGINS`에 실제 신고 페이지 origin만 쉼표로 구분해 등록합니다. 허용 origin은 CORS 정책이며 인증·빈도 제한을 대신하지 않습니다.
4. `REPORT_RATE_SECRET`을 Firebase Secret Manager에 생성합니다. 이 값은 IP 주소를 원문으로 보관하지 않고 제한 키를 만드는 데 사용하며 웹 설정에 넣지 않습니다.
5. 운영자가 검토한 뒤 Firestore rules와 Functions를 배포합니다. App Check 검증은 실제 서버에서 기본 강제되며 로컬 에뮬레이터에서만 생략합니다.
6. 직원 설정에 `functionsEnabled:true`, `functionsRegion:"asia-northeast3"`, `appCheckSiteKey`와 Firebase 앱 식별 정보를 설정합니다. 직원 역할·신청 기능은 서버 미연결 시에도 규칙으로 제한된 직접 승인 경로를 지원하지만, 초대와 서버 감사·보존 작업은 Functions 배포가 필요합니다.

## 주민 접수 게이트웨이

`report/config.js`에서 `backend:"gateway"`, 배포된 `gatewayUrl`, `appCheckSiteKey`, Firebase 웹 앱의 `projectId/apiKey/appId`를 설정합니다. 임의 Firestore REST 접수는 rules에서 차단했습니다. 이전 `backend:"firestore"` 설정은 접수 준비 중으로 표시하므로 서버와 페이지를 함께 전환해야 합니다.

게이트웨이는 App Check, 요청 필드·크기·연락처 동의·위치를 검사합니다. 현재 빈도 제한은 IP 해시당 시간당 10건으로 트랜잭션에서 적용되며, 공유 네트워크 규모에 맞춰 운영자가 조정해야 합니다. 클라이언트가 만든 안정된 요청 ID와 내용 해시로 동일 요청 재시도를 합치며, 접수 시각·번호·보관 만료는 서버가 만듭니다. JPEG/PNG/WebP를 실제로 디코딩하고 방향 보정·축소·JPEG 재인코딩하여 EXIF 등 메타데이터를 제거합니다. 원격 이미지 URL은 받지 않습니다. App Check와 이 제한이 모든 남용을 제거하지는 않으므로 비용·오류율·함수 요청량을 관찰해야 합니다.

가져오기는 `reports/{reportId}` 생성과 원본의 `imported` 표시를 같은 Firebase transaction으로 처리합니다. 점검자는 내용·위치·동의를 바꾸거나 원본을 삭제할 수 없습니다. 원본 정리 시 연락처·사진만 삭제하고, 연결한 reports 문서의 `ext`와 원문·연락처·사진·좌표·만료의 동일성을 rules에서 검증합니다. 과거 부분 이관 뒤 관리자가 이미 내용을 수정한 대상 신고는 관리자가 이관 상태를 복구해야 합니다. 직원 Firebase와 신고 Firebase의 projectId가 다르면 오접속을 막기 위해 가져오기를 차단합니다. 같은 프로젝트의 신고를 다른 지원 백엔드로 가져오는 관리자 경로는 여러 저장소 사이의 원자성을 제공하지 않습니다.

## 검수와 사진

새 점검의 썸네일은 최대 6개이며 각 사진이 해당 점검·등·작성자에 연결돼 있어야 합니다. 사진·점검 batch의 최종 상태를 rules의 `getAfter()`로 확인합니다. 검수 시 원본 존재와 귀속을 다시 확인합니다. 기존 잘못된 데이터는 화면에서 안전하게 건너뛰고 검수를 막습니다. 관리자는 복구가 필요하지만 정상 사진으로 위장한 임의 URL을 표시하지 않습니다.

## 감사 기록

`recordAudit`는 문서 변경 이벤트의 인증 주체로 `auditEvents`를 작성합니다. 클라이언트는 감사 기록을 만들거나 수정·삭제할 수 없습니다. 이벤트 ID 해시를 문서 ID로 사용하여 중복 이벤트를 합칩니다. 기록에는 대상 경로·변경 필드·상태/역할 등 필요한 요약만 넣고 연락처·사진·위치·설명 원문을 복제하지 않습니다. 서버 쓰기는 인증 유형에 따라 서비스 주체로 보이며, 초대·승인 명령은 검증된 요청 UID를 별도 명령 감사에 기록합니다. 트리거의 전달·재시도 지연을 고려해 감사 알림과 실패 모니터링을 운영해야 합니다.

## 보관 기간과 공유 기기

`settings/operations.privacyDays`는 1~3650일, 기본 90일입니다. 공개 신고는 서버 정책과 주민 페이지에서 안내한 `privacyDays` 중 짧은 기간을 적용하므로 서버 설정만 늘려 동의한 기간을 연장하지 않습니다. 신규 접수는 `privacyExpiresAt`을 가지며 일일 예약 함수가 만료된 신고의 연락처·사진·위치·정확도·UA를 삭제합니다. 보관 기간은 신규 기록에 적용되며 기존 만료를 자동 연장하지 않습니다. 수동 직원 접수에는 서버 트리거가 만료를 붙입니다. 과거 문서는 `scripts/backfill-retention.cjs`의 기본 계획을 검토한 뒤 운영자가 `--apply`로 만료를 부여해야 합니다. 예약 주기 때문에 만료와 실제 정리 사이에 최대 하루 및 실행 지연이 있을 수 있습니다. 설명 자유문에 직접 기재된 개인정보는 자동 판별하지 않으므로 관리자가 별도로 정리해야 합니다. 내보낸 파일, 기기 캐시, 외부 백업까지 서버 작업이 삭제해 주지는 않으므로 별도 보관 규칙이 필요합니다.

Firebase의 기본값은 공유 PC 모드(`window.DG_DEVICE_TRUSTED=false`)입니다. 공유 모드 Auth는 `session`, 전용 기기는 `local`로 설정합니다. Firestore 영속 캐시는 전용 기기를 명시적으로 선택한 경우에만 켭니다. 저장 방식 변경은 미전송 작업이나 초안을 먼저 정리해야 하며, 공유 PC로 변경할 때 기존 영구 캐시와 완료된 기기 작업을 정리합니다. 전용 기기는 오프라인 작업 복구를 위해 로그아웃해도 캐시가 남을 수 있으므로 기기 잠금·분실 대응 정책이 필요합니다. 브라우저의 다른 탭이 캐시 정리를 막으면 안내에 따라 사이트 데이터를 직접 정리해야 합니다.

만료된 초대 코드의 이메일과 임시 빈도 제한 키도 같은 예약 작업에서 정리합니다. 직원 계정·역할은 업무 계정 관리 대상이므로 이 신고 보관 작업이 삭제하지 않습니다.

## 관리자 업무 복원과 대량 이전

보수 작업·재고·처리 이력은 일반 클라이언트의 문서별 복사로 복원하지 않습니다. `previewOperationalRestore`와 `applyOperationalRestore` callable은 관리자 역할을 서버 트랜잭션 안에서 다시 확인하고, App Check를 적용합니다. 일반 업무의 revision·사진·담당자 규칙은 완화하지 않습니다. Functions가 연결되지 않은 Firebase에서는 해당 업무가 들어 있는 파일의 복원을 **시작하기 전에** 차단합니다.

웹 복원은 한 묶음 **200문서·4MB**까지 원자적으로 처리합니다. 작업·재고뿐 아니라 관련 사진·신고·점검·재확인 관찰이 포함될 수 있어 이 문서 수도 한도에 들어갑니다. 미리보기는 15분 유효하며 파일 내용, 대상의 현재 문서·이력 해시와 복원 관리자를 고정합니다. 적용 전 대상이 변경되면 다시 검토해야 합니다. 같은 작업 ID·같은 내용의 완료 재시도는 영수증만 반환하여 나중의 수정을 덮어쓰지 않습니다.

복원은 스냅샷을 검증해 저장하며 검수·출고 명령을 다시 실행하지 않습니다. 작업의 전체 revision 이력·최종 상태·인정 비용과 재고의 전체 입출고 이력·수량이 일치해야 합니다. 누락 사진이나 불완전 이력은 적용 전에 거절합니다. 원래 `createdBy`, `updatedBy`, 처리 이력의 `by`는 보존하고, 복원한 관리자와 원작성자의 관계는 서버 전용 `restoreOperations`에 따로 기록합니다.

기존 불변 처리 이력은 동일한 내용일 때만 건너뜁니다. 같은 ID의 다른 이력은 덮어쓰지 않습니다. 보수·재고·재확인 업무의 기존 문서는 더 높은 revision의 스냅샷으로만 조건부 덮어쓰기가 가능하며, 과거 revision으로 되돌리는 기능은 제공하지 않습니다. 여러 컬렉션을 순서대로 받은 예전 JSON 백업은 단일 시점 스냅샷이 아니므로 업무 도중 만들어 이력과 상태가 엇갈린 파일은 복원이 거절될 수 있습니다.

한도를 넘는 초기 이전에는 저장소 루트에서 다음 관리자 도구를 사용합니다. 실제 운영 자격증명은 저장소에 넣지 않습니다.

```bash
node functions/scripts/restore-backup.cjs --project PROJECT_ID --uid VERIFIED_ADMIN_UID --file BACKUP.json --operation restore-20261025 --plan
node functions/scripts/restore-backup.cjs --project PROJECT_ID --uid VERIFIED_ADMIN_UID --file BACKUP.json --operation restore-20261025 --apply
```

기본은 계획만 출력하는 `--plan`입니다. 도구는 명시한 관리자 1명만 있고 업무·사진·신고 저장소가 비어 있는 초기 대상에서 실행합니다. 최대 256MB 파일·100,000문서를 지원하며, 웹과 같은 스키마·연결·이력 검증을 먼저 끝낸 뒤 최대 200문서·4MB 묶음으로 처리합니다. 운영 중인 대상에 대한 대량 덮어쓰기는 지원하지 않습니다. 먼저 업무 묶음을 이전하고, 필요하면 남은 일반 기록과 사용자 역할을 별도로 복원합니다. CLI는 사진을 생략한 파일의 누락 증빙을 만들어 내지 않습니다.

대량 적용이 시작되면 `meta/operationalRestore.status=partial`이 되어 클라이언트 업무 접근을 일시 차단합니다. 각 묶음의 영수증과 완료 수를 기록하며, 전체 대조가 끝나야 `applied`로 변경하고 접근을 되살립니다. 중간 실패는 **부분 완료**입니다. 같은 파일·프로젝트·관리자·operation ID로 `--apply`를 재실행하면 완료 묶음의 내용까지 대조하고 이어갑니다. 이미 완료된 작업의 재실행은 영수증만 확인합니다. 실패 뒤 잠금이나 영수증을 임의로 삭제하지 말고 실패 원인을 해결해 같은 작업을 완료하세요. 작업 중 다른 자격증명으로 문서를 수정하거나 직원 역할을 추가하면 재개가 거절될 수 있습니다.

`restoreOperations`, 하위 묶음 영수증, `systemHealth`, `lightingOperations`, `lightingWorkflowOperations`는 사용자 JSON에서 직접 복원하지 않습니다. `lightingRuns`와 처리 이력의 원본은 서버가 검증한 복원 대상에 포함할 수 있지만 기존 불변 이력을 교체하지 않습니다.

로컬 에뮬레이터에서는 `FIRESTORE_EMULATOR_HOST=127.0.0.1:8098` 같은 loopback 주소와 `--emulator`를 함께 명시합니다. 이 구현 작업에서는 실제 운영 Firebase로 이전하거나 배포하지 않았습니다.

## 운영 상태와 신규 업무 스키마

`getOperationalHealth` callable은 로그인한 직원 역할을 서버에서 확인한 후 안전한 요약을 반환합니다. 최근 접수·감사·보관 정리 성공/실패 시각과 오류 코드, 정리 건수, 미이관 신고 건수, 미완료·기한 초과 작업 수를 제공합니다. 관리자는 전체 작업을, 점검자는 본인 작업 범위를 받으며 `scope`에 표시합니다. 연락처·이메일·신고 원문·위치·원본 사진은 반환하지 않습니다.

`systemHealth`는 서버만 읽고 쓰며 클라이언트가 정상 상태를 위조할 수 없습니다. 성공한 적이 없으면 `unknown`, 마지막 실패가 더 최근이면 `error`, 보관 정리가 36시간 넘게 성공하지 않았거나 만료 대기 자료가 남으면 `stale`입니다. 감사 성공 신호는 쓰기 집중을 줄이기 위해 최대 분당 한 번 기록합니다. 성공 시각은 마지막으로 관찰한 실행 결과이며 모든 외부 설정이 지금 정상임을 보증하는 진단은 아닙니다.

대량 이전 중에도 이 callable은 서버의 원래 직원 역할을 확인하여 `maintenance.active`, 작업 ID와 시작·갱신 시각을 조회할 수 있습니다. 클라이언트 역할 컬렉션이 잠겨 있어도 Firebase 인증이 있는 기존 직원은 이 경로로 이전 중임을 확인할 수 있습니다. 화면은 전체 업무 숫자를 정상 운영의 최신 확정값으로 사용하지 말고 이전 완료 안내를 우선 표시합니다.

신규 `reportEvents`는 관리자만 신고의 시설 연결 변경과 같은 트랜잭션에서 생성하며 수정·삭제할 수 없습니다. 원문·접수번호를 그대로 두고 `reports.linkRevision/linkEventId/linkUpdatedBy`로 연결 이력을 확인합니다. 다른 활성 작업에 묶인 신고를 새 작업으로 이동하거나 다른 시설로 바꾸는 쓰기는 거절합니다.

`lightingTasks`는 직원이 본인에게 생성하거나 관리자가 다른 직원에게 배정할 수 있습니다. 배정된 직원 또는 관리자가 갱신하고, 완료에는 시간대·확인 시각·야간 확인·위치 범위가 맞는 관찰 근거가 필요합니다. 완료/취소의 재개는 관리자만 가능합니다. `lightingRuns`는 크기를 제한한 불변 검토 실행 이력입니다. 두 컬렉션의 변경과 `lightingWorkflowOperations` 영수증은 원자적으로 기록합니다. 외부 광원 반입의 출처 6개 필드는 함께 저장하며, 최초 반입은 관리자만 미확인 상태로 생성할 수 있습니다. 반입했다고 점등을 확인한 것으로 만들지 않습니다.

## 로컬 검사 명령

앱 VM 회귀는 `node --test scripts/tests/*.test.cjs`, 서버 입력·실제 이미지 디코딩은 `npm test --prefix functions`로 실행합니다. Firestore 에뮬레이터를 loopback에서 시작한 뒤 `FIRESTORE_EMULATOR_HOST`를 그 주소로 지정하고 `scripts/tests/firestore-rules.emulator.cjs` 및 `functions/test/server.emulator.cjs`를 실행합니다. 두 파일은 운영 DB 주소로 실행하지 않도록 제한합니다.

규칙 검사는 권한 없는 최초 관리자 등록 차단, 사진 6장의 점검 생성·검수·동일 재시도, 원본 신고 가져오기, 작업의 담당자/상태/재고 경계를 확인합니다. 작업의 조치 전·후 각 6장, 재고 10개, 연결 신고 20개, 시설 상태와 이벤트를 하나의 transaction에 넣는 경로도 포함합니다. 한 검수의 재고 변경 ID 수는 이전 출고의 반납까지 합쳐 지원 한도 안에 있어야 합니다.

서버 검사는 실제 Functions 핸들러와 Admin SDK를 로컬 Firestore에 연결해 실행합니다. 사전 지정 관리자 CLI의 동시 실행, 초대 이메일·1회 사용, 가입 승인, 동시 신고 재시도·빈도 제한, 감사 중복 처리, 만료 정리를 확인합니다. 인증/App Check 전송 계층과 실제 예약·이벤트 전달은 배포된 Firebase 런타임에서 별도 운영 검증이 필요합니다.

## 근거 문서

- [Firestore 트리거와 인증 문맥](https://firebase.google.com/docs/functions/firestore-events)
- [App Check 서버 검증](https://firebase.google.com/docs/app-check/custom-resource-backend)
- [Callable App Check 강제](https://firebase.google.com/docs/app-check/cloud-functions)
- [Firestore 영속 캐시와 신뢰 기기](https://firebase.google.com/docs/firestore/manage-data/enable-offline)
- [Firebase Auth 세션 유지 방식](https://firebase.google.com/docs/auth/web/auth-state-persistence)
- [OWASP CSV Injection](https://community.owasp.org/attacks/CSV_Injection)
