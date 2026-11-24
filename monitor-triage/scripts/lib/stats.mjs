export function flattenRows(logQueryResponse) {
  const rows = logQueryResponse?.data?.table_list ?? [];
  return rows.map((row) => {
    const m = row.metric_map ?? {};
    const v = (k) => (m[k] && typeof m[k] === 'object' ? m[k].value : m[k]) ?? '';
    return { pid: v('pid'), os: v('os'), release: v('release'), source_type: v('source_type'), session_id: v('session_id'), user_agent: v('user_agent'), timestamp: v('timestamp'), dh_key: v('dh_key') };
  });
}

function count(rows, pick) {
  const out = {};
  for (const r of rows) {
    const k = pick(r) || 'unknown';
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function hostVersion(userAgent) {
  const m = /Lark\/([0-9.]+)/.exec(userAgent ?? '');
  return m ? m[1] : 'unknown';
}

export function summarize(rows) {
  return {
    pid_dist: count(rows, (r) => r.pid),
    os_dist: count(rows, (r) => r.os),
    release_dist: count(rows, (r) => r.release),
    source_type_dist: count(rows, (r) => r.source_type),
    host_version_dist: count(rows, (r) => hostVersion(r.user_agent)),
    distinct_sessions: new Set(rows.map((r) => r.session_id).filter(Boolean)).size,
  };
}
