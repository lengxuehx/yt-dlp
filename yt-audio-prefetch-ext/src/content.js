// Content script: injects page script, listens for PLAYER_RESPONSE, and triggers background prefetch

(function inject() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('src/injected.js');
  s.onload = () => s.remove();
  (document.head || document.documentElement).appendChild(s);
})();

let lastPR = null;
window.addEventListener('message', (ev) => {
  const data = ev.data;
  if (!data || data.source !== 'yt-audio-prefetch-ext') return;
  if (data.type === 'PLAYER_RESPONSE') {
    lastPR = data.playerResponse;
    ensurePrefetchButton();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'PARSE_MPD') {
    try {
      const { mpdText, mpdUrl, currentTimeSec, windowSeconds } = msg.payload;
      const result = parseMpdInPage(mpdText, mpdUrl, currentTimeSec, windowSeconds);
      sendResponse({ ok: true, result });
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
    return true;
  }
});

function ensurePrefetchButton() {
  if (document.getElementById('yt-audio-prefetch-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'yt-audio-prefetch-btn';
  btn.textContent = 'Prefetch 12s Audio (Save)';
  btn.style.cssText = 'position:fixed;bottom:16px;right:16px;z-index:999999;padding:8px 12px;background:#0f9d58;color:#fff;border:none;border-radius:4px;cursor:pointer;';
  btn.addEventListener('click', onPrefetchClick);
  document.body.appendChild(btn);
}

async function onPrefetchClick() {
  try {
    if (!lastPR || !lastPR.streamingData) {
      // ask injected to try again
      window.postMessage({ source: 'yt-audio-prefetch-ext', type: 'REFRESH' }, '*');
      alert('Player response not ready. Try again.');
      return;
    }
    const sd = lastPR.streamingData;
    const dashManifestUrl = sd.dashManifestUrl || null;
    if (!dashManifestUrl) {
      alert('No dashManifestUrl. Try refreshing or a different video.');
      return;
    }

    const title = (lastPR.videoDetails && lastPR.videoDetails.title) || 'yt-audio';
    // Try to read current playback time from the page player
    const currentTimeSec = (window.ytplayer && ytplayer.config && ytplayer.config.args && ytplayer.config.args.t) ? Number(ytplayer.config.args.t) : (document.querySelector('video')?.currentTime || 0);
    const res = await chrome.runtime.sendMessage({
      type: 'PREFETCH_AND_SAVE',
      payload: {
        mpdUrl: dashManifestUrl,
        windowSeconds: 12,
        filenameHint: sanitizeFilename(title),
        currentTimeSec
      }
    });

    if (!res || !res.ok) {
      console.error(res);
      alert('Prefetch failed: ' + (res && res.error));
      return;
    }
    alert('Saved: ' + res.filename);
  } catch (e) {
    console.error(e);
    alert('Error: ' + e.message);
  }
}

function sanitizeFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80);
}

function parseMpdInPage(mpdText, mpdUrl, currentTimeSec, windowSeconds) {
  const parser = new DOMParser();
  const xml = parser.parseFromString(mpdText, 'application/xml');
  const adaptationSets = [...xml.querySelectorAll('AdaptationSet')];
  const audioSets = adaptationSets.filter(a => (a.getAttribute('contentType') || '').includes('audio')
    || (a.querySelector('Representation')?.getAttribute('mimeType') || '').startsWith('audio/'));
  const pickRep = (set) => {
    const reps = [...set.querySelectorAll('Representation')];
    return reps.find(r => (r.getAttribute('mimeType') || '').startsWith('audio/mp4'))
      || reps.find(r => (r.getAttribute('mimeType') || '').startsWith('audio/'))
      || reps[0] || null;
  };
  const audioSet = audioSets[0] || adaptationSets[0];
  if (!audioSet) throw new Error('No AdaptationSet');
  const rep = pickRep(audioSet);
  if (!rep) throw new Error('No Representation');

  const mimeType = rep.getAttribute('mimeType') || audioSet.getAttribute('mimeType') || 'audio/webm';
  const baseUrlNode = rep.querySelector('BaseURL') || audioSet.querySelector('BaseURL') || xml.querySelector('BaseURL');
  const repBase = baseUrlNode ? baseUrlNode.textContent.trim() : '';
  const baseUrl = new URL(repBase || mpdUrl, mpdUrl).toString();

  const st = rep.querySelector('SegmentTemplate') || audioSet.querySelector('SegmentTemplate');
  const initRequests = [];
  const segmentEntries = [];
  if (st) {
    const timescale = parseInt(st.getAttribute('timescale') || '1', 10);
    const mediaTmpl = st.getAttribute('media') || '';
    const initTmpl = st.getAttribute('initialization') || '';
    const startNumber = parseInt(st.getAttribute('startNumber') || '1', 10);
    if (initTmpl) {
      let initPath = initTmpl.replace('$RepresentationID$', rep.getAttribute('id') || '');
      initPath = initPath.replace('$Bandwidth$', rep.getAttribute('bandwidth') || '');
      initRequests.push({ url: new URL(initPath, baseUrl).toString(), durationSeconds: 0 });
    }
    const segmentTimeline = st.querySelector('SegmentTimeline');
    if (segmentTimeline) {
      const sNodes = [...segmentTimeline.querySelectorAll('S')];
      let time = 0;
      let number = startNumber;
      for (const s of sNodes) {
        const d = parseInt(s.getAttribute('d') || '0', 10);
        const r = parseInt(s.getAttribute('r') || '0', 10);
        const start = parseInt(s.getAttribute('t') || String(time), 10);
        const repeat = isNaN(r) ? 0 : r;
        for (let i = 0; i <= repeat; i++) {
          const t = start + i * d;
          let mediaPath = mediaTmpl
            .replace('$Time$', String(t))
            .replace('$Number$', String(number))
            .replace('$RepresentationID$', rep.getAttribute('id') || '')
            .replace('$Bandwidth$', rep.getAttribute('bandwidth') || '');
          segmentEntries.push({ url: new URL(mediaPath, baseUrl).toString(), durationSeconds: d / Math.max(1, timescale), startSeconds: t / Math.max(1, timescale) });
          number++;
        }
        time = start + (repeat + 1) * d;
      }
    } else {
      const dur = parseInt(st.getAttribute('duration') || '0', 10);
      const segDurSec = dur ? dur / Math.max(1, timescale) : 2;
      let number = startNumber;
      for (let i = 0; i < 60; i++) {
        let mediaPath = mediaTmpl
          .replace('$Number$', String(number))
          .replace('$RepresentationID$', rep.getAttribute('id') || '')
          .replace('$Bandwidth$', rep.getAttribute('bandwidth') || '');
        const startSeconds = i * segDurSec;
        segmentEntries.push({ url: new URL(mediaPath, baseUrl).toString(), durationSeconds: segDurSec, startSeconds });
        number++;
      }
    }
  } else {
    const sl = rep.querySelector('SegmentList') || audioSet.querySelector('SegmentList');
    if (!sl) throw new Error('No SegmentTemplate/SegmentList');
    const timescale = parseInt(sl.getAttribute('timescale') || '1', 10);
    const init = sl.querySelector('Initialization');
    const representationUrl = rep.querySelector('BaseURL')?.textContent.trim() || baseUrl;
    const fullUrl = new URL(representationUrl, mpdUrl).toString();
    if (init) {
      const src = init.getAttribute('sourceURL');
      const range = init.getAttribute('range');
      if (src) {
        initRequests.push({ url: new URL(src, fullUrl).toString(), durationSeconds: 0 });
      } else if (range) {
        initRequests.push({ url: fullUrl, headers: { 'Range': `bytes=${range}` }, durationSeconds: 0 });
      }
    }
    const segUrls = [...sl.querySelectorAll('SegmentURL')];
    let i = 0;
    for (const u of segUrls) {
      const mediaRange = u.getAttribute('mediaRange');
      const media = u.getAttribute('media');
      const d = parseInt(u.getAttribute('d') || '0', 10);
      const durSec = d ? d / Math.max(1, timescale) : 0;
      const startSeconds = i * durSec;
      if (media) {
        segmentEntries.push({ url: new URL(media, fullUrl).toString(), durationSeconds: durSec, startSeconds });
      } else if (mediaRange) {
        segmentEntries.push({ url: fullUrl, headers: { 'Range': `bytes=${mediaRange}` }, durationSeconds: durSec, startSeconds });
      }
      i++;
    }
  }

  const startIdx = Math.max(0, segmentEntries.findIndex(s => (s.startSeconds || 0) + (s.durationSeconds || 0) > currentTimeSec));
  let acc = 0;
  const maxWindow = Math.max(10, Math.min(30, windowSeconds || 12));
  const selected = [];
  selected.push(...initRequests);
  for (let i = startIdx; i < segmentEntries.length; i++) {
    selected.push(segmentEntries[i]);
    acc += (segmentEntries[i].durationSeconds || 0);
    if (acc >= maxWindow) break;
  }

  const mimeType = rep.getAttribute('mimeType') || audioSet.getAttribute('mimeType') || 'audio/webm';
  const containerExt = mimeType.startsWith('audio/mp4') ? '.m4a' : mimeType.startsWith('audio/webm') ? '.webm' : '.bin';
  return { requests: selected, mimeType, containerExt };
}
