# v59 배포 후보 준비

공개 사이트를 변경하지 않고 개선 버전의 배포 후보를 준비했다. 기준 커밋은 `7df7ea53f646b45924511ebae08a1f3f6da619cd`이며, 후보에는 현재 작업 폴더의 미커밋 개선분이 포함된다.

## 원격 상태와 설정

- GitHub Pages 주소: `https://lanian.github.io/donggu-streetlight/`. Pages는 `main`의 workflow 배포이며 HTTPS를 사용한다.
- 조회 시점의 마지막 [Pages 배포](https://github.com/lanian/donggu-streetlight/actions/runs/42223787637)는 기준 커밋의 성공 결과다. 이 성공 결과는 로컬 v59 변경분의 GitHub CI 결과를 뜻하지 않는다.
- 로컬 설정의 직원 Firebase 프로젝트는 `donggu-light`다. 주민 게이트웨이 주소와 App Check 키는 비어 있으며 직원 서버 관리 호출도 비활성화되어 있다.
- 이 PC의 Firebase CLI에는 로그인 계정과 application-default 자격증명이 연결되어 있지 않다. 실제 Firebase 프로젝트의 함수·규칙·요금제·App Check 배포 상태는 확인하지 않았다.

## 배포 후보

| 파일 | 내용 |
|---|---|
| `_site/release-v59-20261107/donggu-streetlight-v59-app.zip` | Pages 공개 목록의 앱 파일 53개 |
| `_site/release-v59-20261107/donggu-streetlight-v59-server.zip` | Firebase 설정·규칙·인덱스와 Functions 런타임 파일 11개 |
| `_site/release-v59-20261107/release-manifest.json` | 각 파일의 SHA-256, 크기, 버전, 기준 커밋, 설정 준비 여부와 압축 파일 확인값 |

공개 앱 묶음에는 서버 소스·테스트·문서·자격증명을 넣지 않았다. 서버 묶음은 배포 시 설치할 잠금 의존성 목록과 `.env.example`을 포함하며 `node_modules`나 실제 비밀값은 포함하지 않는다. 압축 후 모든 항목의 SHA-256과 파일 수가 원본 목록과 같은지 검사했다.

서버의 `PUBLIC_REPORT_ORIGINS` 운영 값은 현재 Pages origin인 `https://lanian.github.io`로 준비할 수 있다. 전체 `/donggu-streetlight/` 경로를 origin 값으로 넣는 형식은 사용하지 않는다. `REPORT_RATE_SECRET`은 서버의 Secret Manager 설정 대상이며 공개 앱 파일에 넣지 않는다.

## 런타임 확인

앞선 Node 24·Java 24 결과에 이어 CI와 같은 주요 버전의 별도 런타임으로 검사했다. 시스템의 Node/Java 설정은 바꾸지 않고 임시 폴더의 검증된 공식 배포 파일을 사용했다.

| 환경·검사 | 결과 |
|---|---:|
| Node.js `22.23.4`: Functions 단위 검사 | 9개 통과 |
| Node.js `22.23.4`·Temurin Java `21.0.13`: Firestore 규칙 | 42개 통과 |
| 같은 환경: 서버 처리 | 7개 통과 |
| 같은 환경: 업무 복원 | 8개 통과 |
| 묶어 둔 공개 앱의 현장·개인정보·주민 신고·오프라인 브라우저 검사 | 4개 흐름 통과 |

에뮬레이터 원본 출력은 후보의 `validation/emulator-node22-java21.log`에 보관했다. 실제 운영 서버의 인증·App Check 전달과 예약 작업이 동작한다는 증거는 아니다.

## 남은 운영 연결

주민용 설명과 첫 단계는 [쉬운 시작 안내](../deploy/START_HERE.md)에 정리했다. 현재 코드의 App Check 초기화는 reCAPTCHA v3 방식이므로 실제 등록한 제공자와 클라이언트 설정을 함께 확인해야 한다. Firebase는 새로운 통합에 reCAPTCHA Enterprise를 권장한다. [Firebase 제공자 안내](https://firebase.google.com/docs/app-check/web/recaptcha-provider?hl=ko)

Firebase 계정 연결 후 기존 프로젝트의 요금제·함수·App Check 설정을 확인하고, 배포한 서버 주소와 허용 origin·서버 비밀값을 연결한다. 그다음 정상 접수·실패·중복 재시도·직원 신고함 이관을 운영 환경에서 확인한다. 새 접수 경로가 준비된 상태에서 규칙과 주민 앱을 전환한다. 현재 후보의 빈 설정을 그대로 게시하면 주민 화면은 접수 준비 중으로 남는다.
