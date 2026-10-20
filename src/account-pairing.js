function bindCommand(text) {
  const match = String(text ?? '').trim().match(/^(\S+)(?:\s+(\S+))?$/);
  return {
    command: (match?.[1] ?? '').toLowerCase(),
    code: (match?.[2] ?? '').trim()
  };
}

export function pairMaxAccount({ db, senderId, text }) {
  const { command, code } = bindCommand(text);
  if (command !== '/bind') return { status: 'not-bind' };
  if (!code) return { status: 'invalid-code' };

  const accountId = db.findAccountByMaxPairingCode(code);
  if (!accountId) return { status: 'invalid-code' };
  if (!db.bindMaxOwner(accountId, senderId)) return { status: 'max-owner-already-used' };
  return { status: 'paired', accountId };
}
