# 페이지만 구청 서버에 올리기 (DB는 Firebase)

앱은 정적 파일뿐이라 어떤 웹서버든 됩니다. 저장소 내용 전체(`index.html`, `sw.js`, `manifest.webmanifest`, `firebase-config.js`, `data/`, `vendor/`, `icons/`, `seed/`, `report/`)를 웹 루트에 복사하세요.

필수
1. **HTTPS** — 카메라·GPS·서비스 워커(설치·오프라인)는 https에서만 동작합니다.
2. `firebase-config.js` 채우기 (README "Firebase 적용") → Firebase 콘솔 Authentication → 승인된 도메인에 **구청 도메인 추가**.
3. `manifest.webmanifest`의 MIME을 `application/manifest+json`으로 (nginx.conf / web.config 참고).
4. `index.html`, `sw.js`, `firebase-config.js`는 캐시 금지(no-cache). 그래야 배포 즉시 반영됩니다.
5. 하위 경로(예: `https://www.donggu.kr/light/`)에 올려도 됩니다 — 모든 경로가 상대 경로이고, QR 신고 주소(`report/`)도 올라간 곳 기준으로 자동 계산됩니다. 이미 인쇄한 QR 라벨은 예전 주소를 가리키니 주소가 정해진 뒤에 인쇄하세요.

선택
- 저장소 내용만 복사하면 되므로 GitHub Actions로 구청 서버에 자동 배포(rsync/FTP)할 수도 있습니다.
- 내부에서만 접근하게 하려면 서버 방화벽에서 IP 제한을 거세요. 다만 점검자는 외부에서 쓰므로 보통 열어 둡니다.
