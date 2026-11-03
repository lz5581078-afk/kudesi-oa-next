const COMPONENT_KEYS = Object.freeze([
  'agentCore',
  'nodeRuntime',
  'captureSidecar',
  'webrtcBridge',
  'chromeForTesting',
  'updaterProtocol'
]);

function changed(current, target, key) {
  return String(current?.[key] ?? '') !== String(target?.[key] ?? '');
}

function selectUpdatePackage(current = {}, target = {}) {
  const changedComponents = COMPONENT_KEYS.filter((key) => changed(current, target, key));
  const chromeUpdateRequired = changedComponents.includes('chromeForTesting');
  if (changedComponents.includes('updaterProtocol')) {
    return { type: 'repair_required', changedComponents, chromeUpdateRequired };
  }
  if (changedComponents.includes('nodeRuntime')) {
    return { type: 'full', changedComponents, chromeUpdateRequired };
  }
  if (changedComponents.some((key) => key === 'captureSidecar' || key === 'webrtcBridge')) {
    return { type: 'component', changedComponents, chromeUpdateRequired };
  }
  return { type: 'patch', changedComponents, chromeUpdateRequired };
}

module.exports = { COMPONENT_KEYS, selectUpdatePackage };
