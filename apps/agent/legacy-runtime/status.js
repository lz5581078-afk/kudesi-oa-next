const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { agentDataDir, managedWindowPath } = require('./config');
const { AGENT_VERSION } = require('./config');
const { createDisplayStatus, shouldReplaceStatus } = require('./state-model');

function statusPath() {
  return path.join(agentDataDir(), 'status.json');
}

function livenessPath() {
  return path.join(agentDataDir(), 'liveness.json');
}

async function atomicWrite(target, value) {
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value), { encoding: 'utf8', mode: 0o600 });
  try {
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

async function readAgentStatus() {
  try {
    return JSON.parse(await fs.readFile(statusPath(), 'utf8'));
  } catch {
    return null;
  }
}

async function writeAgentStatus(input, options = {}) {
  const current = await readAgentStatus();
  const candidate = createDisplayStatus({ ...current, ...input, currentVersion: input?.currentVersion || current?.currentVersion || AGENT_VERSION });
  const currentAge = Date.now() - new Date(current?.updatedAt || 0).getTime();
  if (!options.force && current && !shouldReplaceStatus(current, candidate) && currentAge < 30_000) {
    return current;
  }
  const value = { ...candidate, updatedAt: new Date().toISOString() };
  await atomicWrite(statusPath(), value);
  return value;
}

async function patchAgentStatus(input) {
  const current = await readAgentStatus();
  return writeAgentStatus({ ...(current || {}), ...input }, { force: true });
}

async function writeLiveness() {
  return atomicWrite(livenessPath(), { updatedAt: new Date().toISOString() });
}

async function writeManagedWindow(storeId) {
  if (!storeId) {
    await fs.rm(managedWindowPath(), { force: true });
    return;
  }
  await atomicWrite(managedWindowPath(), { state: 'open', storeId: String(storeId), pid: process.pid, updatedAt: new Date().toISOString() });
}

module.exports = { livenessPath, patchAgentStatus, readAgentStatus, statusPath, writeAgentStatus, writeLiveness, writeManagedWindow };
