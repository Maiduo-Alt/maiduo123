import { BACKUP_FILE_PATTERN, restoreCommand, selectBackupsToDelete } from '../../src/db/backup';

const day = 24 * 60 * 60 * 1000;
const file = (name: string, ageDays: number) => ({ name, mtimeMs: Date.now() - ageDays * day });

describe('数据库备份保留策略（方案 5.10：pg_dump + 保留 30 天）', () => {
  it('只识别本系统的备份文件命名', () => {
    expect(BACKUP_FILE_PATTERN.test('cs_training_20261001-120000.dump')).toBe(true);
    expect(BACKUP_FILE_PATTERN.test('cs_training_20261001-1200.dump')).toBe(false);
    expect(BACKUP_FILE_PATTERN.test('manual.sql')).toBe(false);
    expect(BACKUP_FILE_PATTERN.test('cs_training_20261001-120000.dump.bak')).toBe(false);
  });

  it('保留最新 N 份，其余按由旧到新删除', () => {
    const files = [
      file('cs_training_20260901-010000.dump', 30),
      file('cs_training_20260902-010000.dump', 29),
      file('cs_training_20260903-010000.dump', 28),
      file('cs_training_20260904-010000.dump', 27),
    ];
    expect(selectBackupsToDelete(files, 2)).toEqual([
      'cs_training_20260902-010000.dump',
      'cs_training_20260901-010000.dump',
    ]);
  });

  it('份数未超上限时不删除任何文件', () => {
    const files = [file('cs_training_20261001-010000.dump', 1), file('cs_training_20261001-020000.dump', 0)];
    expect(selectBackupsToDelete(files, 30)).toEqual([]);
    expect(selectBackupsToDelete(files, 2)).toEqual([]);
  });

  it('忽略非本系统命名的文件，避免误删其它备份', () => {
    const files = [
      file('cs_training_20260901-010000.dump', 30),
      file('keep-me.sql', 40),
      file('pgdata.tar.gz', 41),
    ];
    expect(selectBackupsToDelete(files, 0)).toEqual(['cs_training_20260901-010000.dump']);
  });

  it('恢复命令按 pg_restore 的破坏性参数生成，便于运维复核', () => {
    expect(restoreCommand('/backups/a.dump', 'postgres://u:p@h:5432/db')).toEqual([
      'pg_restore',
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--dbname',
      'postgres://u:p@h:5432/db',
      '/backups/a.dump',
    ]);
  });
});
