// Runs in page context to access ytInitialPlayerResponse and player APIs
(function() {
  function postPlayerResponse() {
    try {
      const pr = window.ytInitialPlayerResponse || (window.yt && yt.player && yt.player.getPlayerResponse && yt.player.getPlayerResponse());
      if (!pr || !pr.streamingData) return;
      window.postMessage({
        source: 'yt-audio-prefetch-ext',
        type: 'PLAYER_RESPONSE',
        playerResponse: pr
      }, '*');
    } catch (e) {}
  }

  const observer = new MutationObserver(() => postPlayerResponse());
  observer.observe(document.documentElement || document.body, { childList: true, subtree: true });
  postPlayerResponse();

  // Expose a trigger function
  window.__YTAudioPrefetchGetPR = () => postPlayerResponse();
})();
