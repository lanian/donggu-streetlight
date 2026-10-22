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

## 로컬 검사 범위

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
