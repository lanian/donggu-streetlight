/* 주민 신고 페이지 설정 — 이 파일만 바꾸면 됩니다. index.html은 손대지 않아도 돼요.
   backend: "firestore" 로 바꾸고 firestore 항목을 채우면 접수가 바로 서버에 저장됩니다.
            비워 두면(null) 문자·이메일로 보내는 방식으로 동작합니다. */
window.REPORT_CONFIG = {
  org: "전남광주통합특별시 동구청",          // 안내 문구에 표시되는 기관명
  dept: "가로등 담당 부서",            // 담당 부서명
  phone: "062-000-0000",             // 전화 접수 번호 (안내용)
  sms: "",                           // 문자 접수 번호 (예: "01000000000"). 비우면 문자 버튼이 숨겨져요
  mail: "",                          // 이메일 접수 주소. 비우면 이메일 버튼이 숨겨져요
  backend: null,                     // null | "firestore"
  firestore: { projectId: "", apiKey: "", collection: "citizen_reports" },   // 직원 앱의 "QR 신고 가져오기"도 이 값을 써요 (Google 로그인 필요)
  privacyDays: 90,                   // 연락처 보관 기간 안내(일)
  maxPhotoKB: 150
};
