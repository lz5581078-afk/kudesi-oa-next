const { createServer } = require('http');
const { AGENT_VERSION } = require('./config');

const LOCAL_BRIDGE_HOST = '127.0.0.1';
const LOCAL_BRIDGE_PORT = 17863;

async function startLocalAgentBridge(config, options = {}) {
  if (options.diagnosticEnabled !== true) {
    throw new Error('本机诊断端口默认关闭，只能通过明确的诊断开关启用');
  }
  const allowedOrigin = new URL(config.serverUrl).origin;

  const server = createServer((request, response) => {
    const requestOrigin = String(request.headers.origin || '');
    if (requestOrigin !== allowedOrigin) return writeJson(response, 403, { error: '不允许的网站来源' });
    response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Access-Control-Allow-Private-Network', 'true');
    response.setHeader('Vary', 'Origin, Access-Control-Request-Private-Network');
    if (request.method === 'OPTIONS') {
      response.writeHead(204);
      return response.end();
    }
    const pathname = new URL(request.url || '/', `http://${LOCAL_BRIDGE_HOST}`).pathname;
    if (request.method !== 'GET' || pathname !== '/health') return writeJson(response, 404, { error: '接口不存在' });
    return writeJson(response, 200, {
      ok: true,
      agentVersion: AGENT_VERSION,
      serverOrigin: allowedOrigin
    });
  });

  const requestedPort = options.port ?? LOCAL_BRIDGE_PORT;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(requestedPort, LOCAL_BRIDGE_HOST, resolve);
  });
  return {
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

function writeJson(response, status, body) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff'
  });
  response.end(JSON.stringify(body));
}

module.exports = { LOCAL_BRIDGE_HOST, LOCAL_BRIDGE_PORT, startLocalAgentBridge };
