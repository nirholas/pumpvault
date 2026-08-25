import { describe, expect, it } from 'vitest';
import { Keypair, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  mergePlans, planCollect, planDrainSol, planLaunch, planRescueTokens,
} from '../src/lib/atomic.js';
import { RENT_EXEMPT_MIN_LAMPORTS } from '../src/lib/constants.js';

const funder = Keypair.generate();
const creator = Keypair.generate();
const mint = Keypair.generate();
const destination = Keypair.generate().publicKey;
const tipAccount = Keypair.generate().publicKey;
const TIP = 1_000_000;

/** Stand-in for an SDK instruction; the planners only position them, never inspect them. */
const dummyIx = () => new TransactionInstruction({
  keys: [], programId: Keypair.generate().publicKey, data: Buffer.alloc(0),
});

const transfersIn = (tx) => tx.instructions
  .filter((ix) => ix.programId.equals(SystemProgram.programId))
  .map((ix) => ({ lamports: Number(ix.data.readBigUInt64LE(4)), to: ix.keys[1].pubkey.toBase58(), from: ix.keys[0].pubkey.toBase58() }));

describe('planLaunch', () => {
  const base = {
    funder, mint, createInstructions: [dummyIx()],
    devBuyLamports: 20_000_000, rentLamports: 30_000_000, tipLamports: TIP, tipAccount,
  };

  it('uses one transaction when the payer is also the creator', () => {
    const plan = planLaunch({ ...base, creator: funder });
    expect(plan.txs).toHaveLength(1);
    expect(plan.summary.mode).toBe('single');
    expect(plan.txs[0].signers).toContain(mint);
  });

  it('tips exactly once, from the funder', () => {
    const plan = planLaunch({ ...base, creator: funder });
    const tips = transfersIn(plan.txs[0]).filter((t) => t.to === tipAccount.toBase58());
    expect(tips).toHaveLength(1);
    expect(tips[0].lamports).toBe(TIP);
    expect(tips[0].from).toBe(funder.publicKey.toBase58());
  });

  it('splits into a funding tx and a create tx when the creator differs, so the creator needs no SOL first', () => {
    const plan = planLaunch({ ...base, creator });
    expect(plan.txs).toHaveLength(2);
    expect(plan.summary.mode).toBe('funded');
    expect(plan.txs[1].payer.toBase58()).toBe(creator.publicKey.toBase58());
  });

  it('forwards exactly the rent plus the dev buy to the creator', () => {
    const plan = planLaunch({ ...base, creator });
    const forward = transfersIn(plan.txs[0]).find((t) => t.to === creator.publicKey.toBase58());
    expect(forward.lamports).toBe(30_000_000 + 20_000_000);
    expect(plan.summary.forwardedLamports).toBe(50_000_000);
  });

  it('keeps the tip out of the create transaction, so only the funder pays it', () => {
    const plan = planLaunch({ ...base, creator });
    expect(transfersIn(plan.txs[1])).toHaveLength(0);
  });

  it('totals what actually leaves the funder', () => {
    expect(planLaunch({ ...base, creator }).summary.totalLamports).toBe(30_000_000 + 20_000_000 + TIP);
  });
});

describe('planCollect', () => {
  const base = {
    funder, creator, collectInstructions: [dummyIx()],
    vaultLamports: 5_000_000, creatorBalanceLamports: 2_000_000, tipLamports: TIP, tipAccount,
  };

  it('claims in place when no destination is given', () => {
    const plan = planCollect(base);
    expect(transfersIn(plan.txs[0]).filter((t) => t.to !== tipAccount.toBase58())).toHaveLength(0);
    expect(plan.summary.destination).toBe(creator.publicKey.toBase58());
    expect(plan.summary.drainLamports).toBe(0);
  });

  it('collects and forwards in the same transaction, leaving no window for a sweeper', () => {
    const plan = planCollect({ ...base, destination });
    expect(plan.txs).toHaveLength(1);
    const drain = transfersIn(plan.txs[0]).find((t) => t.to === destination.toBase58());
    expect(drain.lamports).toBe(2_000_000 + 5_000_000 - RENT_EXEMPT_MIN_LAMPORTS);
    expect(drain.from).toBe(creator.publicKey.toBase58());
  });

  it('leaves the creator rent exempt so the account is not purged', () => {
    const plan = planCollect({ ...base, destination });
    expect(plan.summary.keepLamports).toBe(RENT_EXEMPT_MIN_LAMPORTS);
  });

  it('treats a destination equal to the creator as a plain claim, not a self transfer', () => {
    const plan = planCollect({ ...base, destination: creator.publicKey.toBase58() });
    expect(plan.summary.drainLamports).toBe(0);
  });

  it('reserves the tip when the creator is also paying, so the drain cannot overdraw it', () => {
    const plan = planCollect({ ...base, funder: creator, destination });
    const drain = transfersIn(plan.txs[0]).find((t) => t.to === destination.toBase58());
    expect(drain.lamports).toBeLessThan(2_000_000 + 5_000_000 - RENT_EXEMPT_MIN_LAMPORTS);
    expect(drain.lamports).toBe(2_000_000 + 5_000_000 - RENT_EXEMPT_MIN_LAMPORTS - TIP - 100_000);
  });

  it('signs once when the funder and creator are the same wallet', () => {
    const plan = planCollect({ ...base, funder: creator, destination });
    expect(plan.txs[0].signers).toHaveLength(1);
  });

  it('refuses when the vault cannot even cover the rent-exempt buffer', () => {
    expect(() => planCollect({ ...base, vaultLamports: 0, creatorBalanceLamports: 1000, destination }))
      .toThrow(/Nothing to move/);
  });
});

describe('planDrainSol', () => {
  const base = { funder, from: creator, destination, balanceLamports: 3_000_000, tipLamports: TIP, tipAccount };

  it('moves the whole balance when nothing is held back', () => {
    const drain = transfersIn(planDrainSol(base).txs[0]).find((t) => t.to === destination.toBase58());
    expect(drain.lamports).toBe(3_000_000);
  });

  it('honours a keep amount', () => {
    const plan = planDrainSol({ ...base, keepLamports: RENT_EXEMPT_MIN_LAMPORTS });
    const drain = transfersIn(plan.txs[0]).find((t) => t.to === destination.toBase58());
    expect(drain.lamports).toBe(3_000_000 - RENT_EXEMPT_MIN_LAMPORTS);
  });

  it('makes the clean funder pay the fee, never the exposed wallet', () => {
    const plan = planDrainSol(base);
    expect(plan.txs[0].payer.toBase58()).toBe(funder.publicKey.toBase58());
  });

  it('refuses to drain a wallet into itself', () => {
    expect(() => planDrainSol({ ...base, from: funder })).toThrow(/different wallet/);
  });

  it('refuses when the balance is already below the keep amount', () => {
    expect(() => planDrainSol({ ...base, balanceLamports: 100, keepLamports: 1000 })).toThrow(/already below/);
  });
});

describe('planRescueTokens', () => {
  const token = (i) => ({
    mint: Keypair.generate().publicKey.toBase58(),
    program: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6, amountRaw: String(1000 + i),
  });
  const base = { funder, from: creator, destinationOwner: destination.toBase58(), tipLamports: TIP, tipAccount };

  it('fits three tokens in one transaction', () => {
    expect(planRescueTokens({ ...base, tokens: [token(0), token(1), token(2)] }).txs).toHaveLength(1);
  });

  it('splits past three so no transaction exceeds the size budget', () => {
    expect(planRescueTokens({ ...base, tokens: [0, 1, 2, 3].map(token) }).txs).toHaveLength(2);
  });

  it('tips only on the first transaction of the bundle', () => {
    const plan = planRescueTokens({ ...base, tokens: [0, 1, 2, 3].map(token) });
    expect(transfersIn(plan.txs[0]).filter((t) => t.to === tipAccount.toBase58())).toHaveLength(1);
    expect(transfersIn(plan.txs[1])).toHaveLength(0);
  });

  it('creates the destination token account idempotently, paid by the funder', () => {
    const plan = planRescueTokens({ ...base, tokens: [token(0)] });
    const ataIx = plan.txs[0].instructions.find((ix) => ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID));
    expect(ataIx.keys[0].pubkey.toBase58()).toBe(funder.publicKey.toBase58());
  });

  it('refuses an empty selection', () => {
    expect(() => planRescueTokens({ ...base, tokens: [] })).toThrow(/at least one token/);
  });

  it('refuses more tokens than a bundle can carry', () => {
    expect(() => planRescueTokens({ ...base, tokens: Array.from({ length: 16 }, (_, i) => token(i)) })).toThrow(/at most 15/i);
  });
});

describe('mergePlans', () => {
  it('concatenates transactions and keeps each summary', () => {
    const a = planDrainSol({ funder, from: creator, destination, balanceLamports: 2_000_000, tipLamports: TIP, tipAccount });
    const b = planRescueTokens({
      funder, from: creator, destinationOwner: destination.toBase58(), tipLamports: 0, tipAccount,
      tokens: [{ mint: Keypair.generate().publicKey.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, amountRaw: '1' }],
    });
    const merged = mergePlans(a, b);
    expect(merged.txs).toHaveLength(2);
    expect(merged.summary.parts.map((p) => p.kind)).toEqual(['drain', 'rescue-tokens']);
  });

  it('refuses a bundle over the five transaction limit', () => {
    const tokens = Array.from({ length: 15 }, () => ({ mint: Keypair.generate().publicKey.toBase58(), program: TOKEN_PROGRAM_ID.toBase58(), decimals: 6, amountRaw: '1' }));
    const big = planRescueTokens({ funder, from: creator, destinationOwner: destination.toBase58(), tokens, tipLamports: TIP, tipAccount });
    const drain = planDrainSol({ funder, from: creator, destination, balanceLamports: 2_000_000, tipLamports: 0, tipAccount });
    expect(() => mergePlans(big, drain)).toThrow(/at most 5/);
  });
});
