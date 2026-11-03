export const REMOTE_QUALITY_PROFILES = Object.freeze({
  clear: Object.freeze({ level: 'clear', label: '清晰', bitrate: 6_000_000 }),
  balanced: Object.freeze({ level: 'balanced', label: '均衡', bitrate: 4_000_000 }),
  smooth: Object.freeze({ level: 'smooth', label: '流畅', bitrate: 2_000_000 })
});

export const REMOTE_QUALITY_MODES = Object.freeze(['auto', 'clear', 'balanced', 'smooth']);

const LEVELS = Object.freeze(['smooth', 'balanced', 'clear']);

function validMode(value) {
  return REMOTE_QUALITY_MODES.includes(value) ? value : 'auto';
}

function usableSample(stats) {
  return Number(stats?.sampleSeconds || 0) > 0 &&
    (Number(stats?.framesDecodedDelta || 0) > 0 || Number(stats?.bitrate || 0) > 0);
}

function classify(stats) {
  const rtt = Number(stats.roundTripTimeMs || 0);
  const lossRate = Number(stats.lossRate || 0);
  const available = Number(stats.availableIncomingBitrate || 0);
  const dropped = Number(stats.framesDroppedDelta || 0);
  const poor = rtt >= 260 || lossRate >= 0.05 || dropped >= 3 || (available > 0 && available < 2_200_000);
  const constrained = poor || rtt >= 160 || lossRate >= 0.02 || dropped >= 1 ||
    (available > 0 && available < 3_500_000);
  const excellent = rtt > 0 && rtt <= 90 && lossRate < 0.005 && dropped === 0 &&
    (available <= 0 || available >= 6_000_000);
  return { poor, constrained, excellent };
}

export function createRemoteQualityController(options = {}) {
  const downSamples = Math.max(2, Number(options.downSamples || 6));
  const upSamples = Math.max(downSamples + 1, Number(options.upSamples || 25));
  let mode = validMode(options.initialMode);
  let level = mode === 'auto' ? 'balanced' : mode;
  let constrainedSamples = 0;
  let poorSamples = 0;
  let excellentSamples = 0;

  function resetEvidence() {
    constrainedSamples = 0;
    poorSamples = 0;
    excellentSamples = 0;
  }

  function snapshot(changed = false) {
    return Object.freeze({ mode, level, profile: REMOTE_QUALITY_PROFILES[level], changed });
  }

  function setMode(nextMode) {
    const normalized = validMode(nextMode);
    const previousLevel = level;
    const previousMode = mode;
    mode = normalized;
    if (mode !== 'auto') level = mode;
    resetEvidence();
    return snapshot(previousMode !== mode || previousLevel !== level);
  }

  function update(stats) {
    if (mode !== 'auto' || !usableSample(stats)) return snapshot(false);
    const state = classify(stats);
    constrainedSamples = state.constrained ? constrainedSamples + 1 : 0;
    poorSamples = state.poor ? poorSamples + 1 : 0;
    excellentSamples = state.excellent ? excellentSamples + 1 : 0;
    const previousLevel = level;
    const index = LEVELS.indexOf(level);
    if ((level === 'clear' && constrainedSamples >= downSamples) ||
        (level === 'balanced' && poorSamples >= downSamples)) {
      level = LEVELS[Math.max(0, index - 1)];
      resetEvidence();
    } else if (excellentSamples >= upSamples && index < LEVELS.length - 1) {
      level = LEVELS[index + 1];
      resetEvidence();
    }
    return snapshot(previousLevel !== level);
  }

  return Object.freeze({ setMode, snapshot, update });
}
