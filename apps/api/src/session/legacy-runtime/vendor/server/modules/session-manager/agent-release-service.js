const crypto = require('crypto');
const { createReadStream } = require('fs');
const fs = require('fs/promises');
const path = require('path');

function releaseError(message) {
  const error = new Error(message);
  error.statusCode = 503;
  error.publicMessage = message;
  return error;
}

function createAgentReleaseService(options = {}) {
  const releaseDir = path.resolve(options.releaseDir || path.join(process.cwd(), 'dist', 'session-manager-agent'));
  const manifestPath = path.join(releaseDir, 'latest.json');
  const verificationCache = new Map();

  async function readManifest() {
    let manifest;
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    } catch (_error) {
      throw releaseError('Windows 助手安装包尚未发布，请联系管理员。');
    }

    const version = String(manifest.version || '');
    if (manifest.product !== 'SessionManagerAgent' || manifest.platform !== 'win32-x64' || !/^\d+\.\d+\.\d+$/.test(version)) {
      throw releaseError('Windows 助手发布清单无效。');
    }
    return { manifest, version };
  }

  async function getArtifact(kind, fromVersion = '') {
    const { manifest, version } = await readManifest();
    const patch = kind === 'update' && fromVersion ? manifest.patches?.[String(fromVersion)] : null;
    const artifact = patch || manifest[kind] || {};
    const fileName = String(artifact.fileName || '');
    const sha256 = String(artifact.sha256 || '').toLowerCase();
    const expectedFileName = kind === 'installer'
      ? `KudesiSessionManagerAgent-Setup-${version}.exe`
      : patch ? `SessionManagerAgent-${fromVersion}-to-${version}-patch.zip` : `SessionManagerAgent-${version}.zip`;
    if (fileName !== expectedFileName || path.basename(fileName) !== fileName || !/^[a-f0-9]{64}$/.test(sha256)) {
      throw releaseError('Windows 助手发布清单无效。');
    }

    const filePath = path.resolve(releaseDir, fileName);
    if (path.dirname(filePath) !== releaseDir) throw releaseError('Windows 助手发布清单无效。');
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch (_error) {
      throw releaseError('Windows 助手安装包尚未发布，请联系管理员。');
    }
    if (!stat.isFile() || Number(artifact.size) !== stat.size) throw releaseError('Windows 助手安装包大小校验失败。');
    return {
      product: manifest.product,
      version,
      platform: manifest.platform,
      minimumUpdaterVersion: String(manifest.minimumUpdaterVersion || '0.0.0'),
      fileName,
      size: stat.size,
      sha256,
      filePath,
      ...(kind === 'installer' ? { signed: artifact.signed === true } : {})
      ,...(kind === 'update' ? { packageType: patch?.packageType || 'full', fromVersion: patch ? String(fromVersion) : '' } : {})
    };
  }

  async function verifyArtifact(release) {
    let stat;
    try {
      stat = await fs.stat(release.filePath);
    } catch {
      throw releaseError('Windows 助手安装包尚未发布，请联系管理员。');
    }
    if (!stat.isFile() || stat.size !== release.size) throw releaseError('Windows 助手安装包大小校验失败。');
    const cacheKey = `${release.filePath}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${release.sha256}`;
    if (verificationCache.has(cacheKey)) return;
    const hash = crypto.createHash('sha256');
    await new Promise((resolve, reject) => {
      const stream = createReadStream(release.filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.once('error', reject);
      stream.once('end', resolve);
    }).catch(() => { throw releaseError('Windows 助手安装包读取失败。'); });
    if (hash.digest('hex') !== release.sha256) throw releaseError('Windows 助手安装包 SHA-256 校验失败。');
    for (const key of verificationCache.keys()) {
      if (key.startsWith(`${release.filePath}:`)) verificationCache.delete(key);
    }
    verificationCache.set(cacheKey, true);
  }

  async function sendArtifact(res, release) {
    await verifyArtifact(release);
    res.set({
      'Cache-Control': 'private, no-store',
      'Content-Length': String(release.size),
      'X-Checksum-SHA256': release.sha256
    });
    await new Promise((resolve, reject) => {
      res.download(release.filePath, release.fileName, (error) => error ? reject(error) : resolve());
    });
  }

  const getLatestInstaller = () => getArtifact('installer');
  const getLatestUpdate = (fromVersion = '') => getArtifact('update', fromVersion);
  const sendLatestInstaller = async (res) => sendArtifact(res, await getLatestInstaller());
  const sendLatestUpdate = async (res, fromVersion = '') => sendArtifact(res, await getLatestUpdate(fromVersion));
  return { getLatestInstaller, getLatestUpdate, sendLatestInstaller, sendLatestUpdate };
}

const defaultAgentReleaseService = createAgentReleaseService();

module.exports = { createAgentReleaseService, defaultAgentReleaseService };
