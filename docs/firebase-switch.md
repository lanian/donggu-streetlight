# 공유 운영 모드(Firebase) 전환 — 무료(Spark) 기준

체험 모드(기록이 기기마다 따로 남음)에서 모든 직원이 같은 기록을 보는 공유 모드로 바꾸는 순서예요. Firebase 콘솔 작업은 기관 Google 계정으로 직접 하고, 규칙·인덱스 배포와 최초 관리자 지정은 GitHub Actions의 **Firebase setup**으로 해요.

## 무료(Spark)에서 되는 것과 안 되는 것

| 기능 | Spark |
| --- | --- |
| 직원 로그인(Google), 공유 기록, 역할을 서버 규칙으로 강제 | 됨 |
| 접근 신청 → 관리자 승인 | 됨 |
| 신고함 수동 기록, 관리자 화면의 신고자 정보 수동 파기 | 됨 |
| 주민 신고 서버 접수·처리 상태 조회, 개인정보 자동 파기, 초대 코드, 서버 복원·운영 상태 | 안 됨(Functions·Blaze 필요) |

## 순서

1. **프로젝트 만들기:** console.firebase.google.com → 프로젝트 추가 → ID 확인(예: `donggu-light`) → Google 애널리틱스는 꺼도 돼요.
2. **Firestore:** 빌드 › Firestore Database → 데이터베이스 만들기 → **프로덕션 모드**, 위치 **asia-northeast3 (서울)**. 위치는 나중에 바꿀 수 없어요.
3. **로그인:** 빌드 › Authentication → 시작하기 → 로그인 방법 › **Google** 사용 설정. 설정 › 승인된 도메인에 `lanian.github.io` 추가.
4. **웹 앱 설정값:** 프로젝트 설정 › 일반 › 내 앱 › 웹(`</>`) 앱 추가 → 나오는 `firebaseConfig`의 `apiKey`, `authDomain`, `projectId`, `appId`를 전달 → `firebase-config.js`에 넣어 배포(공개해도 되는 값이에요).
5. **서비스 계정 키:** 프로젝트 설정 › 서비스 계정 › **새 비공개 키 생성** → 받은 JSON 전체를 GitHub 저장소 Settings › Secrets and variables › Actions › New repository secret, 이름 `FIREBASE_SERVICE_ACCOUNT`로 저장. 이 파일은 저장소·메일·메신저에 올리지 말고 저장 후 PC에서 지워요.
6. **규칙·인덱스 배포:** GitHub › Actions › **Firebase setup** › Run workflow → `project_id` 입력, `step: rules-and-indexes`. 인덱스는 만들어지는 데 몇 분 걸려요.
7. **최초 관리자:** 배포된 앱에서 관리자 Google 계정으로 한 번 로그인 → Firebase 콘솔 Authentication › 사용자에서 그 계정의 **UID** 복사 → Firebase setup을 `step: first-admin`, `admin_uid`에 UID로 실행. 한 번만 가능하고, 이후 직원은 앱에서 접근 신청 → 관리자가 사용자·권한에서 승인해요.
8. **(선택) 키 정리:** 설정이 끝나면 Google Cloud 콘솔 › IAM › 서비스 계정 › 키에서 이 키를 삭제하고 GitHub 비밀값도 지워도 돼요. 다시 필요하면 새로 만들면 돼요.

배포 단계에서 권한 오류가 나면 Google Cloud 콘솔 › IAM에서 그 서비스 계정(`firebase-adminsdk-…`)에 **Firebase 관리자** 역할을 추가하고 다시 실행해요.

## 체험 모드 기록 옮기기

체험 모드로 남긴 기록은 각 기기에만 있어요. 공유 모드로 바꾸기 **전에** 기록이 있는 기기마다 관리 현황 › 백업·이전 › 내보내기로 JSON을 받아 두고, 전환 후 관리자가 같은 화면에서 가져오기(미리보기 → 가져오기)를 해요. 같은 ID는 건너뛰므로 여러 기기 파일을 차례로 가져와도 돼요.

## 확인

- 직원 앱 첫 화면 위의 연결 표시가 "실시간"이고, 다른 기기에서 남긴 점검이 바로 보이는지
- 역할 없는 계정은 기록을 볼 수 없고 접근 신청 화면이 뜨는지
- 관리자 › 사용자·권한에서 점검자 지정 → 그 계정으로 점검 저장이 되는지
