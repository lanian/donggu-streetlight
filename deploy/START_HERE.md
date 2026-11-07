# 주민 신고를 실제로 받으려면

앱 화면과 접수 프로그램은 준비했습니다. 다음 단계는 주민이 보낸 신고를 인터넷에서 받아 저장하는 창구를 연결하는 일입니다.

**주민이 신고 작성 → 인터넷 접수창구가 저장 → 직원 신고함에서 확인**

## 제가 물었던 두 가지

| 표현 | 쉬운 뜻 |
|---|---|
| 게이트웨이 URL | 신고를 받을 인터넷 접수창구의 주소 |
| App Check 사이트 키 | 우리 신고 화면에서 온 요청인지 확인하는 설정값. 무작위 요청을 줄이는 데 사용 |

이 값을 지금 알고 계실 필요는 없습니다. Firebase 설정을 진행하면서 확인하는 값입니다. App Check는 정상 앱의 요청을 확인하는 장치이며 모든 스팸을 완전히 막는다는 뜻은 아닙니다. [Firebase App Check 안내](https://firebase.google.com/docs/app-check/web/recaptcha-provider?hl=ko)

## 지금 하실 일 하나

1. [동구 가로등 Firebase 프로젝트 열기](https://console.firebase.google.com/project/donggu-light/overview)를 누릅니다.
2. 이 프로젝트를 만든 Google 계정으로 로그인합니다.
3. `donggu-light` 프로젝트가 보이는지만 확인합니다.

보이면 **“프로젝트 보여”**, 안 보이면 **“프로젝트 안 보여”**라고 알려주시면 됩니다. 다음 설정은 그 화면에서 하나씩 안내할 수 있습니다. 키나 서버 주소부터 찾을 필요는 없습니다.

## 비용과 현재 상태

로컬 검사와 배포 파일 준비는 운영 요금제를 변경하지 않았습니다. 현재 프로그램의 접수 서버를 실제 Firebase에 배포하려면 Blaze 요금제 연결이 필요합니다. 요금제 연결 여부는 실제 운영 전에 결정해야 하며, 이번 작업에서 카드 등록이나 요금제 변경은 수행하지 않았습니다. [Firebase 서버 배포 안내](https://firebase.google.com/docs/functions/get-started?hl=ko#deploy-functions-to-a-production-environment)

현재 개선 버전은 접수 서버 연결 전까지 **접수 준비 중**으로 표시합니다. GitHub에 공개되어 있는 이전 버전과 이 PC의 개선 버전은 별개이며, 이번 작업에서 공개 사이트를 변경하지 않았습니다.

## 준비해 둔 파일

- 앱 배포 후보: `_site/release-v59-20261107/donggu-streetlight-v59-app.zip`
- 서버 배포 후보: `_site/release-v59-20261107/donggu-streetlight-v59-server.zip`
- 파일별 확인값: `_site/release-v59-20261107/release-manifest.json`

이 파일들은 설정 확인을 위한 후보입니다. 실제 주민 접수를 열기 전 접수 서버·스팸 방지 설정과 정상 접수 여부를 확인합니다. 자세한 개발·배포 절차는 [배포 안내](README.md)에 있습니다.
