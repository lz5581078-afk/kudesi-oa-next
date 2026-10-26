/**
 * 环境配置。所有密钥类配置都没有默认值：缺失或太弱就直接启动失败，
 * 不允许像旧系统那样回退到硬编码密钥或默认密码。
 */

export interface AppEnv {
  apiPort: number;
  corsOrigin: string;
  db: { host: string; port: number; name: string; user: string; password: string };
  jwtSecret: string;
  jwtExpiresIn: string;
  encryptionKeys: Record<string, Buffer>;
  encryptionActiveKeyId: string;
}

function required(source: NodeJS.ProcessEnv, name: string): string {
  const value = source[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(`缺少必填环境变量 ${name}，请参考 .env.example`);
  }
  return value.trim();
}

export function parseEncryptionKeys(raw: string): Record<string, Buffer> {
  const keys: Record<string, Buffer> = {};
  for (const part of raw.split(',')) {
    const item = part.trim();
    if (!item) continue;
    const index = item.indexOf(':');
    if (index <= 0) throw new Error('DATA_ENCRYPTION_KEYS 格式应为 keyId:base64，多个用逗号分隔');
    const id = item.slice(0, index);
    const key = Buffer.from(item.slice(index + 1), 'base64');
    if (key.length !== 32) throw new Error(`加密密钥 ${id} 必须是 32 字节（base64 编码）`);
    if (keys[id]) throw new Error(`加密密钥 ID 重复：${id}`);
    keys[id] = key;
  }
  if (Object.keys(keys).length === 0) throw new Error('DATA_ENCRYPTION_KEYS 里没有可用的密钥');
  return keys;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const jwtSecret = required(source, 'JWT_SECRET');
  if (jwtSecret.length < 32) throw new Error('JWT_SECRET 至少 32 个字符');

  const encryptionKeys = parseEncryptionKeys(required(source, 'DATA_ENCRYPTION_KEYS'));
  const encryptionActiveKeyId = required(source, 'DATA_ENCRYPTION_ACTIVE_KEY');
  if (!encryptionKeys[encryptionActiveKeyId]) {
    throw new Error(`DATA_ENCRYPTION_ACTIVE_KEY=${encryptionActiveKeyId} 不在 DATA_ENCRYPTION_KEYS 里`);
  }

  return {
    apiPort: Number(source.API_PORT ?? 4000),
    corsOrigin: source.CORS_ORIGIN ?? 'http://localhost:5173',
    db: {
      host: source.DB_HOST ?? '127.0.0.1',
      port: Number(source.DB_PORT ?? 3306),
      name: required(source, 'DB_NAME'),
      user: required(source, 'DB_USER'),
      password: required(source, 'DB_PASSWORD'),
    },
    jwtSecret,
    jwtExpiresIn: source.JWT_EXPIRES_IN ?? '12h',
    encryptionKeys,
    encryptionActiveKeyId,
  };
}
