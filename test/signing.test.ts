import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashDomain, recoverTypedDataAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DOMAINS, TYPES } from '../src/constants.ts';
import { signIntent } from '../src/papertrade/signing.ts';

test('exchange domain separator prefix matches on-chain SessionKeyManager.DOMAIN_SEPARATOR()', () => {
  const sep = hashDomain({
    domain: DOMAINS.exchange as never,
    types: { EIP712Domain: [
      { name: 'name', type: 'string' }, { name: 'version', type: 'string' },
      { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' },
    ] },
  });
  assert.ok(sep.startsWith('0x53a2ab5a') && sep.endsWith('7e77'), sep);
});

test('signed open intent is normalised like the frontend and recovers to the signer', async () => {
  const acct = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
  const msg = {
    user: '0x00000000000000000000000000000000000000AA', instrumentId: 0, isLong: true,
    size: 10n * 10n ** 18n, leverage: 1000, useDebt: false, nonce: 12345n, deadline: 1800000000n,
  };
  const { signed, intentId } = await signIntent(acct, DOMAINS.exchange, 'OpenPosition', msg);
  assert.equal(signed.instrumentId, '0');
  assert.equal(signed.leverage, '1000');
  assert.equal(signed.size, '10000000000000000000');
  assert.equal(signed.isLong, true);
  assert.equal(signed.user, '0x00000000000000000000000000000000000000aa');
  assert.match(String(signed.v), /^2[78]$/);
  assert.match(intentId, /^0x[0-9a-f]{64}$/);
  const sig = `${signed.r}${String(signed.s).slice(2)}${(Number(signed.v)).toString(16)}` as `0x${string}`;
  const rec = await recoverTypedDataAddress({
    domain: DOMAINS.exchange, types: { OpenPosition: TYPES.OpenPosition }, primaryType: 'OpenPosition',
    message: msg, signature: sig,
  } as Parameters<typeof recoverTypedDataAddress>[0]);
  assert.equal(rec, acct.address);
});
