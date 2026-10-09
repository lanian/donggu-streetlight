# 광주 동구 가로등·보안등 점검 서비스

광주광역시 동구의 가로등·보안등 현장 점검, 고장 관리, 주민 신고를 한 화면에서 처리하는 모바일 웹앱입니다.
단일 HTML 파일(`index.html`)로 되어 있으며, Claude 아티팩트 환경에서 공유 데이터베이스·사진 인식 기능과 함께 동작합니다.

## 화면 구성

| 탭 | 대상 | 주요 기능 |
|---|---|---|
| 현장 점검 | 점검자 | 고장·점검주기 경과 순 목록, 8항목 점검표, 등주 기울기 측정, 사진·메모, 점검 이력, 야간 차량 순찰 모드 |
| 관리 현황 | 담당 공무원 | 위치 분포도, 조치 필요 목록, 주민 신고 처리(접수→처리중→완료), 종류별·행정동별 현황, 밝기 예측·보완 검토, CSV 내보내기, 현장 등록(미등록 관리), 등 정보 수정 내역, 표찰 없는 등 관리 |
| 주민 신고 | 주민 | 문제 유형 선택, 표찰 스캔으로 번호 자동 입력, 사진 첨부, 내 신고 처리 결과 확인 |

## 표찰 기반 식별

동구가 등주에 부착한 표찰을 관리번호로 사용합니다. 표찰은 두 종류이며, 보안등 표찰의 동 이름은 법정동(산수동, 지산동, 충장로5가, 금남로2가 …)입니다.

| 종류 | 표찰 | 번호 형식 | 예 |
|---|---|---|---|
| 가로등 | 초록 머리띠 "가로등", 왼쪽 파란 세로 띠 "관리번호" | 도로명 + 번호-가지번호 (옛 표찰은 숫자만) | `지호로 65-5`, `140-8` |
| 보안등 | 파란 "보안등 고장신고" | 행정동 + 번호 | `산수동 642`, `지산동 118` |

- **QR 스캔** — 카메라로 표찰 QR을 비추면 해당 등의 상태·마지막 점검일·미처리 신고가 카메라 화면 위에 바로 표시됩니다.
- **사진 인식** — QR이 없거나 훼손된 경우 표찰 사진을 올리면 AI가 동 이름·번호·한전 전주번호(예: `9792C742`)를 읽습니다.
- 읽은 번호가 대장에 없으면 "미등록"으로 표시하고 신규 등록 양식으로 이어집니다.

## 야간 차량 순찰

차로 돌며 꺼진 등을 찾는 야간 순찰용 화면입니다(현장 점검 탭 → 야간 순찰). 동승자가 조작하는 것을 전제로 합니다.

- GPS 진행 방향 기준으로 앞쪽 140m·좌우 30m 안의 등이 가까운 순으로 큰 카드로 뜨고, 좌/우/정면과 거리를 표시합니다. 시속 40km에서 2초에 하나씩 지나가므로 버튼은 두 개뿐입니다: **꺼짐(고장)**, **어둡거나 깜빡임(점검필요)**. 기본으로 맨 위 등에 적용되고, 카드를 먼저 누르면 그 등에 적용됩니다. 마지막 표시 취소, 진동·음성 안내(조치 필요 상태인 등 접근 시), 화면 꺼짐 방지(Wake Lock), 일시정지를 지원합니다.
- 차가 25m 안으로 지나간 등은 자동으로 "지나간 등"에 들어가고, 표시하지 않은 등은 저장 시 **점등 확인**으로 남습니다(점검주기는 갱신하지 않음).
- 끝내면 요약(거리·시간·지나간 등·표시)과 표시한 등 목록을 확인하고 저장합니다. 표시한 등은 `inspections`에 `patrol:true` 기록이 생기고 상태가 바뀝니다. 순찰 자체는 `patrols/{auto}`에 경로·지나간 등·표시 목록으로 저장되어 관리 현황 "야간 순찰 기록"에서 경로 지도로 볼 수 있고, 등 상세에 "순찰 통과 날짜"가 표시됩니다.

## 등 정보 수정

등 상세 화면의 "등 정보 수정"(관리자 권한)에서 광원·등주·점멸기·전주번호·교체 연도·좌표·철거 여부·비고를 고칩니다. 좌표는 현재 위치로 바꾸거나 지도의 핀을 끌어 옮깁니다. 대장 원본(`data/lights.json`)은 바뀌지 않고 `lights/{id}`에 바뀐 값과 변경 이력(`edits`: 시각·수정자·항목별 이전값/변경값)이 쌓이며, 마지막 변경은 되돌릴 수 있습니다. 관리 현황의 "정보 수정된 등"에서 모아 보고 CSV로 내보내 도로조명 관리시스템 대장에 반영합니다.

## 밝기 예측·보완 검토

실측 조도가 없으므로 모델로 추정합니다. 대장에서 종류별 이웃 간격 분포를 구해(중앙값 약 20m) 상위 10% 간격을 검토 기준으로 삼고, 광원 종류(LED·CDM·나트륨·삼파장)와 상태(고장·수리중은 꺼짐)로 각 등의 유효 반경을 보정합니다. 기준값은 `LIGHT_MODEL`에 있습니다. 검토 방식은 두 가지입니다.

- **도로 따라 검토** — OpenStreetMap 도로 중심선(간선·주택가·생활도로·진입로·보행로)을 8m 간격으로 걸으며 합산 밝기가 약한 구간을 찾습니다. 고장·수리중 등의 영향을 받는 구간, 근처에 등이 전혀 없는 구간, 길이, 도로 등급 순으로 정렬하고 지도에 굵은 선으로 표시합니다. 공원·건물 너머의 등은 계산에 들어가지 않습니다.
  - 제외 대상: 아파트 단지·학교·대학·병원 부지 안(`landuse=residential`+`residential=apartments`, `amenity=school|university|college|hospital`), 숲·산·묘지·국립공원(`natural=wood|scrub`, `landuse=forest|cemetery`, `boundary=national_park`), 주차장 통로·사유지 진입로(`service=parking_aisle|driveway`, `access=private`). 이런 곳은 관리 주체가 다르거나 조명 대상이 아니므로 후보에서 뺍니다.
  - 90m 안에 등록된 등이 하나도 없는 구간(아파트 관리등·산길·농로일 가능성)은 기본으로 숨기고, 체크박스로 볼 수 있습니다.
- **등 간격으로 검토** — 도로망이 없을 때의 대체 방식. 이웃한 두 등의 간격이 기준을 넘거나 중간 지점이 약한 쌍을 후보로 뽑습니다. 도로 형상을 모르므로 공원·건물 너머의 쌍도 섞입니다.

두 방식 모두 보완 지점 좌표를 현장 등록 양식으로 넘기거나 CSV로 내보낼 수 있습니다. 현장 확인 순서를 정하는 용도입니다.

**도로망** — "도로망 불러오기"를 누르면 보는 사람의 브라우저가 Overpass API에서 동구 범위(`ROAD_BBOX`)의 도로와 단지·숲 영역을 한 번 받아(약 4MB) IndexedDB에 저장하고, 공유 데이터베이스가 있으면 `patrols/{auto}
  start, end, dist(m), by, passed[lightId…], marks[{id, code, result, at}], track[[lat,lng]…]

roads/part-N`(190KB 단위)과 `roads/meta`로 올려 다른 휴대폰은 다시 받지 않게 합니다. 도로 데이터 © OpenStreetMap contributors (ODbL).

## 데이터 구조

**대장(`data/lights.json`)** — 도로조명 관리시스템(getPoint.json)에서 변환한 동구 전체 등 5,553개. 컬럼형 JSON(`cols` + `rows`)으로 페이지와 함께 배포되며, 앱은 시작 시 이 파일을 읽습니다.

```
cols: id, lampId, label, code, kind(가로등|보안등|공원등|특이등), dong(법정동), num, road, main, sub,
      lat, lng, lampType, pole(등주), sw(점멸기), removed(철거), noPlate(표찰없음), dongGuess(동 추정)
```

**현장 기록(공유 데이터베이스)** — 대장은 그대로 두고 바뀌는 값만 저장합니다. 체험 모드에서는 같은 구조를 브라우저 localStorage에 둡니다.

```
lights/{id}        대장 id와 같은 키. status(정상|점검필요|고장|수리중), lastInspected, lastResult, updatedAt
                   표찰을 새로 단 경우: code, num/road/main/sub, plateFixed, plateFixedAt
                   정보 수정: lampType, pole, sw, poleNo, replacedYear, lat, lng, removed, removedAt, note,
                   edits[{at, by, changes[{f, from, to}], undone}] (최근 30건)
                   현장에서 발견한 미등록 등(id np-… / bd-… / gl-…): 전체 필드 + reg(미등록|대장반영|반려),
                   noPlate, lat, lng, acc, photo, note, foundAt, foundBy, linkedId(기존 등과 연결 시)

inspections/{auto}
  lightId, code, dong, date, checks{}, faults[], result, memo, tiltDeg, photo, inspector

reports/{auto}
  issue, location, dong, code, lightId, desc, photo, status(접수|처리중|완료),
  createdAt, updatedAt, reporterId

roads/part-N          OpenStreetMap 조각 { ways:[{id,name,type,sv,priv,pts:[[lat,lng],…]}], areas:[{t(apt|forest),name,pts}] }
roads/meta            ver(ROADS_VER), at, parts, count, areas, attribution — ver가 다르면 다시 받음
```

## 실행 환경에 대한 안내

`index.html`은 Claude 아티팩트 런타임(`window.claude.use("db")`, `"sample"`, `"user"`, `"downloads"`)을 통해 저장·인식 기능을 사용합니다.
GitHub Pages 등 일반 호스팅에서 열면 화면은 표시되지만 **오프라인 미리보기** 상태가 되어 점검 결과가 저장되지 않습니다.
독립 운영이 필요하면 `boot()` 함수의 `claude.use(...)` 부분을 Firebase/Supabase 등 다른 백엔드로 교체하면 됩니다.

이 저장소는 소스 관리·백업·협업 용도이며, 실제 운영은 공유된 아티팩트 링크에서 이루어집니다.

## 설정값

- `DUE_DAYS = 90` — 점검주기(일). 경과 시 "점검주기 경과" 표시
- `TILT_WARN = 2` — 등주 기울기 불량 기준(도)
- `CHECKS` — 점검표 항목(점등, 깜빡임·조도, 등기구, 등주, 기초·볼트, 분전함·안정기, 누전, 주변 간섭)
