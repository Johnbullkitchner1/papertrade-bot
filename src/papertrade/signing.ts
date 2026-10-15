// EIP-712 intent signing, matching the official frontend byte-for-byte:
// sign with typed values, then send every uint as a decimal string, addresses lowercase,
// v as "27"/"28", and derive the intentId exactly as the relayer does.

import { concat, hashTypedData, keccak256, parseSignature, recoverAddress, toBytes, type LocalAccount } from 'viem';
import { TYPES, type IntentType } from '../constants.ts';

type Domain = { name: string; version: string; chainId: number; verifyingContract: `0x${string}` | string };

const INTENT_ID_SALT = keccak256(toBytes('papertrade:intent-id:v2'));

export interface SignedIntent {
  signed: Record<string, unknown>;
  intentId: `0x${string}`;
}

function normalise(type: string, v: unknown): unknown {
  if (type === 'uint256[]') return (v as (bigint | number | string)[]).map((x) => BigInt(x).toString());
  if (type.startsWith('uint')) return BigInt(v as bigint | number | string).toString();
  if (type === 'address' || type.startsWith('bytes')) return String(v).toLowerCase();
  return v;
}

export async function signIntent(
  signer: LocalAccount, domain: Domain, primaryType: IntentType, message: Record<string, unknown>,
): Promise<SignedIntent> {
  const fields = TYPES[primaryType];
  const types = { [primaryType]: fields } as Record<string, readonly { name: string; type: string }[]>;
  const typedDomain = { ...domain, verifyingContract: domain.verifyingContract as `0x${string}` };
  const sig = await signer.signTypedData({ domain: typedDomain, types, primaryType, message } as never);
  const out: Record<string, unknown> = {};
  for (const { name, type } of fields) out[name] = normalise(type, message[name]);
  const { r, s, yParity } = parseSignature(sig);
  out.v = String(27 + (yParity ?? 0));
  out.r = r.toLowerCase();
  out.s = s.toLowerCase();

  const digest = hashTypedData({ domain: typedDomain, types, primaryType, message } as never);
  const recovered = (await recoverAddress({ hash: digest, signature: sig })).toLowerCase() as `0x${string}`;
  if (recovered !== signer.address.toLowerCase()) throw new Error('signature recovery mismatch');
  const intentId = keccak256(concat([INTENT_ID_SALT, digest, recovered]));
  return { signed: out, intentId };
}

/** Unordered random nonce; the contracts only check isNonceUsed(user, nonce). */
export function randomNonce(): bigint {
  const b = crypto.getRandomValues(new Uint8Array(31));
  return BigInt('0x' + Buffer.from(b).toString('hex'));
}

export const deadline = (sec = 3600) => BigInt(Math.floor(Date.now() / 1000) + sec);
