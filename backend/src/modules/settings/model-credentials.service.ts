import { Injectable } from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { DbService } from '../../db/db.service';
import { BizError, ERR } from '../../common/errors';

@Injectable()
export class ModelCredentialsService {
  constructor(private readonly db: DbService) {}

  async getKeys(): Promise<{ glmKey?: string; deepseekKey?: string }> {
    const rows = await this.db.many<{ provider: string; encrypted_key: string }>('SELECT provider, encrypted_key FROM model_credentials');
    const keys: { glmKey?: string; deepseekKey?: string } = { glmKey: process.env.GLM_API_KEY || undefined, deepseekKey: process.env.DEEPSEEK_API_KEY || undefined };
    if (!rows.length) return keys;
    const key = createHash('sha256').update(process.env.JWT_SECRET || 'cs-training-dev-secret-change-me').digest();
    for (const row of rows) {
      const [iv, tag, encrypted] = row.encrypted_key.split('.').map((part) => Buffer.from(part, 'base64'));
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const value = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
      if (row.provider === 'glm') keys.glmKey = value;
      if (row.provider === 'deepseek') keys.deepseekKey = value;
    }
    return keys;
  }

  async status() {
    const rows = await this.db.many<{ provider: string }>('SELECT provider FROM model_credentials');
    return { glmConfigured: rows.some((row) => row.provider === 'glm') || Boolean(process.env.GLM_API_KEY), deepseekConfigured: rows.some((row) => row.provider === 'deepseek') || Boolean(process.env.DEEPSEEK_API_KEY) };
  }

  async save(provider: string, secret: string) {
    if (!['glm', 'deepseek'].includes(provider) || typeof secret !== 'string' || !secret.trim() || secret.length > 512 || /\s/.test(secret)) {
      throw new BizError(ERR.PARAM, '请选择有效的服务商并输入 API Key');
    }
    const master = process.env.JWT_SECRET || 'cs-training-dev-secret-change-me';
    if (process.env.NODE_ENV === 'production' && (master.length < 32 || master === 'cs-training-dev-secret-change-me' || master === 'change-me-in-production')) {
      throw new BizError(ERR.PARAM, '服务器密钥配置不足，请联系管理员');
    }
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(master).digest(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const stored = [iv, cipher.getAuthTag(), encrypted].map((part) => part.toString('base64')).join('.');
    await this.db.query(`INSERT INTO model_credentials (provider, encrypted_key) VALUES ($1,$2)
      ON CONFLICT (provider) DO UPDATE SET encrypted_key = $2, updated_at = now()`, [provider, stored]);
    return this.status();
  }
}
