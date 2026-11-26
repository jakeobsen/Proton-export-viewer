// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { parseLabels, LabelsError } from '../../src/core/index/labels';
import { SYSTEM_IDS } from '../../src/core/index/ops';
import { sidebar } from '../../src/core/index/queries';
import { STAMP, fresh, ingest, message } from '../index-helpers';

const file = (payload: unknown[]) => JSON.stringify({ Version: 1, Payload: payload });

describe('labels.json', () => {
  it('knows system folders by ID whatever their Type says', () => {
    const labels = parseLabels(
      file([
        { ID: '0', Name: 'Inbox', Type: 3 },
        { ID: '5', Name: 'All Mail', Type: 1 },
        { ID: '7', Name: 'Sent', Type: 4 },
        { ID: '16', Name: 'Snoozed', Type: 99 },
      ]),
    );
    expect(labels.map((l) => [l.id, l.kind])).toEqual([
      ['0', 'system'],
      ['5', 'system'],
      ['7', 'system'],
      ['16', 'system'],
    ]);
  });

  it('makes Type 3 a folder, Type 1 a label and anything else hidden', () => {
    const labels = parseLabels(
      file([
        { ID: 'f', Name: 'Work', Path: 'Work', Type: 3 },
        { ID: 'l', Name: 'Urgent', Path: 'Urgent', Type: 1 },
        { ID: 'x', Name: 'Odd', Type: 7 },
      ]),
    );
    expect(labels.map((l) => [l.id, l.kind])).toEqual([
      ['f', 'folder'],
      ['l', 'label'],
      ['x', 'other'],
    ]);
  });

  it('nests by ParentID, else by Path, and breaks cycles', () => {
    const labels = parseLabels(
      file([
        { ID: 'a', Name: 'A', Path: 'A', Type: 3 },
        { ID: 'b', Name: 'B', Path: 'A/B', Type: 3 },
        { ID: 'c', Name: 'C', Path: 'Elsewhere/C', ParentID: 'a', Type: 3 },
        { ID: 'd', Name: 'D', Path: 'A/B/D', Type: 3 },
        { ID: 'p', Name: 'P', ParentID: 'q', Type: 1 },
        { ID: 'q', Name: 'Q', ParentID: 'p', Type: 1 },
        // A label's parent must be a label.
        { ID: 'm', Name: 'M', ParentID: 'a', Type: 1 },
      ]),
    );
    const parent = Object.fromEntries(labels.map((l) => [l.id, l.parentId]));
    expect(parent).toMatchObject({ a: null, b: 'a', c: 'a', d: 'b', m: null });
    // One link of the p <-> q cycle is dropped.
    expect([parent.p, parent.q].filter((v) => v !== null)).toHaveLength(1);
  });

  it('keeps only valid colors', () => {
    const labels = parseLabels(
      file([
        { ID: 'a', Name: 'A', Type: 1, Color: '#a1B2c3' },
        { ID: 'b', Name: 'B', Type: 1, Color: 'red' },
        { ID: 'c', Name: 'C', Type: 1, Color: '#abc' },
        { ID: 'd', Name: 'D', Type: 1, Color: 'url(x)' },
        { ID: 'e', Name: 'E', Type: 1, Color: '#a1b2c3;' },
      ]),
    );
    expect(labels.map((l) => l.color)).toEqual(['#a1B2c3', null, null, null, null]);
  });

  it('skips entries without a usable ID and keeps the first of a repeated one', () => {
    const labels = parseLabels(
      file([
        { Name: 'no id' },
        { ID: '', Name: 'empty' },
        { ID: 'a', Name: 'first', Type: 1 },
        { ID: 'a', Name: 'second', Type: 1 },
        null,
        'text',
      ]),
    );
    expect(labels.map((l) => [l.id, l.name])).toEqual([['a', 'first']]);
  });

  it('refuses a file that is not JSON or has no Payload list', () => {
    expect(() => parseLabels('{')).toThrow(LabelsError);
    expect(() => parseLabels('{"Payload":{}}')).toThrow(LabelsError);
  });
});

describe('the sidebar', () => {
  it('lists named folders and labels, system folders by ID, and hides unknown IDs', () => {
    const { db, writer } = fresh();
    writer.writeLabels(
      STAMP,
      parseLabels(
        file([
          { ID: '0', Name: 'Inbox', Type: 3 },
          { ID: '15', Name: 'All Mail', Type: 3 },
          { ID: 'f', Name: 'Work', Type: 3 },
          { ID: 'l', Name: 'Urgent', Type: 1, Color: '#112233' },
          { ID: 'x', Name: 'Odd', Type: 7 },
        ]),
      ),
      '{}',
    );
    ingest(
      writer,
      [
        message('a', ['a'], { labelIds: ['0', '5', 'f', '22'], unread: 1 }),
        message('b', ['b'], { labelIds: ['0', '5', 'l', '24', 'x', '15'] }),
        message('c', ['c', 'a'], { labelIds: ['5', 'f'] }),
      ],
      10,
    );
    const view = sidebar(db, SYSTEM_IDS);
    const byId = Object.fromEntries(view.folders.map((f) => [f.id, f]));
    expect(byId['0']).toMatchObject({ kind: 'system', name: 'Inbox', conversations: 2, unread: 1 });
    expect(byId['5']).toMatchObject({ kind: 'system', name: '', conversations: 2, unread: 1 });
    expect(byId.f).toMatchObject({ kind: 'folder', conversations: 1, unread: 1 });
    expect(byId.l).toMatchObject({ kind: 'label', color: '#112233', conversations: 1, unread: 0 });
    // The duplicate All Mail, an unknown type and IDs labels.json doesn't name stay hidden.
    expect(byId['15']).toBeUndefined();
    expect(byId.x).toBeUndefined();
    expect(byId['22']).toBeUndefined();
    expect(byId['24']).toBeUndefined();
    expect(view.hiddenIds).toBe(2);
    // Every system folder is there, labels.json or not.
    for (const id of SYSTEM_IDS) expect(byId[id]?.kind).toBe('system');
    // Unknown IDs are still stored on their messages.
    const stored = db
      .stmt("SELECT count(*) AS n FROM message_labels WHERE label_id IN ('22','24')")
      .get();
    expect(Number(stored?.n)).toBe(2);
    db.close();
  });

  it('replaces the labels stored before', () => {
    const { db, writer } = fresh();
    const many = Array.from({ length: 1234 }, (_, i) => ({ ID: `l${i}`, Name: `L${i}`, Type: 1 }));
    writer.writeLabels(STAMP, parseLabels(file(many)), '{}');
    writer.writeLabels(STAMP, parseLabels(file([{ ID: 'only', Name: 'Only', Type: 1 }])), '{}');
    const ids = db
      .stmt('SELECT proton_id FROM labels')
      .all()
      .map((r) => String(r.proton_id));
    expect(ids).toEqual(['only']);
    db.close();
  });
});
