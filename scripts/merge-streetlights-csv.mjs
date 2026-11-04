#!/usr/bin/env node
/* 공공데이터 "광주광역시 동구 가로등 현황" CSV → data/lights.json의 가로등 교체
   사용: node scripts/merge-streetlights-csv.mjs 가로등.csv [data/lights.json] [--report 보고서.csv]
   CSV 열: 관리번호(동구-분전함-번호), 소재지도로명주소, 소재지지번주소, 위도, 경도, 데이터기준일자 (CP949 또는 UTF-8)

   규칙
   - 가로등 목록은 CSV가 기준이다. 보안등·공원등·특이등은 건드리지 않는다.
   - 대장에 이미 있는 가로등(분전함-번호가 같은 등)은 시설 ID를 그대로 두어 점검·사진·신고·보수 이력이 이어지고,
     좌표도 그대로 둔다: CSV 좌표는 등주가 아니라 분전함 위치(분전함마다 같은 좌표)이기 때문이다. 주소·관리번호만 보탠다.
   - CSV에만 있는 가로등은 새로 넣고 좌표는 분전함 위치로 두되 posApprox=1(위치 추정)로 표시한다. 앱은 이 등을
     거리 기반 기능(밝기 예측, 순찰 통과, 주변 찾기)에서 빼고, 현장에서 좌표를 바로잡으면 표시를 지운다.
   - 대장에만 있고 CSV에 없는 가로등은 지우지 않고 removed=1(철거·대장 제외)로 표시한다. 이력은 남는다. */
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2), reportAt = args.indexOf("--report");
const reportPath = reportAt >= 0 ? args.splice(reportAt, 2)[1] : null;
const [csvPath, outPath = "data/lights.json"] = args;
if (!csvPath) { console.error("사용: node scripts/merge-streetlights-csv.mjs 가로등.csv [data/lights.json] [--report 보고서.csv]"); process.exit(1); }
const DONGS = ["계림동","광산동","궁동","금남로1가","금남로2가","금남로3가","금남로4가","금남로5가","금동","남동","대의동","대인동","동명동","불로동","산수동","서석동","소태동","수기동","용산동","운림동","월남동","장동","지산동","충장로1가","충장로2가","충장로3가","충장로4가","충장로5가","학동","호남동","황금동"].sort((a, b) => b.length - a.length);
const EXTRA = ["addr", "jibun", "mgmt", "posApprox"];

// --- read the CSV (CP949 from the portal, or UTF-8) ---
const bytes = fs.readFileSync(csvPath);
let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
if (!text.includes("관리번호")) text = new TextDecoder("euc-kr").decode(bytes);
text = text.replace(/^﻿/, "");
function parseCsv(s) {
  const rows = []; let row = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(cell); cell = ""; } else if (c === "\n" || c === "\r") { if (c === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim()));
}
const table = parseCsv(text), head = table.shift().map(h => h.trim());
const col = name => { const i = head.indexOf(name); if (i < 0) throw new Error("CSV에 '" + name + "' 열이 없어요: " + head.join(", ")); return i; };
const C = { mgmt: col("관리번호"), addr: col("소재지도로명주소"), jibun: col("소재지지번주소"), lat: col("위도"), lng: col("경도"), date: col("데이터기준일자") };
const r7 = v => Math.round(+v * 1e7) / 1e7;
const csv = new Map(), dates = new Set();
for (const r of table) {
  const mgmt = r[C.mgmt].trim(), m = /^동구-0*(\d+)-0*(\d+)$/.exec(mgmt);
  if (!m) throw new Error("관리번호 형식이 달라요(동구-분전함-번호): " + mgmt);
  const lat = r7(r[C.lat]), lng = r7(r[C.lng]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 34.9 || lat > 35.3 || lng < 126.7 || lng > 127.1) throw new Error("광주 동구 밖이거나 잘못된 좌표: " + mgmt);
  const key = m[1] + "-" + m[2];
  if (csv.has(key)) throw new Error("관리번호 중복: " + mgmt);
  const jibun = r[C.jibun].trim();
  csv.set(key, { key, main: m[1], sub: m[2], mgmt, addr: r[C.addr].trim(), jibun, lat, lng, dong: DONGS.find(d => jibun.replace(/\s+/g, "").startsWith(d)) || "" });
  dates.add(r[C.date].trim());
}

// --- merge into the registry ---
const reg = JSON.parse(fs.readFileSync(outPath, "utf8"));
const cols = [...reg.cols, ...EXTRA.filter(c => !reg.cols.includes(c))];
const objs = reg.rows.map(row => Object.fromEntries(reg.cols.map((c, i) => [c, row[i]])));
const keyOf = o => o.main != null && o.sub != null ? String(+o.main) + "-" + String(+o.sub) : null;
const used = new Set(), report = [];
let kept = 0, removed = 0;
for (const o of objs) {
  if (o.kind !== "가로등") continue;
  const k = keyOf(o), c = k && csv.get(k);
  if (c) {
    used.add(k); kept++;
    Object.assign(o, { addr: c.addr || null, jibun: c.jibun || null, mgmt: c.mgmt });
    if (c.dong && (o.dongGuess || !o.dong)) { o.dong = c.dong; o.dongGuess = null; } // the official 지번 address beats a guess from the nearest light
    if (o.removed && !/철거/.test(o.label || "")) o.removed = null; // back in the official list
    report.push(["유지", o.id, o.code, c.mgmt, "이력·좌표 유지, 주소 보강"]);
  } else if (!o.removed) {
    o.removed = 1; removed++;
    report.push(["대장 제외", o.id, o.code, "", "공공데이터 목록에 없음 → 철거·제외 표시(이력 보존)"]);
  }
}
const ids = new Set(objs.map(o => o.id));
let added = 0;
for (const c of csv.values()) {
  if (used.has(c.key)) continue;
  const id = "g" + c.main + "-" + c.sub;
  if (ids.has(id)) throw new Error("새 시설 ID가 이미 있어요: " + id);
  ids.add(id); added++;
  objs.push({ id, lampId: null, label: c.main + "-" + c.sub, code: c.main + "-" + c.sub, kind: "가로등", dong: c.dong, num: null, road: null, main: c.main, sub: c.sub, lat: c.lat, lng: c.lng, lampType: "", pole: "", sw: "", removed: null, noPlate: null, dongGuess: c.dong ? null : 1, addr: c.addr || null, jibun: c.jibun || null, mgmt: c.mgmt, posApprox: 1 });
  report.push(["추가", id, c.main + "-" + c.sub, c.mgmt, "분전함 위치(추정) — 현장에서 좌표 보정 필요"]);
}
const rows = objs.map(o => cols.map(c => o[c] === undefined || o[c] === "" && ["num", "road", "main", "sub", "removed", "noPlate", "dongGuess", "addr", "jibun", "mgmt", "posApprox"].includes(c) ? null : o[c]));
const output = { schemaVersion: 1, source: reg.source + " + " + path.basename(csvPath) + " (가로등, 기준일 " + [...dates].join("·") + ")", generatedAt: new Date().toISOString(), count: rows.length, cols, rows };
const tmp = outPath + ".tmp-" + process.pid; fs.writeFileSync(tmp, JSON.stringify(output)); fs.renameSync(tmp, outPath);
if (reportPath) {
  const cell = v => { const s = String(v ?? ""); return '"' + (/^[=+@\-\t\r]/.test(s) ? "'" : "") + s.replace(/"/g, '""') + '"'; };
  fs.writeFileSync(reportPath, "﻿" + [["구분", "시설ID", "표찰", "관리번호", "비고"], ...report].map(r => r.map(cell).join(",")).join("\r\n"));
}
const kinds = {}; objs.forEach(o => { if (!o.removed) kinds[o.kind] = (kinds[o.kind] || 0) + 1; });
console.log(JSON.stringify({ csvRows: csv.size, kept, added, removed, total: rows.length, active: kinds }, null, 1));
