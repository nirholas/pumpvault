import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { JITO_TIP_ACCOUNTS_FALLBACK } from '../src/lib/constants.js';
import { fetchTipAccounts, sendBundle } from '../src/lib/jito.js';

const payer = Keypair.generate();
const signedTx = () => {
  const message = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
    instructions: [SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: Keypair.generate().publicKey, lamports: 1 })],
  }).compileToV0Message();
  const tx = new VersionedTransaction(message);
  tx.sign([payer]);
  return tx;
};

/** A fetch stand-in that answers each call from `responses` in order and records the requests. */
function scripted(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), signal: init.signal });
    const next = responses[calls.length - 1];
    if (next instanceof Error) throw next;
    if (next === 'hang') {
      return new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    }
    return new Response(JSON.stringify(next.body), { status: next.status ?? 200 });
  };
  return { calls, fetchImpl };
}

const ENGINES = ['https://a.example', 'https://b.example', 'https://c.example'];

describe('sendBundle', () => {
  it('submits base64 with the encoding flag, the format the block engine documents', async () => {
    const tx = signedTx();
    const { calls, fetchImpl } = scripted([{ body: { result: 'bundle-1' } }]);
    const result = await sendBundle([tx], { endpoints: ENGINES, fetchImpl });
    expect(result).toEqual({ bundleId: 'bundle-1', endpoint: 'https://a.example' });
    expect(calls[0].url).toBe('https://a.example/api/v1/bundles');
    expect(calls[0].body.method).toBe('sendBundle');
    expect(calls[0].body.params[1]).toEqual({ encoding: 'base64' });
    expect(Buffer.from(calls[0].body.params[0][0], 'base64')).toEqual(Buffer.from(tx.serialize()));
  });

  it('moves to the next region on a timeout, a network error or a 429', async () => {
    const { calls, fetchImpl } = scripted(['hang', new TypeError('fetch failed'), { status: 429, body: {} }, { body: { result: 'b' } }]);
    const result = await sendBundle([signedTx()], { endpoints: [...ENGINES, 'https://d.example'], fetchImpl, timeoutMs: 20 });
    expect(result.endpoint).toBe('https://d.example');
    expect(calls).toHaveLength(4);
  });

  it('stops at the first region that rejects the bundle itself, since no region would accept it', async () => {
    const { calls, fetchImpl } = scripted([{ status: 400, body: { error: { message: 'bundle contains an expired blockhash' } } }]);
    await expect(sendBundle([signedTx()], { endpoints: ENGINES, fetchImpl })).rejects.toThrow(/expired blockhash/);
    expect(calls).toHaveLength(1);
  });

  it('treats a response with no bundle id as a failure', async () => {
    const { fetchImpl } = scripted([{ body: { result: null } }, { body: { result: '' } }, { body: {} }]);
    await expect(sendBundle([signedTx()], { endpoints: ENGINES, fetchImpl })).rejects.toThrow(/every block engine/);
  });

  it('refuses an empty bundle or one over five transactions before contacting anyone', async () => {
    const { calls, fetchImpl } = scripted([]);
    await expect(sendBundle([], { endpoints: ENGINES, fetchImpl })).rejects.toThrow(/1 to 5/);
    const six = Array.from({ length: 6 }, signedTx);
    await expect(sendBundle(six, { endpoints: ENGINES, fetchImpl })).rejects.toThrow(/1 to 5/);
    expect(calls).toHaveLength(0);
  });
});

describe('fetchTipAccounts', () => {
  const live = [Keypair.generate().publicKey.toBase58(), Keypair.generate().publicKey.toBase58()];

  it('returns the live list when the block engine answers', async () => {
    const { fetchImpl } = scripted([{ body: { result: live } }]);
    expect(await fetchTipAccounts(ENGINES, { fetchImpl })).toEqual(live);
  });

  it('drops entries that are not addresses, and falls through when none are left', async () => {
    const { fetchImpl } = scripted([
      { body: { result: ['not-an-address', 42, null] } },
      { body: { result: [live[0], 'garbage'] } },
    ]);
    expect(await fetchTipAccounts(ENGINES, { fetchImpl })).toEqual([live[0]]);
  });

  it('falls back to the pinned snapshot when every region fails or hangs', async () => {
    const { fetchImpl } = scripted(['hang', new TypeError('offline'), { status: 503, body: {} }]);
    expect(await fetchTipAccounts(ENGINES, { fetchImpl, timeoutMs: 20 })).toBe(JITO_TIP_ACCOUNTS_FALLBACK);
  });
});
