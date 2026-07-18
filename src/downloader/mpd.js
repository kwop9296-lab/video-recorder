// DASH MPD(XML) 파서 — Representation 블록에서 프로그레시브 MP4 / HLS m3u8 URL 추출.
// 정식 XML 파서 대신 정규식 사용 (구조가 단순하고 의존성 줄이려고).

const decodeXml = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');

function representations(mpd) {
  return mpd.match(/<Representation\b[\s\S]*?<\/Representation>/g) || [];
}

// 완성된 단일 MP4(progressive download) 중 해상도가 가장 높은 것
export function pickProgressiveMp4(mpd) {
  const cands = [];
  for (const r of representations(mpd)) {
    const h = Number((r.match(/height="(\d+)"/) || [])[1] || 0);
    const w = Number((r.match(/width="(\d+)"/) || [])[1] || 0);
    const base = (r.match(/<BaseURL>\s*([^<\s][^<]*?\.mp4[^<]*)\s*<\/BaseURL>/i) || [])[1];
    if (base) cands.push({ h, w, url: decodeXml(base.trim()) });
  }
  cands.sort((a, b) => b.h - a.h || b.w - a.w);
  return cands[0] || null;
}

// HLS 미디어 플레이리스트(m3u8) 중 해상도가 가장 높은 것 (ffmpeg 폴백용)
export function pickHlsPlaylist(mpd) {
  const cands = [];
  for (const r of representations(mpd)) {
    const h = Number((r.match(/height="(\d+)"/) || [])[1] || 0);
    const m = (r.match(/nvod:m3u="([^"]+)"/) || [])[1];
    if (m) cands.push({ h, url: decodeXml(m) });
  }
  cands.sort((a, b) => b.h - a.h);
  return cands[0] || null;
}
