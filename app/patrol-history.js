/* Night patrol presentation only. Never changes or truncates saved patrol records. */
(function (root) {
  'use strict';
  const PAGE_SIZE = 10;
  function number(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
  function rows(session) {
    const marks = Array.isArray(session?.marks) ? session.marks : [];
    const spots = Array.isArray(session?.spots) ? session.spots : [];
    return [
      ...marks.map((m, index) => ({ type: 'mark', index, id: m.id, code: m.code || '',
        result: m.result || '', at: number(m.at), raw: m, order: index })),
      ...spots.map((sp, index) => ({ type: 'spot', index, id: null, code: sp.near || '',
        result: '어두운 지점', at: number(sp.at), raw: sp, order: marks.length + index }))
    ].sort((a, b) => b.at - a.at || b.order - a.order);
  }
  function isIssue(row) { return row.type === 'spot' || row.result !== '정상'; }
  function snapshot(session, opts = {}) {
    const records = rows(session);
    const filter = ['all', 'issues', 'normal'].includes(opts.filter) ? opts.filter : 'all';
    const limit = Number.isInteger(opts.limit) ? Math.max(1, Math.min(500, opts.limit)) : PAGE_SIZE;
    const filtered = filter === 'issues' ? records.filter(isIssue)
      : filter === 'normal' ? records.filter(row => !isIssue(row)) : records;
    return {
      total: records.length,
      issues: records.filter(isIssue).length,
      normal: records.filter(row => !isIssue(row)).length,
      spots: records.filter(row => row.type === 'spot').length,
      latest: records[0] || null,
      count: filtered.length,
      visible: filtered.slice(0, limit),
      remaining: Math.max(0, filtered.length - limit),
      filter,
      limit
    };
  }
  function candidates(ahead, marks, showChecked = false) {
    const checked = new Set((marks || []).map(m => m.id));
    return (ahead || []).filter(a => showChecked || !checked.has(a?.l?.id));
  }
  function unmarkedTarget(ahead, marks) {
    return candidates(ahead, marks, false)[0]?.l || null;
  }
  /* Only the open drawer creates record rows; closed patrol UI stays one line tall. */
  function updatePanel(session, esc, fmtT) {
    const snap = snapshot(session, { filter: session.historyFilter, limit: session.historyLimit });
    const title = document.getElementById('ptHistoryTitle');
    const latest = document.getElementById('ptHistoryLatest');
    const details = document.getElementById('ptHistory');
    const log = document.getElementById('ptLog');
    if (!title || !latest || !details || !log) return snap;
    title.textContent = '점검 기록 ' + snap.total + '건 · 확인 필요 ' + snap.issues + ' · 정상 ' + snap.normal;
    const item = snap.latest;
    latest.textContent = item
      ? '최근 ' + (item.type === 'spot' ? '어두운 지점' : item.code + ' ' + item.result) + ' · ' + fmtT(item.at)
      : '기록은 이곳에서 확인할 수 있어요';
    details.querySelectorAll('[data-ptlogfilter]').forEach(button => {
      button.setAttribute('aria-pressed', String(button.dataset.ptlogfilter === snap.filter));
      button.disabled = snap.total === 0;
    });
    if (!details.open) { log.replaceChildren(); return snap; }
    const scroll = log.scrollTop;
    log.innerHTML = snap.visible.map(row => {
      const name = row.type === 'spot' ? '어두운 지점' : row.code;
      const label = row.type === 'spot' ? (row.raw.near ? ' · ' + row.raw.near + ' 근처' : '') : ' · ' + row.result;
      const data = row.type === 'spot'
        ? 'data-ptspotdel="' + row.index + '"'
        : 'data-ptdrop="' + esc(String(row.id)) + '"';
      return '<div class="ptlogrow ' + (isIssue(row) ? 'issue' : 'normal') + '">'
        + '<span class="ptlogname"><b>' + esc(name) + '</b>' + esc(label)
        + '<small>' + fmtT(row.at) + '</small></span>'
        + '<button type="button" ' + data + ' aria-label="' + esc(name) + ' 기록 빼기">빼기</button></div>';
    }).join('') || '<div class="ptlogempty">이 조건에 해당하는 기록이 없어요.</div>';
    if (snap.remaining) {
      log.insertAdjacentHTML('beforeend', '<button type="button" class="ptlogmore" id="ptHistoryMore">'
        + '이전 기록 10건 더 보기 · 남은 ' + snap.remaining + '건</button>');
    }
    log.scrollTop = scroll;
    return snap;
  }
  /* Summary cards are present as before, but normal records are hidden behind disclosure. */
  function compactSummary(box, session) {
    const marks = session.marks || [];
    if (!marks.length || !box) return;
    const list = box.querySelector('.list');
    if (!list) return;
    const records = marks.slice().reverse();
    const cards = [...list.children];
    if (cards.length !== records.length) return; // do not rearrange unknown layouts
    const normals = [];
    records.forEach((record, i) => {
      if (record.result === '정상') { normals.push(cards[i]); cards[i].remove(); }
    });
    if (!normals.length) return;
    if (records.length === normals.length) {
      const note = document.createElement('div');
      note.className = 'muted';
      note.textContent = '고장·점검 필요로 표시한 등은 없어요.';
      list.append(note);
    } else {
      const heading = document.createElement('div');
      heading.className = 'ptsummary-issue-title';
      heading.textContent = '조치 필요 · ' + (records.length - normals.length) + '건';
      list.before(heading);
    }
    const detail = document.createElement('details');
    detail.id = 'ptSummaryNormal';
    detail.className = 'ptsummary-normal';
    detail.open = !!session.summaryNormalOpen;
    const summary = document.createElement('summary');
    summary.textContent = '정상 점등 확인 ' + normals.length + '건 · 눌러서 기록 보기';
    const normalList = document.createElement('div');
    normalList.className = 'list';
    normals.forEach(card => normalList.append(card));
    detail.append(summary, normalList);
    list.after(detail);
    detail.addEventListener('toggle', () => { session.summaryNormalOpen = detail.open; });
  }
  root.DGPatrolHistory = Object.freeze({ PAGE_SIZE, snapshot, candidates, unmarkedTarget, updatePanel, compactSummary });
})(globalThis);
