import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { migrateAntiRevokeCollisionTrigger, upgradeAntiRevokeCollisionSql } from './antiRevokeCollisionTrigger'

const name = 'anti_revoke_block_insert_Msg_fixture'
// Native trigger shape, reduced to columns relevant to physical-row preservation.
const legacy = `CREATE TRIGGER ${name} BEFORE INSERT ON Msg_fixture
WHEN NEW.local_type=10000 AND NEW.message_content<>'recall marker'
 AND EXISTS(SELECT 1 FROM _weflow_anti_revoke_deleted_cache WHERE tbl='Msg_fixture' AND server_id=NEW.server_id)
BEGIN
 INSERT INTO Msg_fixture(server_id,local_type,real_sender_id,message_content)
 SELECT server_id,local_type,real_sender_id,message_content FROM _weflow_anti_revoke_deleted_cache
 WHERE id = (SELECT id FROM _weflow_anti_revoke_deleted_cache
 WHERE tbl='Msg_fixture' AND server_id=NEW.server_id ORDER BY id DESC LIMIT 1);
 DELETE FROM _weflow_anti_revoke_deleted_cache
 WHERE id = (SELECT id FROM _weflow_anti_revoke_deleted_cache
 WHERE tbl='Msg_fixture' AND server_id=NEW.server_id ORDER BY id DESC LIMIT 1);
 INSERT INTO Msg_fixture(server_id,local_type,real_sender_id,message_content)
 VALUES(NEW.server_id,10000,NEW.real_sender_id,'recall marker');
 SELECT RAISE(IGNORE);
END`

function fixture() {
  const db = new DatabaseSync(':memory:')
  db.exec(`CREATE TABLE Msg_fixture(local_id INTEGER PRIMARY KEY,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,message_content TEXT);
    CREATE TABLE _weflow_anti_revoke_deleted_cache(id INTEGER PRIMARY KEY,tbl TEXT,server_id INTEGER,local_type INTEGER,real_sender_id INTEGER,message_content TEXT);
    CREATE TRIGGER capture AFTER DELETE ON Msg_fixture WHEN OLD.local_type<>10000 AND OLD.real_sender_id<>1 BEGIN
      INSERT INTO _weflow_anti_revoke_deleted_cache(tbl,server_id,local_type,real_sender_id,message_content)
      VALUES('Msg_fixture',OLD.server_id,OLD.local_type,OLD.real_sender_id,OLD.message_content);
    END;`)
  db.exec(legacy)
  const execute = vi.fn(async (sql: string) => {
    try { db.exec(sql); return { success: true } } catch (error) { return { success: false, error: String(error) } }
  })
  const recall = () => db.exec(`INSERT INTO Msg_fixture VALUES(NULL,123,1,2,'first'),(NULL,123,1,2,'second');
    DELETE FROM Msg_fixture WHERE server_id=123;
    INSERT INTO Msg_fixture VALUES(NULL,123,10000,2,'recall event');`)
  return { db, execute, recall }
}

describe('anti-revoke server-ID collision preservation', () => {
  it('reproduces the native latest-row-only loss', () => {
    const f = fixture()
    try { f.recall(); expect(f.db.prepare('SELECT message_content FROM Msg_fixture WHERE local_type=1').all()).toEqual([{ message_content: 'second' }]) } finally { f.db.close() }
  })
  it('restores both distinct payloads, consumes both cache rows, and emits one marker', async () => {
    const f = fixture()
    try {
      expect(await migrateAntiRevokeCollisionTrigger(name, legacy, f.execute)).toBe(true)
      f.recall()
      expect(f.db.prepare('SELECT message_content FROM Msg_fixture WHERE local_type=1 ORDER BY message_content').all()).toEqual([{ message_content: 'first' }, { message_content: 'second' }])
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM _weflow_anti_revoke_deleted_cache').get()?.n).toBe(0)
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM Msg_fixture WHERE local_type=10000').get()?.n).toBe(1)
    } finally { f.db.close() }
  })
  it('rolls back a failed replacement and leaves the original trigger functional', async () => {
    const f = fixture()
    try {
      await expect(migrateAntiRevokeCollisionTrigger(name, legacy, async sql => sql.startsWith('CREATE') ? { success: false, error: 'injected DDL failure' } : f.execute(sql))).rejects.toThrow('injected DDL failure')
      expect(f.db.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name)?.sql).toBe(legacy)
      f.recall()
      expect(f.db.prepare('SELECT COUNT(*) AS n FROM Msg_fixture WHERE local_type=1').get()?.n).toBe(1)
    } finally { f.db.close() }
  })
  it('does not rewrite or transact an already upgraded trigger', async () => {
    const execute = vi.fn()
    expect(await migrateAntiRevokeCollisionTrigger(name, upgradeAntiRevokeCollisionSql(legacy).sql, execute)).toBe(false)
    expect(execute).not.toHaveBeenCalled()
  })
  it('refuses an unfamiliar vendor shape before any mutation', async () => {
    const execute = vi.fn()
    await expect(migrateAntiRevokeCollisionTrigger(name, legacy.replaceAll('LIMIT 1', 'LIMIT 2'), execute)).rejects.toThrow('无法识别')
    expect(execute).not.toHaveBeenCalled()
  })
})
