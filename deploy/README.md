# 정적 앱과 Firebase 배포

정적 앱은 GitHub Pages·nginx·IIS에 배포할 수 있습니다. 직원 공유 DB, 공개 신고 게이트웨이, 서버 감사·보관 작업은 Firebase에 별도로 배포합니다. **이 저장소 변경 과정에서 실제 Firebase 프로젝트·App Check·서버 비밀값·예약 작업을 운영에 설정하거나 배포하지 않았습니다.**

## 공개할 파일

[Pages workflow](../.github/workflows/pages.yml)는 다음 목록만 공개합니다. 기관 웹서버에도 같은 목록을 사용합니다.

```text
index.html
sw.js
manifest.webmanifest
firebase-config.js
security.js
app/
data/
icons/
report/
seed/
vendor/
```

새 공개 디렉터리를 만드는 예시입니다.

```bash
DG_PUBLIC_DIR="$(mktemp -d)"
cp index.html sw.js manifest.webmanifest firebase-config.js security.js "$DG_PUBLIC_DIR/"
cp -R app data icons report seed vendor "$DG_PUBLIC_DIR/"
```

이 디렉터리의 내용만 웹 루트에 전달합니다. `functions/`, `scripts/`, `docs/`, `deploy/`, Firebase 규칙·설정·인덱스, 테스트 도구, 자격증명·비밀값은 공개 앱 파일 목록에 없습니다. `data/`·`seed/`는 공개 파일이므로 직원 연락처·운영 백업을 여기에 넣지 않습니다.

Firebase 웹 앱 설정은 클라이언트가 읽는 공개 설정입니다. 서비스 계정 키·서버 비밀값은 `firebase-config.js`, `report/config.js`나 저장소에 넣지 않습니다.

## 기관 웹서버

- HTTPS를 구성하고 Firebase Auth의 승인된 도메인, App Check 도메인, 신고 서버의 허용 origin에 실제 주소를 맞춥니다.
- [nginx 예시](nginx.conf)는 `http {}` 안에 포함하는 형태입니다. 도메인·인증서·공개 디렉터리를 바꿉니다. MIME 목록을 유지하고 manifest는 `application/manifest+json`, JavaScript는 JavaScript MIME으로 제공합니다.
- [IIS 예시](web.config)는 공개 사이트 루트에 별도로 둡니다. HTTPS 바인딩과 URL Rewrite 모듈을 준비합니다. 저장소의 나머지 `deploy/` 파일을 함께 공개할 필요는 없습니다.
- HTML·앱 스크립트·서비스 워커·설정은 재검증하도록 제공하고 `nosniff` 등 예시의 헤더를 유지합니다. `no-cache`는 즉시 강제 새로고침을 뜻하지 않으며 앱의 업데이트 확인 절차가 적용됩니다.
- 하위 경로에 배포할 때는 서버의 location·별칭·manifest·서비스 워커 범위와 신고 URL을 함께 확인합니다. 예시 nginx 설정은 루트 경로 기준입니다. 새 주소를 확정한 뒤 QR을 인쇄하고, 기존 QR의 주소를 유지하거나 이전 안내를 준비합니다.

기본 OSM 타일은 서비스 워커에서 가로채거나 일괄 다운로드하지 않습니다. 별도 지도 제공기관은 `app/map-config.js`의 이용 허가·도메인 제한 키·오프라인 허용 설정을 확인합니다.

## Firebase 운영 준비

1. 운영할 프로젝트에 Firestore와 Google 로그인을 준비하고 실제 공개 도메인을 등록합니다. 배포 전에 프로젝트 ID를 확인합니다.
2. `firebase-config.js`에 Firebase 웹 앱 설정을 넣습니다. `null`이면 기기 체험 모드입니다. 값이 있으나 연결에 실패하면 오류·재시도 화면을 표시하며 체험 모드로 자동 전환하지 않습니다.
3. `firestore.rules`와 `firestore.indexes.json`을 배포합니다. `firebase.json`이 두 파일을 가리킵니다. 인덱스가 준비된 뒤 시설별 이력·사진·작업 이력과 기간 조회를 확인합니다.
4. 운영자가 실제 Auth UID를 확인하고 초기 관리자 설정 계획을 실행합니다. 기본 명령은 서버에 연결하거나 쓰지 않습니다.

```bash
node scripts/admin-setup.cjs --project PROJECT_ID --uid VERIFIED_UID
```

실제 관리자 지정은 운영자가 자격증명을 준비하고 같은 명령에 `--apply`를 추가할 때 수행됩니다. 기존 초기 설정이 있으면 다시 선점하지 않습니다. 이후 직원은 접근 신청을 보내고 관리자가 승인합니다. 확인된 이메일의 초대 코드 발급·수락에는 Functions가 필요합니다.

5. Functions를 사용할 경우 서버 의존성을 설치하고, `functions/.env.example`을 참고해 `PUBLIC_REPORT_ORIGINS`를 실제 신고 origin 목록으로 설정합니다. `REPORT_RATE_SECRET`은 Firebase Secret Manager에 보관합니다. App Check를 등록하고 실제 토큰 검증을 준비합니다.
6. 아래 명령은 운영자가 확인한 프로젝트에 실행하는 **배포 예시**입니다. 코드 검사나 Pages 배포가 이 명령을 대신 실행하지 않습니다.

```bash
npm ci --prefix functions --include=optional --ignore-scripts --no-audit --no-fund
npx firebase-tools@15.34.1 functions:secrets:set REPORT_RATE_SECRET --project PROJECT_ID
npx firebase-tools@15.34.1 deploy --only firestore:rules,firestore:indexes,functions --project PROJECT_ID
```

Functions 런타임은 Node.js 22, 지역은 `asia-northeast3`입니다. 직원 앱에서 서버 호출을 쓰려면 `functionsEnabled`, `functionsRegion`, `appCheckSiteKey`를 설정합니다. 주민 신고는 `report/config.js`의 `backend: "gateway"`, `gatewayUrl`, App Check와 같은 프로젝트의 Firebase 웹 앱 설정을 연결합니다. `backend: "firestore"` 직접 접수는 지원하지 않습니다.

서버 배포 후 공개 접수·초대·감사 트리거·만료 정리 예약 작업의 실제 실행과 로그를 확인합니다. 예약 함수와 클라이언트 설정만으로 과거 문서에 만료가 생기지는 않으므로 필요한 경우 보관 기간 이관 계획도 검토합니다. [서버 운영 안내](../docs/security-operations.md)에 상세 경계를 정리했습니다.

## 로컬·CI 검사

CI는 앱·브라우저 검사에 Node.js 24, Functions·에뮬레이터 검사에 Node.js 22를 사용합니다. 앱 회귀는 외부 패키지 없이 실행하며, 서버 검사는 `functions` 의존성이 필요합니다. 아래 첫 명령은 Node.js 24에서, 서버 명령은 Node.js 22에서 실행합니다.

```bash
node scripts/check.mjs
npm ci --prefix functions --include=optional --ignore-scripts --no-audit --no-fund
npm test --prefix functions
```

Firestore 규칙과 실제 서버 핸들러의 로컬 검사는 Java 21과 npm이 필요합니다. 저장소 루트의 Bash에서 실행합니다.

```bash
DG_TOOLS_DIR="$(mktemp -d)"
npm install --prefix "$DG_TOOLS_DIR" --no-audit --no-fund --ignore-scripts \
  firebase-tools@15.34.1 @firebase/rules-unit-testing@3.0.3 firebase@10.12.2
NODE_PATH="$DG_TOOLS_DIR/node_modules" \
  "$DG_TOOLS_DIR/node_modules/.bin/firebase" emulators:exec \
  --only firestore --project demo-donggu-streetlight \
  "node scripts/check-emulator.cjs"
```

에뮬레이터는 `127.0.0.1:8089`를 사용합니다. `check-emulator.cjs`는 규칙 검사와 서버 핸들러 검사를 각각의 `demo-*` 프로젝트로 순서대로 실행하며 loopback 에뮬레이터가 없으면 실패합니다. 운영 DB에는 연결하지 않습니다. 서버 핸들러 검사는 로컬 권한·트랜잭션을 확인하며 실제 Firebase 인증/App Check 전송 계층과 예약·이벤트 전달까지 검증하지는 않습니다.

브라우저 검사는 별도로 설치한 Playwright와 Chromium을 사용합니다. 임시 로컬 서버와 독립 프로필을 사용하며 외부 서비스 요청은 검사 안에서 차단·대체합니다.

```bash
DG_BROWSER_DIR="$(mktemp -d)"
npm install --prefix "$DG_BROWSER_DIR" --no-audit --no-fund --ignore-scripts playwright@1.58.2
node "$DG_BROWSER_DIR/node_modules/playwright/cli.js" install chromium
export DONGGU_PLAYWRIGHT_MODULE="$DG_BROWSER_DIR/node_modules/playwright"
node scripts/field-browser-smoke.cjs
node scripts/integration-ui-smoke.cjs
node scripts/operations-browser-smoke.cjs
node scripts/brightness-smoke.cjs
node scripts/field-workflows-browser-smoke.cjs
node scripts/lighting-workflows-smoke.cjs
node scripts/review-fixes-smoke.cjs
node scripts/sheet-transitions-browser-smoke.cjs
```

이미 설치한 Chromium은 `DONGGU_CHROMIUM=/실제/실행파일`로 지정할 수 있습니다. Linux의 브라우저 시스템 의존성도 필요하며, CI는 Playwright 설치에 `--with-deps`를 사용합니다.

[검사 workflow](../.github/workflows/checks.yml)는 앱 회귀, 서버 단위 검사, 규칙·서버·복원 에뮬레이터를 실행합니다. [브라우저 workflow](../.github/workflows/browser.yml)는 위의 여덟 브라우저 검사를 실행합니다. [Pages workflow](../.github/workflows/pages.yml)는 두 workflow가 모두 성공한 뒤 공개 목록만 배포합니다. 실제 휴대전화 센서·야간 OCR·장시간 오프라인과 기관 서버의 HTTPS/MIME 응답은 배포 환경에서 따로 확인합니다.

## 업데이트와 이전

새 필수 앱 모듈은 서비스 워커의 앱 셸 목록과 공개 파일 목록에 함께 반영합니다. 사용자는 **새 버전 적용** 전에 미전송 작업·초안을 확인합니다. 서비스 워커가 다른 탭의 작성 내용을 자동으로 새로고침하지 않습니다.

운영 자료를 옮길 때는 [백업·복원 절차](../docs/operations-guide.md#7-백업복원이전)를 따릅니다. 백업은 초안·대기함·서버 설정 전체를 포함하지 않습니다. 사용자 UID와 권한, 신고 접수 원본, 감사·보관 정책은 대상 환경에서 별도로 확인합니다.

### 업무 기록 복원과 운영 상태

이번 버전의 Firebase 업무 복원에는 `previewOperationalRestore`·`applyOperationalRestore`, 운영 상태 화면에는 `getOperationalHealth`가 필요합니다. 규칙·인덱스와 Functions를 같은 버전으로 배포하세요. 서버 기능이 없거나 업무 묶음이 200문서·4MB를 넘으면 웹 복원은 일반 문서를 쓰기 전에 중단합니다. 미리보기는 15분간 유효하며 이후 자료가 바뀌면 다시 비교합니다.

큰 백업은 `functions/scripts/restore-backup.cjs`로 검증한 뒤 빈 업무 저장소에 이전합니다. 기본은 `--plan`이며 실제 반영에는 확인한 프로젝트·관리자 UID·파일·고정 작업 ID와 `--apply`가 필요합니다. 중단되면 같은 파일·작업 ID로 이어갑니다. 완료 전에는 일반 업무 접근이 잠기며 임의로 잠금을 지우지 않습니다. 구체적인 명령과 한도는 [서버 운영 안내](../docs/security-operations.md)에 있습니다.

공유 운영 상태는 서버에 기록된 마지막 성공·실패와 대기 건수를 표시합니다. 설정 존재만으로 정상 운영으로 판정하지 않으며 실제 접수·감사·보관 정리 실행이 없으면 확인 기록 없음으로 표시합니다.
