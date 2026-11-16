import fs from 'fs';
import path from 'path';
import { randomBytes } from 'crypto';
import { Injectable } from '@nestjs/common';
import { BizError, ERR } from '../../common/errors';

/** 允许上传的图片类型（方案 3.4 / 3.3：商品主图与详情图、内容配图）。 */
const ALLOWED_TYPES: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/** 上传目录：默认 <backend>/uploads，可用 UPLOAD_DIR 覆盖。 */
export function uploadDir(): string {
  return process.env.UPLOAD_DIR || path.resolve(process.cwd(), 'uploads');
}

@Injectable()
export class UploadsService {
  /** 保存上传的图片，返回可直接访问的相对地址。 */
  save(file: { buffer?: Buffer; mimetype?: string; size?: number } | undefined): { url: string; size: number } {
    if (!file?.buffer?.length) throw new BizError(ERR.PARAM, '未接收到文件，请选择图片后重试');
    const ext = ALLOWED_TYPES[String(file.mimetype || '')];
    if (!ext) throw new BizError(ERR.PARAM, '仅支持 PNG / JPG / WEBP / GIF 图片');
    const buffer = file.buffer;
    const matches = ext === '.png' ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : ext === '.jpg' ? buffer.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))
      : ext === '.gif' ? ['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString('ascii'))
      : buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP';
    if (!matches) throw new BizError(ERR.PARAM, '图片内容与声明的格式不一致');
    if (file.buffer.length > MAX_UPLOAD_BYTES) {
      throw new BizError(ERR.PARAM, `图片不能超过 ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB`);
    }

    const dir = uploadDir();
    fs.mkdirSync(dir, { recursive: true });
    const name = `${Date.now()}-${randomBytes(6).toString('hex')}${ext}`;
    fs.writeFileSync(path.join(dir, name), file.buffer);
    return { url: `/uploads/${name}`, size: file.buffer.length };
  }
}
