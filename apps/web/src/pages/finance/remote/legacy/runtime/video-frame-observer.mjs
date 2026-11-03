export function createVideoFrameObserver({ video, onFrame, minUpdateIntervalMs = 1000 }) {
  let running = false;
  let requestId = 0;
  let lastUpdateAt = null;

  const schedule = () => {
    if (!running || typeof video?.requestVideoFrameCallback !== 'function') return;
    requestId = video.requestVideoFrameCallback((timestamp, metadata) => {
      requestId = 0;
      if (!running) return;
      if (lastUpdateAt === null || timestamp - lastUpdateAt >= minUpdateIntervalMs) {
        lastUpdateAt = timestamp;
        onFrame?.(timestamp, metadata);
      }
      schedule();
    });
  };

  return {
    start() {
      if (running) return;
      running = true;
      schedule();
    },
    stop() {
      if (!running) return;
      running = false;
      if (requestId && typeof video?.cancelVideoFrameCallback === 'function') {
        video.cancelVideoFrameCallback(requestId);
      }
      requestId = 0;
    }
  };
}
