// SPDX-License-Identifier: AGPL-3.0-or-later
// The per-export index schema the bench writes and queries.

import { randomUUID } from 'node:crypto';
import { CRISIS_MERGE } from './limits';
import type { Db } from './sql';

export const SCHEMA_VERSION = 1;

/** Kept out of stored text, so snippet and highlight markers are unambiguous. */
export const MARK_START = '';
export const MARK_END = '';

export const BODY_STATE = {
  pending: 0,
  indexed: 1,
  truncated: 2,
  failed: 3,
  emlMissing: 4,
} as const;

const tables = (prefix: string) => `
CREATE TABLE messages(
  rowid INTEGER PRIMARY KEY, proton_id TEXT UNIQUE NOT NULL, time INT, subject TEXT,
  sender_name TEXT, sender_addr TEXT, to_json, cc_json, bcc_json, reply_to_json,
  flags INT, unread INT, replied INT, replied_all INT, forwarded INT, size INT,
  num_attachments INT, mime_type TEXT, message_id TEXT, in_reply_to TEXT,
  references_json TEXT, dmarc TEXT,
  thread_id INT NOT NULL);
CREATE INDEX messages_thread_time ON messages(thread_id, time);
CREATE TABLE pairs(
  proton_id TEXT PRIMARY KEY, file_id TEXT UNIQUE NOT NULL, rev INT NOT NULL,
  meta_rel TEXT, meta_size INT, meta_mtime_ns INT, meta_dev INT, meta_ino INT, meta_state INT,
  eml_rel TEXT, eml_size INT, eml_mtime_ns INT, eml_dev INT, eml_ino INT,
  body_state INT, error_code TEXT);
CREATE TABLE labels(proton_id TEXT PRIMARY KEY, name, path, parent_id, color, type INT, kind TEXT);
CREATE TABLE message_labels(message_rowid INT, label_id TEXT,
  PRIMARY KEY(message_rowid, label_id)) WITHOUT ROWID;
CREATE INDEX message_labels_label ON message_labels(label_id, message_rowid);
CREATE TABLE attachments(message_rowid INT, idx INT, filename, mime, size INT, content_id,
  source TEXT, PRIMARY KEY(message_rowid, idx));
CREATE TABLE message_text(rowid INTEGER PRIMARY KEY, subject, sender, recipients, body, attachments);
CREATE VIRTUAL TABLE fts USING fts5(subject, sender, recipients, body, attachments,
  content='message_text', content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'${prefix ? `, prefix='${prefix}'` : ''});
CREATE TRIGGER message_text_ai AFTER INSERT ON message_text BEGIN
  INSERT INTO fts(rowid, subject, sender, recipients, body, attachments)
  VALUES (new.rowid, new.subject, new.sender, new.recipients, new.body, new.attachments);
END;
CREATE TRIGGER message_text_ad AFTER DELETE ON message_text BEGIN
  INSERT INTO fts(fts, rowid, subject, sender, recipients, body, attachments)
  VALUES ('delete', old.rowid, old.subject, old.sender, old.recipients, old.body, old.attachments);
END;
CREATE TRIGGER message_text_au AFTER UPDATE ON message_text BEGIN
  INSERT INTO fts(fts, rowid, subject, sender, recipients, body, attachments)
  VALUES ('delete', old.rowid, old.subject, old.sender, old.recipients, old.body, old.attachments);
  INSERT INTO fts(rowid, subject, sender, recipients, body, attachments)
  VALUES (new.rowid, new.subject, new.sender, new.recipients, new.body, new.attachments);
END;
CREATE TABLE recent_searches(id INTEGER PRIMARY KEY, q TEXT, at INT);
CREATE TABLE threads(thread_id INTEGER PRIMARY KEY, msg_count INT, unread_count INT,
  attach_count INT, first_time INT, last_time INT);
CREATE TABLE thread_keys(key TEXT PRIMARY KEY, thread_id INT NOT NULL) WITHOUT ROWID;
CREATE INDEX thread_keys_thread ON thread_keys(thread_id);
CREATE TABLE thread_labels(label_id TEXT, thread_id INT, last_time INT, msg_count INT,
  unread_count INT, PRIMARY KEY(label_id, thread_id)) WITHOUT ROWID;
CREATE INDEX thread_labels_list ON thread_labels(label_id, last_time DESC, thread_id DESC);
CREATE TABLE source_meta(key TEXT PRIMARY KEY, value);
`;

export const FTS_PREFIX = '2 3';

/** Creates the schema in an empty database and returns its new identity. */
export function createSchema(db: Db, prefix: string = FTS_PREFIX): string {
  if (!/^[0-9 ]*$/.test(prefix)) throw new Error('bad prefix list');
  const uuid = randomUUID();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(tables(prefix.trim()));
    // Merges run only as explicit bounded steps, never inside a write.
    db.exec("INSERT INTO fts(fts, rank) VALUES ('automerge', 0)");
    db.exec(`INSERT INTO fts(fts, rank) VALUES ('crisismerge', ${CRISIS_MERGE})`);
    const put = db.stmt('INSERT INTO source_meta(key, value) VALUES (?, ?)');
    put.run('db_uuid', uuid);
    put.run('rev_seq', 0);
    put.run('generation', 1);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // No transaction left to roll back.
    }
    throw err;
  }
  return uuid;
}

/** The checks an open does before it shows anything: schema version and identity. */
export function checkIdentity(db: Db, expectedUuid: string): boolean {
  const version = Number(db.stmt('PRAGMA user_version').get()?.user_version);
  const uuid = db.stmt("SELECT value FROM source_meta WHERE key = 'db_uuid'").get()?.value;
  return version === SCHEMA_VERSION && uuid === expectedUuid;
}
