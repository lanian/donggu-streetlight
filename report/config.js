/* 주민 신고 페이지 설정 — 이 파일만 바꾸면 됩니다. index.html은 손대지 않아도 돼요.
   backend: "official" — 운영서비스의 신고·처리현황 화면으로 연결하며 이 페이지는 접수하지 않아요.
            "gateway" — gatewayUrl·App Check를 채우면 별도 자체 서버가 접수해요(운영서비스 자동 등록 아님).
            null        — 문자·이메일 앱으로 보내는 방식(sms·mail 필요).
   이 파일을 바꾸면 sw.js의 VERSION도 올려야 설치된 기기에 반영돼요. */
window.REPORT_CONFIG = {
  org: "전남광주통합특별시 동구청",          // 안내 문구에 표시되는 기관명
  dept: "가로등 담당 부서",            // 담당 부서명
  phone: "",                         // 확인한 공식 전화번호만 입력
  sms: "",                           // 문자 접수 번호 (예: "01000000000"). 비우면 문자 버튼이 숨겨져요
  mail: "",                          // 이메일 접수 주소. 비우면 이메일 버튼이 숨겨져요
  backend: "official",               // "official"(운영서비스 화면) | null(문자·이메일) | "gateway"(자체 검증 서버)
  officialName: "동구 도로조명 관리시스템",
  officialUrl: "https://gjd.roadlighting.kr/slamp/repair/map",
  officialStatusUrl: "https://gjd.roadlighting.kr/slamp/repair/status",
  gatewayUrl: "",                   // 배포한 submitCitizenReport HTTPS URL
  statusUrl: "",                    // 배포한 citizenReportStatus HTTPS URL. 채우면 주민이 접수번호+확인 코드로 처리 단계를 볼 수 있어요
  appCheckSiteKey: "",              // Firebase App Check reCAPTCHA 사이트 키
  allowLocalGateway: false,          // 로컬 에뮬레이터 검사에서만 true
  firestore: { projectId: "donggu-light", apiKey: "AIzaSyCi3DSZSxPcbIjPzJLmJ7ZYhYoLi3eJqeI", appId: "1:764961412270:web:f417d44a03ca3b38bf493f", collection: "citizen_reports" },   // 직원 앱의 "QR 신고 가져오기"도 이 값을 써요 (Google 로그인 필요)
  privacyDays: 90,                   // 연락처 보관 기간 안내(일)
  maxPhotoKB: 150
};
