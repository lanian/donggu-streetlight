# 지도 전용 v63 공개 배포 결과

2026-11-08에 [동구 가로등 앱](https://lanian.github.io/donggu-streetlight/)의 지도 전용 `v63-vworld` 배포를 완료했다.

- 배포 커밋: `5d6c95012dafcd23305aec13e4a3b3a5df508f61`.
- [GitHub Pages 배포 실행](https://github.com/lanian/donggu-streetlight/actions/runs/42385756163): 앱·Firestore·브라우저·배포 작업 모두 성공.
- 배포 작업 공간: `E:\Projects\streetlight-release-v63-20261108`, 브랜치 `release/v63-vworld`. 배포 후 작업 공간은 깨끗하다.
- 기존 `E:\Projects\streetlight`의 v61 개발 작업은 그대로 보존한다.

## 배포 범위와 서버 정합성

운영 기준 v60(`d0734dd`)에 지도 모듈·CSS·지도 선택과 오류 안내·공개 개발키·관련 검사를 추가했다. 앱과 서비스 워커 버전은 모두 `v63-vworld`다. 일반 지도·위성/항공사진·사진＋도로명을 전환할 수 있고 마지막 표시 선택은 브라우저에 기억한다.

v61 전체를 Pages에만 게시하면 기존 운영 규칙에서 신규 작업·점검 저장이 거부될 수 있다. 이 PC에는 Firebase CLI 로그인 계정이 없어 새 규칙을 함께 배포할 수 없으므로, v61 유지보수 기능을 이번 배포에서 제외했다. Firebase 설정·규칙·인덱스·Functions·업무 저장 코드·대장은 v60 기준과 동일하다. `functionsEnabled:false`와 주민 접수 준비 상태를 유지한다. v61은 규칙을 함께 배포해야 하며 서버 복원을 활성화할 때 새 복원 검증 코드도 필요하다.

## 확인 결과

| 범위 | 결과 |
|---|---|
| 독립 배포본 코드 검사 | 로컬·GitHub 모두 406/406 통과 |
| 전체 브라우저 검사 | GitHub의 38개 스크립트 모두 성공 |
| 서버·권한 규칙 검사 | Functions 9개, 규칙 46개, 서버 처리 7개, 운영 복원 8개 통과 |
| 공개 파일 대조 | HTML·SW·직원 앱·지도 설정/모듈/CSS·PWA·입력 처리·Firebase/주민 설정 총 10개, 모두 HTTP 200 및 배포 소스와 해시 일치 |
| 공개 페이지의 실제 VWorld 영상 | Satellite 30건, Hybrid 15건 정상 이미지 응답, 비영상 응답·브라우저 오류 0건 |
| 지도 상태 | 두 영상 모드에서 위치·확대·시설 표시 유지 |

공개 페이지 브라우저 검사는 실제 게시 자산과 VWorld 네트워크를 사용했다. Firebase 설정만 독립 브라우저 안에서 `null`로 바꿔 체험 모드로 실행했다. 운영 설정 파일은 별도로 원본 해시 일치를 확인했으며 운영 계정 로그인이나 자료 쓰기는 수행하지 않았다. 실제 직원 인증·자료 저장, 현장 센서, 영상 전체 지역의 품질·촬영 시점, 키 만료·할당량까지 검증한 결과는 아니다.

로컬 전체 브라우저 첫 실행에서는 기존 다각형 검사의 클릭 좌표가 새 배경 선택기와 겹쳐 1종이 실패했다. 지도 제어기를 피하는 클릭임을 명시적으로 확인하도록 검사 좌표를 수정한 뒤 해당 10개 흐름이 통과했다. 다른 런타임 파일은 검사 전후 동일했다. 최종 GitHub 전체 실행은 수정된 커밋의 38종을 처음부터 실행해 모두 통과했다.

## 사용자 적용

기존 앱에서 미전송 작업·초안을 확인한 뒤 **새 버전 적용**을 실행한다. 지도 오른쪽 위 **지도 배경**에서 **위성·항공사진** 또는 **사진＋도로명**을 선택한다. 사진은 온라인으로 조회하며 서비스 워커나 출동 자료에 저장하지 않는다.

## 로컬 증거

- `D:\Temp\streetlight-v63-deploy-result.json`
- `D:\Temp\streetlight-v63-release-check.log`
- `D:\Temp\streetlight-v63-release-browser\final-results.json`
- `D:\Temp\streetlight-v63-public\results.json`
- `D:\Temp\streetlight-v63-public\public-satellite.png`
- `D:\Temp\streetlight-v63-public\public-hybrid.png`

지도 API 키의 실제 값은 이 기록에 포함하지 않는다.
