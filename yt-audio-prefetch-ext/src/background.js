// MV3 service worker - receives prefetch requests and performs cross-origin fetches

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'PREFETCH_AND_SAVE') {
    (async () => {
      try {
        const { mpdUrl, windowSeconds, filenameHint, currentTimeSec } = msg.payload;
        if (!mpdUrl) throw new Error('Missing mpdUrl');
        const mpdText = await fetch(mpdUrl, { credentials: 'include', mode: 'cors' }).then(r => r.text());
        const { requests, mimeType, containerExt } = await parseMpdEither(
          mpdText, mpdUrl, currentTimeSec || 0, windowSeconds || 12, sender?.tab?.id
        );

        // Prefetch a short window worth of audio (e.g., 12 seconds)
        const targetSeconds = Math.max(10, Math.min(30, windowSeconds || 12));

        // requests already sized to window by parser; still cap to 10-30s
        const selected = [];
        let accDuration = 0;
        for (const req of requests) {
          selected.push(req);
          accDuration += (req.durationSeconds || 0);
          if (accDuration >= targetSeconds) break;
        }

        // Fetch all as ArrayBuffers
        const buffers = [];
        for (const req of selected) {
          const { url, headers } = req;
          const res = await fetch(url, { credentials: 'include', mode: 'cors', headers: headers || {} });
          if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
          buffers.push(await res.arrayBuffer());
        }

        // Prefer saving as concatenated container (init + media segments)
        const blob = concatSegmentsToBlob(buffers, mimeType);

        const filename = (filenameHint || 'yt-audio-prefetch') + '-' + Date.now() + (containerExt || '.bin');
        await chrome.downloads.download({
          url: URL.createObjectURL(blob),
          filename,
          saveAs: true
        });

        sendResponse({ ok: true, filename });
      } catch (e) {
        console.error(e);
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // keep sendResponse alive
  }
});

function parseMpdForAudio(mpdText, mpdUrl, currentTimeSec, windowSeconds) {
  // Minimal MPD parser for a single audio AdaptationSet with SegmentTemplate
  const parser = new DOMParser();
  const xml = parser.parseFromString(mpdText, 'application/xml');
  const mpd = xml.documentElement;
  const period = xml.querySelector('Period');
  if (!period) throw new Error('MPD missing Period');

  // Prefer audio AdaptationSet
  const adaptationSets = [...xml.querySelectorAll('AdaptationSet')];
  // Pick audio set, prefer mp4 container for easier concatenation
  const audioSets = adaptationSets.filter(a => (a.getAttribute('contentType') || '').includes('audio')
    || (a.querySelector('Representation')?.getAttribute('mimeType') || '').startsWith('audio/'));
  const pickRep = (set) => {
    const reps = [...set.querySelectorAll('Representation')];
    // Prefer audio/mp4
    return reps.find(r => (r.getAttribute('mimeType') || '').startsWith('audio/mp4'))
      || reps.find(r => (r.getAttribute('mimeType') || '').startsWith('audio/'))
      || reps[0] || null;
  };
  let audioSet = audioSets[0] || adaptationSets[0];
  if (!audioSet) throw new Error('No AdaptationSet found');
  if (!audioSet) throw new Error('No AdaptationSet found');

  let rep = pickRep(audioSet);
  if (!rep) throw new Error('No Representation found');

  const mimeType = rep.getAttribute('mimeType') || audioSet.getAttribute('mimeType') || 'audio/webm';
  const codecs = rep.getAttribute('codecs') || '';

  const baseUrlNode = rep.querySelector('BaseURL') || audioSet.querySelector('BaseURL') || xml.querySelector('BaseURL');
  const repBase = baseUrlNode ? baseUrlNode.textContent.trim() : '';
  const baseUrl = new URL(repBase || mpdUrl, mpdUrl).toString();

  // Try SegmentTemplate first
  const st = rep.querySelector('SegmentTemplate') || audioSet.querySelector('SegmentTemplate');
  const initRequests = [];
  const segmentEntries = [];
  if (st) {
    const timescale = parseInt(st.getAttribute('timescale') || '1', 10);
    const mediaTmpl = st.getAttribute('media') || '';
    const initTmpl = st.getAttribute('initialization') || '';
    const startNumber = parseInt(st.getAttribute('startNumber') || '1', 10);

    // Push init
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
      // No timeline; derive fixed duration
      const dur = parseInt(st.getAttribute('duration') || '0', 10);
      const segDurSec = dur ? dur / Math.max(1, timescale) : 2;
      let number = startNumber;
      for (let i = 0; i < 60; i++) { // cap to 60 segments
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
    // Try SegmentList (YouTube often uses byte ranges)
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

  // Select segments covering [currentTimeSec, currentTimeSec + windowSeconds]
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

  const containerExt = mimeType.startsWith('audio/mp4') ? '.m4a' : mimeType.startsWith('audio/webm') ? '.webm' : '.bin';
  return { requests: selected, mimeType, containerExt };
}

function concatSegmentsToBlob(buffers, mimeType) {
  // For fMP4/WebM, concatenating init segment + media segments yields a valid file
  const type = mimeType || 'application/octet-stream';
  return new Blob(buffers, { type });
}

async function parseMpdEither(mpdText, mpdUrl, currentTimeSec, windowSeconds, tabId) {
  try {
    if (typeof DOMParser !== 'undefined') {
      return parseMpdForAudio(mpdText, mpdUrl, currentTimeSec, windowSeconds);
    }
  } catch (_) {}
  if (!tabId) throw new Error('No tab to delegate MPD parsing');
  // Delegate to content script for DOMParser
  return await new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, {
      type: 'PARSE_MPD',
      payload: { mpdText, mpdUrl, currentTimeSec, windowSeconds }
    }, (resp) => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!resp || !resp.ok) return reject(new Error(resp && resp.error || 'MPD parse failed'));
      resolve(resp.result);
    });
  });
}
