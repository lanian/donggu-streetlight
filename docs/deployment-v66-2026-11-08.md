# v66 보고서 출력 배포 기록

- 배포 후보 커밋: `fd16402537b78b91a83c005346cdc05b6451840d`
- 앱·서비스 워커: `v66-reports`
- 공개 주소: https://lanian.github.io/donggu-streetlight/
- [배포 파이프라인](https://github.com/lanian/donggu-streetlight/actions/runs/42433151849)
- 구현·검증 범위: [v66 보고서 출력](release-v66-2026-11-08.md)

운영 v65를 기준으로 분리한 `E:\Projects\streetlight-release-v63-20261108`에서 보고서 출력 변경만 커밋했다. v61 유지보수 개발분은 이 폴더에 보존한다. Firebase·주민 신고·지도 설정과 Firestore 규칙은 이전 배포와 동일하며 서버 배포는 하지 않는다.

## 배포 전 확인

- 배포 후보 Node 검사 419개, v61 개발 폴더 Node 검사 507개 통과.
- 두 폴더에서 공통 출력 수명주기 15개와 실제 앱 출력 15개 시나리오 통과. 기존 사진 120장 전체 출력·시설 업무 흐름·데스크톱·다크 모드 검사 통과.
- Firebase와 외부 요청을 차단한 합성 자료 PDF 5종·23쪽 확인. 메모 원문 20개·기록 20건·불량 8종·사진 8종 보존. 빈 쪽·잘림·캡션 분리 없음. QR 30mm 설정은 PDF에서 약 29.997mm.
- PDF 비교: 기간 13→10쪽, 사진 4→2쪽, 현황 3→2쪽. 시설 이력서는 좁은 내용 열과 긴 메모 분할을 개선해 13→7쪽. QR 24개는 안내만 남던 첫 쪽을 제거해 2쪽.
- 임시 검증 자료: `D:\Temp\streetlight-v66-report-qa\after-final\content-validation.json` 및 같은 폴더의 PDF·PNG. 실제 프린터·운영 계정 검증과 구별한다.

## 공개 배포 확인

파이프라인 `42433151849`는 앱 검사·서버/권한 규칙 검사·브라우저 41종·Pages 배포를 모두 통과했다. 공개 페이지에서 `v66-reports`를 확인했고, index·직원 앱·공통 출력 JS/CSS·서비스 워커·업무 연결 모듈 등 지정 8개 자산의 SHA-256이 커밋의 Git blob과 모두 일치했다. Windows 작업 폴더의 CRLF와 공개 LF를 혼동하지 않도록 Git 원문을 기준으로 비교했다.

공개 사이트에서도 Firebase 설정을 null로 가로채고 외부 호스트·서비스 워커를 차단한 독립 브라우저로 검증했다. 합성 점검 3건(정상 포함), 사진 3장, 긴 메모 1,437자 전체를 보존했고, 출력 1회·`dg-report` 서식·임시 출력 정리를 확인했다. 원래 화면·초안·History·스크롤도 유지됐다. 브라우저 오류는 없었으며 실제 운영 자료는 사용하지 않았다.

공개 검증 기록은 `D:\Temp\streetlight-v66-public-print-verification.json`, 합성 출력은 `D:\Temp\streetlight-v66-public-print-fixture.pdf`에 보관한다. 기존 앱에서는 **새 버전 적용**으로 갱신한다.
