import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { loadEnv } from './env';

/**
 * 数据库备份与保留策略（方案 5.10：每日自动备份 PostgreSQL，pg_dump + 保留 30 天）。
 *
 * 用法：
 *   npm run backup -w backend                 # 生成一份备份并按保留份数清理旧文件
 *   npm run backup -w backend -- --restore <文件>   # 恢复（需同时设置 CONFIRM_RESTORE=yes）
 *
 * 环境变量：
 *   DATABASE_URL  必填，目标库连接串
 *   BACKUP_DIR    备份目录，默认 <backend>/backups
 *   BACKUP_KEEP   保留份数，默认 30
 */
export const BACKUP_FILE_PATTERN = /^cs_training_\d{8}-\d{6}\.dump$/;

/** 按保留份数挑出需要删除的旧备份（保留最新的 keep 份）。 */
export function selectBackupsToDelete(files: { name: string; mtimeMs: number }[], keep: number): string[] {
  const candidates = files
    .filter((file) => BACKUP_FILE_PATTERN.test(file.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(Math.max(0, keep)).map((file) => file.name);
}

/** 恢复命令（pg_restore 会先清空同名对象，执行前务必确认目标库）。 */
export function restoreCommand(file: string, databaseUrl: string): string[] {
  return ['pg_restore', '--clean', '--if-exists', '--no-owner', '--no-privileges', '--dbname', databaseUrl, file];
}

function timestamp(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function assertTool(name: string): void {
  const probe = spawnSync(name, ['--version'], { encoding: 'utf8' });
  if (probe.error) {
    throw new Error(`未找到 ${name}，请先安装 PostgreSQL 客户端工具（postgresql-client）`);
  }
}

function resolveTarget(): { url: string; dir: string; keep: number } {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('未配置 DATABASE_URL，无法备份');
  if (String(process.env.USE_PG_MEM || '').toLowerCase() === 'true') {
    throw new Error('当前是内存数据库模式（USE_PG_MEM=true），没有可备份的数据库；请连接真实 PostgreSQL 后重试');
  }
  const dir = process.env.BACKUP_DIR || path.resolve(process.cwd(), 'backups');
  return { url, dir, keep: Number(process.env.BACKUP_KEEP || 30) };
}

/** 执行一次备份，并按保留份数清理旧备份。 */
export function runBackup(): { file: string; removed: string[] } {
  const { url, dir, keep } = resolveTarget();
  assertTool('pg_dump');
  fs.mkdirSync(dir, { recursive: true });

  const file = path.join(dir, `cs_training_${timestamp()}.dump`);
  const result = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file, url], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    throw new Error(`pg_dump 执行失败：${(result.stderr || '').trim() || `退出码 ${result.status}`}`);
  }

  const entries = fs
    .readdirSync(dir)
    .map((name) => ({ name, mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs }));
  const removed = selectBackupsToDelete(entries, keep);
  for (const name of removed) fs.unlinkSync(path.join(dir, name));

  return { file, removed };
}

/** 从备份恢复（破坏性操作，必须显式确认）。 */
export function runRestore(file: string): void {
  const { url } = resolveTarget();
  if (String(process.env.CONFIRM_RESTORE || '') !== 'yes') {
    throw new Error(`恢复会覆盖目标库现有数据。确认无误后请设置 CONFIRM_RESTORE=yes 重试。\n命令：${restoreCommand(file, url).join(' ')}`);
  }
  if (!fs.existsSync(file)) throw new Error(`备份文件不存在：${file}`);
  assertTool('pg_restore');
  const result = spawnSync('pg_restore', restoreCommand(file, url), { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`pg_restore 执行失败：${(result.stderr || '').trim() || `退出码 ${result.status}`}`);
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const restoreIndex = args.indexOf('--restore');
  if (restoreIndex >= 0) {
    const file = args[restoreIndex + 1];
    if (!file) throw new Error('请提供要恢复的备份文件路径：--restore <文件>');
    runRestore(file);
    // eslint-disable-next-line no-console
    console.log(`[backup] 已从 ${file} 恢复完成`);
    return;
  }
  const result = runBackup();
  // eslint-disable-next-line no-console
  console.log(`[backup] 已生成备份：${result.file}`);
  if (result.removed.length) {
    // eslint-disable-next-line no-console
    console.log(`[backup] 按保留策略删除 ${result.removed.length} 个旧备份：${result.removed.join(', ')}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[backup] 失败:', err.message);
    process.exit(1);
  });
}
