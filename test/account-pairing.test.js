import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pairMaxAccount } from '../src/account-pairing.js';
import { BridgeDatabase } from '../src/database.js';

test('two users bind MAX only with their own personal codes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'telegram-max-bridge-pairing-'));
  const db = new BridgeDatabase(join(directory, 'bridge.json'));
  try {
    const first = db.registerTelegramOwner('10101');
    const second = db.registerTelegramOwner('20202');
    const firstCode = db.runAsAccount(first, () => db.getSetting('max_pairing_code'));
    const secondCode = db.runAsAccount(second, () => db.getSetting('max_pairing_code'));

    assert.deepEqual(pairMaxAccount({ db, senderId: '50101', text: '/bind SERVER_PAIRING_CODE' }), { status: 'invalid-code' });
    assert.deepEqual(pairMaxAccount({ db, senderId: '50101', text: `/bind ${firstCode}` }), { status: 'paired', accountId: first });
    assert.deepEqual(pairMaxAccount({ db, senderId: '50202', text: `/bind ${secondCode}` }), { status: 'paired', accountId: second });
    assert.equal(db.findAccountByMaxOwner('50101'), first);
    assert.equal(db.findAccountByMaxOwner('50202'), second);

    assert.deepEqual(pairMaxAccount({ db, senderId: '50999', text: `/bind ${firstCode}` }), { status: 'invalid-code' });
    assert.deepEqual(pairMaxAccount({ db, senderId: '50101', text: `/bind ${secondCode}` }), { status: 'invalid-code' });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('ordinary MAX messages are not treated as binding attempts', () => {
  const db = {
    findAccountByMaxPairingCode() { throw new Error('must not be called'); },
    bindMaxOwner() { throw new Error('must not be called'); }
  };
  assert.deepEqual(pairMaxAccount({ db, senderId: '1', text: 'Привет' }), { status: 'not-bind' });
});
