/* Hosted staff Firebase configuration. Localhost/loopback uses device demo storage below.
   These are public web-app identifiers; server credentials never belong in this file.
   Set null to use demo mode on a hosted copy. Claude artifacts use their own adapter. */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCi3DSZSxPcbIjPzJLmJ7ZYhYoLi3eJqeI",
  authDomain: "donggu-light.firebaseapp.com",
  projectId: "donggu-light",
  appId: "1:764961412270:web:f417d44a03ca3b38bf493f",
  functionsEnabled: false, // 무료(Spark): 서버 함수 없음. Blaze로 함수를 배포한 뒤 true
  functionsRegion: "asia-northeast3",
  appCheckSiteKey: ""
};
// A local checkout must not silently use the hosted organization's shared database.
(function () {
  const host = typeof location === 'object' ? String(location.hostname || '').toLowerCase() : '';
  if (host === 'localhost' || host.endsWith('.localhost') || host === '127.0.0.1' || host === '::1' || host === '[::1]') window.FIREBASE_CONFIG = null;
})();
/* 예:
window.FIREBASE_CONFIG = {
  apiKey: "AIza...",
  authDomain: "donggu-light.firebaseapp.com",
  projectId: "donggu-light",
  appId: "Firebase 웹 앱 ID",
  functionsEnabled: false, // 서버 함수 배포 후 true
  functionsRegion: "asia-northeast3",
  appCheckSiteKey: ""
};
*/
