/**
 * The arithmetic: boundary balances against the flows instructions proved.
 *
 * Two things happen here, and nothing else:
 *
 * 1. **Sizing.** Some instructions prove a movement without stating its size —
 *    what a closed account returns, what an Associated Token Account create
 *    deposited. Those amounts are filled in only when the transaction's own
 *    balances determine them exactly, and never otherwise.
 * 2. **Reconciliation.** Every account's exact net change is compared with the
 *    sum of the committed flows that touch it. A non-zero remainder is *not*
 *    turned into an effect: it becomes an entry in `unattributedEffects` with its
 *    sign, its size, and its candidate instructions.
 *
 * The rule that keeps this honest: **an instruction proves relationships, a
 * balance proves amounts.** Nothing here invents a counterparty from a delta —
 * with one narrow case that is not really an exception: when a flow an
 * instruction *already proved* is the only movement left that could explain an
 * account's remainder, and both of its endpoints independently agree on the size
 * to the lamport, then that flow's amount is measured as that remainder. The
 * relationship came from the instruction; reconciliation only sized it.
 *
 * Order of work matters and is deliberate:
 *   token nets → sol nets → size close returns → size create deposits →
 *   residual-based sizing → assemble nets → close composition → unattributed.
 */

import { refLabel, type InstructionRef } from '../decode/actions.ts';
import { SYSTEM_PROGRAM_ID } from '../decode/programs.ts';
import { compareStrings } from '../lib/format.ts';
import type {
  AccountLifecycleEffect,
  EffectsAccountRow,
  EffectsDiagnostic,
  EffectsInput,
  EffectsTokenRow,
  OwnerMintNet,
  Reconciliation,
  SolAccountNet,
  SolFlow,
  TokenAccountMintNet,
  TokenFlow,
  UnattributedEffect,
} from './model.ts';
import type { Claims } from './claims.ts';
import { isNativeMint } from './native.ts';

/** How many resolution passes to run; each pass resolves at least one flow. */
const MAX_RESOLUTION_PASSES = 4;

/** Execution order of an instruction, for "what happened before the close" questions. */
const ORDER_STRIDE = 1000;
function orderKey(ref: InstructionRef | null): number {
  // The fee is charged before execution begins, so it sorts before everything.
  if (ref === null) return -1;
  const outer = ref.outerIndex ?? ref.index;
  const inner = ref.path === 'inner' ? ref.index + 1 : 0;
  return outer * ORDER_STRIDE + inner;
}

/** Signed contribution of one flow to one account. */
interface Touch {
  readonly direction: 1 | -1;
}

function solTouches(flow: SolFlow, address: string): Touch[] {
  const result: Touch[] = [];
  if (flow.from === address) result.push({ direction: -1 });
  if (flow.to === address) result.push({ direction: 1 });
  return result;
}

function tokenTouches(flow: TokenFlow, address: string): Touch[] {
  const result: Touch[] = [];
  // A token account is one side of the movement; `mint`/`burn` name only one side
  // (the other side is supply, which has no account).
  if (flow.sourceTokenAccount === address) result.push({ direction: -1 });
  if (flow.destinationTokenAccount === address) result.push({ direction: 1 });
  return result;
}

const solAmount = (flow: SolFlow): bigint | null => flow.lamports;
const tokenAmount = (flow: TokenFlow): bigint | null => flow.amount;

/** What the committed flows say moved in or out of one account. */
interface Ledger {
  credit: bigint;
  debit: bigint;
  /** Refs of flows touching this account whose amount is unknown, in flow order. */
  readonly unobservable: InstructionRef[];
}

function buildLedger<T>(
  flows: readonly T[],
  addressOf: (flow: T, address: string) => Touch[],
  address: string,
  amountOf: (flow: T) => bigint | null,
  refOf: (flow: T) => InstructionRef | null,
): Ledger {
  const ledger: Ledger = { credit: 0n, debit: 0n, unobservable: [] };
  for (const flow of flows) {
    for (const touch of addressOf(flow, address)) {
      const amount = amountOf(flow);
      if (amount === null) {
        const ref = refOf(flow);
        if (ref !== null && !ledger.unobservable.some(existing => sameRef(existing, ref))) {
          ledger.unobservable.push(ref);
        }
        continue;
      }
      if (touch.direction === 1) ledger.credit += amount;
      else ledger.debit += amount;
    }
  }
  return ledger;
}

export interface ReconciledEffects {
  readonly solFlows: readonly SolFlow[];
  readonly tokenFlows: readonly TokenFlow[];
  readonly lifecycle: readonly AccountLifecycleEffect[];
  readonly netSolByAccount: readonly SolAccountNet[];
  readonly netTokenByAccountMint: readonly TokenAccountMintNet[];
  readonly netTokenByOwnerMint: readonly OwnerMintNet[];
  readonly unattributed: readonly UnattributedEffect[];
  readonly diagnostics: readonly EffectsDiagnostic[];
}

export function reconcile(input: EffectsInput, claims: Claims): ReconciledEffects {
  const diagnostics: EffectsDiagnostic[] = [];
  const solFlows: SolFlow[] = [...claims.solFlows];
  const tokenFlows: TokenFlow[] = [...claims.tokenFlows];
  const lifecycle: AccountLifecycleEffect[] = [...claims.lifecycle];

  const rowByAddress = new Map<string, EffectsAccountRow>();
  for (const row of input.accounts) {
    if (row.address !== null) rowByAddress.set(row.address, row);
  }
  const tokenRowsByAddress = new Map<string, EffectsTokenRow[]>();
  for (const row of input.tokenRows) {
    if (row.address === null) continue;
    const list = tokenRowsByAddress.get(row.address);
    if (list === undefined) tokenRowsByAddress.set(row.address, [row]);
    else list.push(row);
  }

  /* --------------------------------------------- what instructions committed */

  // Only committed creates/closes may inform how a balance is read: after a
  // rollback no account was actually created or closed.
  const createdAddresses = new Set<string>();
  const closedAddresses = new Set<string>();
  for (const effect of lifecycle) {
    if (effect.commitState !== 'committed') continue;
    if (effect.kind === 'account-created' && effect.address !== null) createdAddresses.add(effect.address);
    if (effect.kind === 'token-account-create' && effect.outcome === 'created' && effect.address !== null) {
      createdAddresses.add(effect.address);
    }
    if (effect.kind === 'token-account-closed' && effect.address !== null) closedAddresses.add(effect.address);
  }

  /* ------------------------------------------------ exact nets (facts first) */

  const solNets = new Map<string, bigint>();
  for (const row of input.accounts) {
    if (row.address === null) continue;
    if (row.beforeLamports === null || row.afterLamports === null) continue;
    solNets.set(row.address, row.afterLamports - row.beforeLamports);
  }

  interface TokenNet {
    readonly row: EffectsTokenRow;
    readonly startingAmountSource: TokenAccountMintNet['startingAmountSource'];
    readonly net: bigint | null;
  }
  const tokenNets: TokenNet[] = input.tokenRows.map(row => {
    const startingAmountSource = startingSourceFor(row, createdAddresses);
    return { row, startingAmountSource, net: netTokenFor(row, startingAmountSource, closedAddresses) };
  });
  const tokenNetByAddress = new Map<string, TokenNet>();
  for (const entry of tokenNets) {
    if (entry.row.address !== null) tokenNetByAddress.set(entry.row.address, entry);
  }

  // ------------------------------------------- sizing: ATA create deposits

  // An Associated Token Account create funds the new account by CPI into the
  // System Program; the instruction never states how much. The inner
  // `system.createAccount`, when the node recorded it, does state it; otherwise
  // the new account's own lamport delta is exactly the deposit.
  const redundant: number[] = [];
  for (let index = 0; index < solFlows.length; index += 1) {
    const flow = solFlows[index];
    if (flow === undefined) continue;
    if (flow.kind !== 'account-create-deposit' || flow.lamports !== null) continue;
    if (flow.actionKind !== 'associated-token-account.create' || flow.commitState !== 'committed') continue;
    const address = flow.to;
    if (address === null) continue;

    const innerCreate = solFlows.find(
      other =>
        other !== flow && other.actionKind === 'system.createAccount' && other.to === address && other.lamports !== null,
    );
    if (innerCreate !== undefined) {
      // The Associated Token Account program funds the new account by CPI into the
      // System Program, so the lamport movement belongs to that inner instruction.
      // Keeping a second, unresolved flow for the same lamports would double-count
      // one movement and block the close it may be paired with from being sized.
      redundant.push(index);
      setCreateDeposit(lifecycle, flow.ref, address, innerCreate.lamports ?? 0n, 'instruction-data');
      diagnostics.push({
        level: 'info',
        code: 'effects-create-deposit-stated-elsewhere',
        message:
          `${label(flow.ref)} creates a token account; the lamport movement is the system.createAccount it makes at ` +
          `${label(innerCreate.ref)} (${innerCreate.lamports} lamports), which is recorded as its own flow rather than counted twice.`,
        ref: flow.ref,
      });
      continue;
    }

    const delta = solNets.get(address) ?? null;
    const others = solFlows.filter(
      (other, otherIndex) => otherIndex !== index && (other.from === address || other.to === address),
    );
    if (delta !== null && delta > 0n && others.length === 0) {
      solFlows[index] = { ...flow, lamports: delta, amountSource: 'balance-reconciliation', confidence: 'reconciled' };
      setCreateDeposit(lifecycle, flow.ref, address, delta, 'balance-reconciliation');
    } else {
      diagnostics.push({
        level: 'info',
        code: 'effects-create-deposit-not-observable',
        message:
          `${label(flow.ref)} creates a token account whose deposit boundary balances cannot determine ` +
          (delta === null
            ? '(the account has no usable lamport row).'
            : delta === 0n
              ? '(the account was created and closed within this transaction, so its balance starts and ends at zero).'
              : '(other instructions moved lamports in or out of it).'),
        ref: flow.ref,
      });
    }
  }

  if (redundant.length > 0) {
    for (const index of [...redundant].sort((a, b) => b - a)) solFlows.splice(index, 1);
  }

  // ------------------------------------------------- sizing: close returns

  // `spl-token.closeAccount` sweeps the account's whole lamport balance to the
  // destination, so the amount is exactly "the balance at close time". Boundary
  // balances show the start and the end of the transaction, so the amount is
  // recoverable when nothing moved lamports in or out of the account after the
  // close, and everything that did move before it is itself known.
  //
  // An account created inside this transaction is not a special case: zero
  // lamports before the transaction *is* its balance at the start, so summing the
  // movements that preceded the close is still exact — provided those are known,
  // which is what `allKnown` checks. (When the create deposit itself is not
  // observable, nothing is claimed.)
  for (let index = 0; index < solFlows.length; index += 1) {
    const flow = solFlows[index];
    if (flow === undefined || flow.kind !== 'account-close-return' || flow.lamports !== null) continue;
    if (flow.commitState !== 'committed') continue;
    const address = flow.from;
    if (address === null) {
      diagnostics.push({
        level: 'warning',
        code: 'effects-close-return-not-observable',
        message: `${label(flow.ref)} closes an account whose address did not resolve, so the returned amount cannot be reconciled.`,
        ref: flow.ref,
      });
      continue;
    }
    const row = rowByAddress.get(address);
    const key = orderKey(flow.ref);
    const others = solFlows.filter(
      (other, otherIndex) => otherIndex !== index && (other.from === address || other.to === address),
    );
    const before = row?.beforeLamports ?? null;
    const after = row?.afterLamports ?? null;
    const allKnown = others.every(other => other.lamports !== null);
    const allCommitted = others.every(other => other.commitState === 'committed');
    const allBefore = others.every(other => orderKey(other.ref) < key);
    if (before !== null && after === 0n && allKnown && allCommitted && allBefore) {
      let balanceAtClose = before;
      for (const other of others) {
        const amount = other.lamports ?? 0n;
        if (other.to === address) balanceAtClose += amount;
        if (other.from === address) balanceAtClose -= amount;
      }
      solFlows[index] = { ...flow, lamports: balanceAtClose, amountSource: 'balance-reconciliation', confidence: 'reconciled' };
      setCloseAmount(lifecycle, flow.ref, address, balanceAtClose);
    } else {
      diagnostics.push({
        level: 'info',
        code: 'effects-close-return-not-observable',
        message:
          `${label(flow.ref)} closes an account whose returned amount boundary balances cannot determine` +
          (before === null || after === null
              ? ' (it has no usable lamport row).'
              : after !== 0n
                ? ' (its balance after the transaction is not zero, so something moved lamports after the close).'
                : ' (other instructions moved lamports in or out of it, or their amounts are unknown).'),
        ref: flow.ref,
      });
    }
  }

  // --------------------------------- sizing: measure with both endpoints only

  const reconciledAmounts: { ref: InstructionRef | null; amount: bigint }[] = [];
  for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass += 1) {
    const resolved = resolveOneSolFlowByResidual(solFlows, solNets);
    if (resolved === null) break;
    solFlows[resolved.index] = resolved.flow;
    reconciledAmounts.push({ ref: resolved.flow.ref, amount: resolved.amount });
  }
  for (let pass = 0; pass < MAX_RESOLUTION_PASSES; pass += 1) {
    const resolved = resolveOneTokenFlowByResidual(tokenFlows, tokenNetByAddress);
    if (resolved === null) break;
    tokenFlows[resolved.index] = resolved.flow;
    reconciledAmounts.push({ ref: resolved.flow.ref, amount: resolved.amount });
  }

  // --------------------------------------------------------- close composition

  // A native (wrapped-SOL) close returns the account's unwrapped balance *plus*
  // everything else it held. The unwrapped part is knowable from the account's
  // starting balance and the committed token movements, independent of whether the
  // total is. The rest is reported as "other" and is deliberately not split into
  // rent and dust: that needs a rent-exempt minimum, which is an epoch-dependent
  // sysvar value this layer will not hardcode.
  for (let index = 0; index < lifecycle.length; index += 1) {
    const effect = lifecycle[index];
    if (effect === undefined || effect.kind !== 'token-account-closed') continue;
    if (effect.commitState !== 'committed' || effect.address === null) continue;
    const address = effect.address;

    // Where the returned lamports were sitting before the close, and what they
    // are not: "recovered rent" and "lamports sent to it during this transaction"
    // are different claims, so the three figures are kept apart and only combined
    // when they reproduce the return exactly.
    const lamportsAtStart = createdAddresses.has(address)
      ? 0n
      : (rowByAddress.get(address)?.beforeLamports ?? null);
    const lamportsCredited = committedLamportsMoved(solFlows, address, 'in');
    const lamportsSpent = committedLamportsMoved(solFlows, address, 'out');
    const returned = effect.lamportsReturned;
    const reconstruction =
      lamportsAtStart === null || lamportsCredited === null || lamportsSpent === null
        ? null
        : lamportsAtStart + lamportsCredited - lamportsSpent;
    const returnComposition =
      reconstruction === null || returned === null || reconstruction !== returned
        ? ('not-provable' as const)
        : lamportsAtStart === 0n
          ? ('in-transaction-lamports' as const)
          : lamportsCredited === 0n
            ? ('own-lamports' as const)
            : ('mixed' as const);
    const provenance = { lamportsAtStart, lamportsCredited, lamportsSpent, returnComposition };
    lifecycle[index] = { ...effect, ...provenance };
    if (returnComposition === 'not-provable') {
      diagnostics.push({
        level: 'info',
        code: 'effects-close-provenance-not-provable',
        message:
          `${label(effect.ref)} closes an account, and its starting lamports, the lamports sent to it during the transaction ` +
          'and the lamports it spent do not reproduce what it returned — so whether that return is recovered rent, a payment ' +
          'made to it during the transaction, or both, is not stated.',
        ref: effect.ref,
      });
    }
    if (!isNativeMint(effect.mint)) continue;
    const total = effect.lamportsReturned;
    const wrapped = wrappedAtClose(address, createdAddresses, tokenRowsByAddress, tokenFlows);

    // A native account satisfies `lamports == reserve + amount` at every
    // instruction boundary, so the two histories must agree:
    //
    //   total - wrapped  ==  the lamports the account held that were not wrapped
    //
    // where that "other" part is the deposit that funded it (an account created in
    // this transaction) or its pre-transaction lamports minus its pre-transaction
    // amount (an account that already existed, whose reserve was funded long ago).
    // The check is a real one, not a formality: it holds only when the lamport
    // movements and the decoded wrapped-balance movements describe the same events.
    // An instruction this layer does not decode can break it — `syncNative`, for
    // instance, turns lamports already sitting in a wrapped-SOL account into
    // wrapped balance without moving a lamport.
    const preAmount = tokenRowsByAddress.get(address)?.find(row => row.presence !== 'only-after')?.beforeAmount ?? null;
    const created = lifecycle.find(
      other => other.kind === 'token-account-create' && other.address === address && other.outcome === 'created',
    );
    const createdInTx = createdAddresses.has(address);
    const createDeposit =
      created !== undefined && created.kind === 'token-account-create' ? created.lamportsDeposited : null;
    const preLamports = rowByAddress.get(address)?.beforeLamports ?? null;
    const nonWrapped = createdInTx
      ? createDeposit
      : preLamports === null || preAmount === null
        ? null
        : preLamports - preAmount;

    const provable =
      wrapped !== null && wrapped >= 0n && total !== null && nonWrapped !== null && total - nonWrapped === wrapped;
    if (provable) {
      lifecycle[index] = {
        ...effect,
        ...provenance,
        unwrappedLamports: wrapped,
        otherLamports: total - (wrapped ?? 0n),
      };
      continue;
    }

    const suspects = tokenProgramSuspects(input, address, lifecycle, tokenRowsByAddress);
    diagnostics.push({
      level: 'info',
      code: 'effects-close-composition-not-observable',
      message:
        `${label(effect.ref)} closes a wrapped-SOL account; the split between unwrapped SOL and the account's other lamports is ` +
        'not established, because its lamport history and its decoded wrapped-balance movements do not describe the same events' +
        (suspects.length === 0
          ? '.'
          : ` — candidates are the instructions this layer does not decode: ${suspects
              .map(entry => `${label(entry.ref)} ${entry.parsedType ?? 'unparsed'}`)
              .join(', ')}.`),
      ref: effect.ref,
    });
  }

  /* ------------------------- wrapped-SOL units that leave with a closed account */

  // `process_close_account` pays out an account's whole balance and deletes it,
  // and never touches the mint's supply. A non-native account can only be closed
  // at zero units, but a wrapped-SOL one can be closed holding them: those units
  // are the lamport claim the close paid out, so they leave the token system with
  // the account. Recording that movement is what keeps an ordinary WSOL close from
  // being read as a token delta nothing explains.
  //
  // The size is not read off the token history on its own: a native account's units
  // and its lamports are the same claim, so the figure the close's lamport
  // composition already established (`unwrappedLamports`) is the one that both
  // histories agree on. When that is not provable — a `syncNative` this layer does
  // not decode can wrap lamports without a decoded movement — the units are
  // recorded as unsized rather than understated, and the token residual stays
  // visibly attributed to the close instead of being quietly closed out.
  for (const effect of lifecycle) {
    if (effect.kind !== 'token-account-closed' || effect.commitState !== 'committed') continue;
    const address = effect.address;
    if (address === null) continue;
    const row = (tokenRowsByAddress.get(address) ?? []).find(entry => entry.presence !== 'only-after');
    if (row === undefined || !isNativeMint(row.mint)) continue;
    const amount = effect.unwrappedLamports;
    // Closing an account that held no units moves nothing: a zero flow would add a
    // line to the output that describes no movement at all.
    if (amount === 0n) continue;
    tokenFlows.push({
      confidence: amount === null ? 'ambiguous' : 'reconciled',
      commitState: 'committed',
      ref: effect.ref,
      actionKind: effect.actionKind,
      kind: 'close-unwrap',
      mint: row.mint,
      mintEvidence: 'account-metadata',
      decimals: row.decimals,
      decimalsEvidence: row.decimals === null ? 'none' : 'account-metadata',
      sourceTokenAccount: address,
      destinationTokenAccount: null,
      sourceOwner: row.owner,
      destinationOwner: null,
      authority: null,
      authorityIsSigner: null,
      amount,
      amountSource: amount === null ? 'not-observable' : 'balance-reconciliation',
      nativeLamportLeg: true,
    });
    if (amount !== null) continue;
    diagnostics.push({
      level: 'info',
      code: 'effects-close-units-not-observable',
      message:
        `${label(effect.ref)} closes a wrapped-SOL account, and the wrapped units it held when it closed are not ` +
        'observable: its lamport history and its decoded wrapped-balance movements do not describe the same events, so the ' +
        'units that left with it are stated as unknown rather than as its pre-transaction balance.',
      ref: effect.ref,
    });
  }

  /* ---------------------------------------------------------------- net SOL */

  const netSolByAccount: SolAccountNet[] = input.accounts.map(row => {
    const ledger =
      row.address === null
        ? { credit: 0n, debit: 0n, unobservable: [] }
        : buildLedger(solFlows, solTouches, row.address, solAmount, flow => flow.ref);
    // A row whose address did not resolve still states its own boundary balances,
    // so its net change is exact. What cannot be done for it is matching decoded
    // flows, which is why its residual stays unknown rather than being reported as
    // unexplained: nothing is claimed either way about an account we cannot name.
    const net =
      row.address === null
        ? row.beforeLamports === null || row.afterLamports === null
          ? null
          : row.afterLamports - row.beforeLamports
        : (solNets.get(row.address) ?? null);
    const explained = ledger.credit - ledger.debit;
    const residual = row.address === null || net === null ? null : net - explained;
    return {
      accountIndex: row.index,
      address: row.address,
      signer: row.signer,
      isFeePayer: row.address !== null && row.address === input.feePayer,
      beforeLamports: row.beforeLamports,
      afterLamports: row.afterLamports,
      netLamports: net,
      explainedLamports: explained,
      residualLamports: residual,
      reconciliation: reconciles(residual),
      unobservableFlowRefs: ledger.unobservable,
    };
  });

  /* -------------------------------------------------------------- net token */

  const netTokenByAccountMint: TokenAccountMintNet[] = tokenNets.map(entry => {
    const address = entry.row.address;
    const ledger =
      address === null
        ? { credit: 0n, debit: 0n, unobservable: [] }
        : buildLedger(tokenFlows, tokenTouches, address, tokenAmount, flow => flow.ref);
    const explained = ledger.credit - ledger.debit;
    const residual = entry.net === null ? null : entry.net - explained;
    return {
      accountIndex: entry.row.accountIndex,
      tokenAccount: address,
      mint: entry.row.mint,
      owner: entry.row.owner,
      programId: entry.row.programId,
      decimals: entry.row.decimals,
      presence: entry.row.presence,
      beforeAmount: entry.row.beforeAmount,
      afterAmount: entry.row.afterAmount,
      startingAmountSource: entry.startingAmountSource,
      netAmount: entry.net,
      explainedAmount: explained,
      residualAmount: residual,
      reconciliation: reconciles(residual),
      isNativeMint: isNativeMint(entry.row.mint),
      unobservableFlowRefs: ledger.unobservable,
    };
  });

  /* ------------------------------------------------------- owner aggregates */

  const ownerGroups = new Map<string, TokenAccountMintNet[]>();
  for (const row of netTokenByAccountMint) {
    const key = `${row.owner ?? ''}\u0000${row.mint ?? ''}`;
    const list = ownerGroups.get(key);
    if (list === undefined) ownerGroups.set(key, [row]);
    else list.push(row);
  }
  const netTokenByOwnerMint: OwnerMintNet[] = [...ownerGroups.values()]
    .map(rows => {
      const first = rows[0];
      const total = rows.reduce<bigint | null>(
        (sum, row) => (sum === null || row.netAmount === null ? null : sum + row.netAmount),
        0n,
      );
      return {
        owner: first?.owner ?? null,
        mint: first?.mint ?? null,
        decimals: first?.decimals ?? null,
        netAmount: total,
        tokenAccountCount: rows.length,
        tokenAccounts: rows.map(row => row.tokenAccount),
        reconciliation: combine(rows.map(row => row.reconciliation)),
      };
    })
    .sort((a, b) => compareStrings(a.owner, b.owner) || compareStrings(a.mint, b.mint));

  /* ------------------------------------------- unattributed and diagnostics */

  const unattributed: UnattributedEffect[] = [];
  const undecodedByProgram = new Map<string, InstructionRef[]>();
  for (const entry of input.undecoded) {
    if (entry.programId === null) continue;
    const list = undecodedByProgram.get(entry.programId);
    if (list === undefined) undecodedByProgram.set(entry.programId, [entry.ref]);
    else list.push(entry.ref);
  }

  // Only a System instruction can move lamports between two arbitrary accounts
  // (any program can move the lamports of accounts it owns, which is not visible
  // from this data), so an undecoded System instruction is a real candidate for an
  // unexplained lamport delta — and said to be a candidate, never a cause.
  const undecodedSystem = undecodedByProgram.get(SYSTEM_PROGRAM_ID) ?? [];

  for (const net of netSolByAccount) {
    if (net.address === null) continue;
    const touched = solFlows.some(flow => flow.from === net.address || flow.to === net.address);
    if (net.netLamports === null) {
      if (!touched && !net.isFeePayer) continue;
      unattributed.push({
        confidence: 'ambiguous',
        side: 'sol',
        reason: 'delta-not-observable',
        accountIndex: net.accountIndex,
        address: net.address,
        mint: null,
        amount: null,
        candidateRefs: net.unobservableFlowRefs,
        undecodedRefs: [],
        explanation:
          `account ${net.address} has no lamport value for both sides of the transaction, so neither its net change nor any flow ` +
          'into or out of it can be stated.',
      });
      continue;
    }
    if (net.residualLamports === null || net.residualLamports === 0n) continue;
    const separable = net.unobservableFlowRefs.length > 0;
    unattributed.push({
      confidence: 'ambiguous',
      side: 'sol',
      reason: separable ? 'amounts-not-separable' : 'not-explained',
      accountIndex: net.accountIndex,
      address: net.address,
      mint: null,
      amount: net.residualLamports,
      candidateRefs: net.unobservableFlowRefs,
      undecodedRefs: separable ? [] : undecodedSystem,
      explanation: separable
        ? `account ${net.address} is left with ${signed(net.residualLamports)} lamports, exactly the net of ` +
          `${net.unobservableFlowRefs.length} proven flow(s) (${net.unobservableFlowRefs.map(ref => `${label(ref)}`).join(', ')}) ` +
          'whose amounts boundary balances cannot pin down individually. No sender or receiver is asserted beyond those instructions.'
        : `account ${net.address} is left with ${signed(net.residualLamports)} lamports that no decoded instruction accounts for. ` +
          (undecodedSystem.length === 0
            ? ''
            : `Undecoded System instructions could have moved them (${undecodedSystem
                .map(ref => `${label(ref)}`)
                .join(', ')}). `) +
          'A program can move the lamports of accounts it owns without any instruction this layer decodes, so no sender or ' +
          'receiver is claimed.',
    });
  }

  for (const net of netTokenByAccountMint) {
    if (net.tokenAccount === null) continue;
    if (net.netAmount === null) {
      unattributed.push({
        confidence: 'ambiguous',
        side: 'token',
        reason: 'delta-not-observable',
        accountIndex: net.accountIndex,
        address: net.tokenAccount,
        mint: net.mint,
        amount: null,
        candidateRefs: net.unobservableFlowRefs,
        undecodedRefs: [],
        explanation:
          `token account ${net.tokenAccount} (mint ${net.mint ?? 'unknown'}) has no pre-transaction balance and nothing proves it ` +
          'was created in this transaction, so its starting amount is unknown and no delta is claimed (an absent pre-balance is ' +
          'not zero).',
      });
      continue;
    }
    if (net.residualAmount === null || net.residualAmount === 0n) continue;
    // Only the account's own token program can change its balance, so undecoded
    // instructions of that program are a real lead rather than a guess.
    const candidates = net.programId === null ? [] : (undecodedByProgram.get(net.programId) ?? []);
    const separable = net.unobservableFlowRefs.length > 0;
    unattributed.push({
      confidence: 'ambiguous',
      side: 'token',
      reason: separable ? 'amounts-not-separable' : 'not-explained',
      accountIndex: net.accountIndex,
      address: net.tokenAccount,
      mint: net.mint,
      amount: net.residualAmount,
      candidateRefs: net.unobservableFlowRefs,
      undecodedRefs: candidates,
      explanation: separable
        ? `token account ${net.tokenAccount} is left with ${signed(net.residualAmount)} raw units of ${net.mint ?? 'an unknown mint'}, ` +
          `exactly the net of ${net.unobservableFlowRefs.length} proven flow(s) whose amounts are not readable from their data.`
        : `token account ${net.tokenAccount} is left with ${signed(net.residualAmount)} raw units of ${net.mint ?? 'an unknown mint'} ` +
          'that no decoded instruction accounts for' +
          (candidates.length === 0
            ? '; no undecoded instruction targets its token program either.'
            : `; undecoded instructions of its token program could have moved them (${candidates.map(ref => `${label(ref)}`).join(', ')}).`),
    });
  }

  diagnostics.push(
    ...invariantDiagnostics(input, solFlows, tokenFlows, netSolByAccount, netTokenByAccountMint, createdAddresses, closedAddresses),
  );
  diagnostics.push(
    ...reconciledAmounts.map(entry => ({
      level: 'info' as const,
      code: 'effects-amount-reconciled',
      message:
        `${label(entry.ref)} states a movement without an amount; boundary balances leave ${entry.amount} unexplained on both of ` +
        'its endpoints, so that is the amount reported, marked as reconciled rather than proven.',
      ref: entry.ref,
    })),
  );

  return {
    solFlows,
    tokenFlows,
    lifecycle,
    netSolByAccount,
    netTokenByAccountMint,
    netTokenByOwnerMint,
    unattributed,
    diagnostics,
  };
}

/* ------------------------------------------------------------------ helpers */

function reconciles(residual: bigint | null): Reconciliation {
  if (residual === null) return 'unknown';
  return residual === 0n ? 'exact' : 'residual';
}

function combine(values: readonly Reconciliation[]): Reconciliation {
  if (values.includes('unknown')) return 'unknown';
  if (values.includes('residual')) return 'residual';
  return 'exact';
}

/**
 * How a token account's starting amount was established.
 *
 * A `only-after` row means the RPC had no pre-transaction value for the account.
 * That is zero exactly when something proved the account was created in this
 * transaction (a committed create), and unprovable otherwise — Milestone 1's rule
 * that an absent pre-balance is not an assumption of zero is preserved here.
 */
function startingSourceFor(
  row: EffectsTokenRow,
  createdAddresses: ReadonlySet<string>,
): TokenAccountMintNet['startingAmountSource'] {
  if (row.presence !== 'only-after') return 'reported';
  if (row.address !== null && createdAddresses.has(row.address)) return 'account-created';
  return 'not-observable';
}

/**
 * Net raw-unit change of one row.
 *
 * Two cases where the missing side is provably zero, so the delta is knowable:
 *  - created in this transaction → started at zero;
 *  - closed in this transaction → the token program deletes the account, so it
 *    holds nothing afterwards.
 */
function netTokenFor(
  row: EffectsTokenRow,
  startingAmountSource: TokenAccountMintNet['startingAmountSource'],
  closedAddresses: ReadonlySet<string>,
): bigint | null {
  if (row.beforeAmount !== null && row.afterAmount !== null) return row.afterAmount - row.beforeAmount;
  if (row.afterAmount === null && row.beforeAmount !== null) {
    return row.address !== null && closedAddresses.has(row.address) ? -row.beforeAmount : null;
  }
  if (row.beforeAmount === null && row.afterAmount !== null) {
    return startingAmountSource === 'account-created' ? row.afterAmount : null;
  }
  return null;
}

function setCloseAmount(
  lifecycle: AccountLifecycleEffect[],
  ref: InstructionRef | null,
  address: string,
  lamportsReturned: bigint,
): void {
  const index = lifecycle.findIndex(
    effect => effect.kind === 'token-account-closed' && effect.address === address && sameRef(effect.ref, ref),
  );
  const effect = lifecycle[index];
  if (effect === undefined || effect.kind !== 'token-account-closed') return;
  lifecycle[index] = {
    ...effect,
    lamportsReturned,
    returnSource: 'balance-reconciliation',
    confidence: 'reconciled',
  };
}

function setCreateDeposit(
  lifecycle: AccountLifecycleEffect[],
  ref: InstructionRef | null,
  address: string,
  lamports: bigint,
  source: 'instruction-data' | 'balance-reconciliation',
): void {
  const index = lifecycle.findIndex(
    effect => effect.kind === 'token-account-create' && effect.address === address && sameRef(effect.ref, ref),
  );
  const effect = lifecycle[index];
  if (effect === undefined || effect.kind !== 'token-account-create') return;
  lifecycle[index] = { ...effect, lamportsDeposited: lamports, depositSource: source };
}

/**
 * A native account's wrapped balance at close time, as the decoded token
 * movements imply it: its starting balance plus every committed movement in and
 * out. `null` when the start is unprovable or any movement's amount is unknown.
 */
/**
 * Committed lamports other instructions moved in or out of an account during the
 * transaction. The close's own return is excluded, since that is the movement being
 * explained rather than one of its ingredients. `null` as soon as one of the amounts
 * is unknown: a partial sum would understate a movement and turn "nothing was paid
 * in" into a false claim.
 */
function committedLamportsMoved(solFlows: readonly SolFlow[], address: string, direction: 'in' | 'out'): bigint | null {
  let sum = 0n;
  for (const flow of solFlows) {
    if (flow.commitState !== 'committed') continue;
    if (direction === 'in') {
      if (flow.to !== address) continue;
    } else {
      if (flow.from !== address) continue;
      if (flow.kind === 'account-close-return') continue;
    }
    if (flow.amountSource === 'not-observable' || flow.lamports === null) return null;
    sum += flow.lamports;
  }
  return sum;
}

function wrappedAtClose(
  address: string,
  createdAddresses: ReadonlySet<string>,
  tokenRowsByAddress: ReadonlyMap<string, EffectsTokenRow[]>,
  tokenFlows: readonly TokenFlow[],
): bigint | null {
  const rows = tokenRowsByAddress.get(address) ?? [];
  const preRow = rows.find(row => row.presence !== 'only-after') ?? null;
  let balance: bigint | null;
  if (preRow !== null) balance = preRow.beforeAmount;
  else if (createdAddresses.has(address)) balance = 0n;
  else balance = null;
  if (balance === null) return null;

  for (const flow of tokenFlows) {
    if (flow.commitState !== 'committed') continue;
    // The balance being measured is the one the close found, so the units the
    // close itself removed (`close-unwrap`) are not part of the history that led
    // up to it. Excluding them here keeps the answer independent of the order in
    // which the stages run.
    if (flow.kind === 'close-unwrap') continue;
    const touchesFlow = flow.sourceTokenAccount === address || flow.destinationTokenAccount === address;
    if (!touchesFlow) continue;
    if (flow.amount === null) return null;
    for (const touch of tokenTouches(flow, address)) {
      balance += touch.direction === 1 ? flow.amount : -flow.amount;
    }
  }
  return balance;
}

/**
 * Undecoded instructions on the closed account's token program — the only
 * instructions that could have changed its wrapped balance without a decoded
 * movement. A real lead, named rather than guessed.
 */
function tokenProgramSuspects(
  input: EffectsInput,
  address: string,
  lifecycle: readonly AccountLifecycleEffect[],
  tokenRowsByAddress: ReadonlyMap<string, EffectsTokenRow[]>,
): readonly { readonly ref: InstructionRef; readonly parsedType: string | null }[] {
  const created = lifecycle.find(
    (effect): effect is Extract<AccountLifecycleEffect, { kind: 'token-account-create' }> =>
      effect.kind === 'token-account-create' && effect.address === address,
  );
  const program = tokenRowsByAddress.get(address)?.[0]?.programId ?? created?.tokenProgram ?? null;
  if (program === null) return [];
  return input.undecoded
    .filter(entry => entry.programId === program)
    .map(entry => ({ ref: entry.ref, parsedType: entry.parsedType }));
}

function sameRef(a: InstructionRef | null, b: InstructionRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.path === b.path && a.index === b.index && a.outerIndex === b.outerIndex;
}

function label(ref: InstructionRef | null): string {
  return ref === null ? 'transaction metadata' : refLabel(ref);
}

function signed(value: bigint): string {
  return value > 0n ? `+${value}` : `${value}`;
}

/**
 * One pass of "the only unexplained movement on both endpoints sizes it".
 *
 * Deliberately strict: the flow must be the only unobservable-amount flow touching
 * either endpoint, both endpoints must have a known net change, and their
 * remainders must be exact negatives of each other. Anything less and nothing is
 * resolved.
 */
function resolveOneSolFlowByResidual(
  flows: readonly SolFlow[],
  nets: ReadonlyMap<string, bigint>,
): { index: number; flow: SolFlow; amount: bigint } | null {
  const ledgerAt = (address: string): bigint => {
    const ledger = buildLedger(flows, solTouches, address, solAmount, flow => flow.ref);
    return ledger.credit - ledger.debit;
  };
  const unobservableTouching = (address: string): number =>
    flows.filter(
      flow => flow.commitState === 'committed' && flow.lamports === null && solTouches(flow, address).length > 0,
    ).length;

  for (let index = 0; index < flows.length; index += 1) {
    const flow = flows[index];
    if (flow === undefined || flow.commitState !== 'committed' || flow.lamports !== null) continue;
    const { from, to } = flow;
    if (from === null || to === null || from === to) continue;
    if (unobservableTouching(from) !== 1 || unobservableTouching(to) !== 1) continue;
    const netFrom = nets.get(from);
    const netTo = nets.get(to);
    if (netFrom === undefined || netTo === undefined) continue;
    const residualFrom = netFrom - ledgerAt(from);
    const residualTo = netTo - ledgerAt(to);
    if (residualFrom === -residualTo && residualFrom < 0n) {
      const amount = -residualFrom;
      return {
        index,
        amount,
        flow: { ...flow, lamports: amount, amountSource: 'residual-reconciliation', confidence: 'reconciled' },
      };
    }
  }
  return null;
}

/** The token-side twin of `resolveOneSolFlowByResidual`. */
function resolveOneTokenFlowByResidual(
  flows: readonly TokenFlow[],
  nets: ReadonlyMap<string, { readonly net: bigint | null }>,
): { index: number; flow: TokenFlow; amount: bigint } | null {
  const ledgerAt = (address: string): bigint => {
    const ledger = buildLedger(flows, tokenTouches, address, tokenAmount, flow => flow.ref);
    return ledger.credit - ledger.debit;
  };
  const unobservableTouching = (address: string): number =>
    flows.filter(
      flow => flow.commitState === 'committed' && flow.amount === null && tokenTouches(flow, address).length > 0,
    ).length;

  for (let index = 0; index < flows.length; index += 1) {
    const flow = flows[index];
    if (flow === undefined || flow.commitState !== 'committed' || flow.amount !== null) continue;
    const from = flow.sourceTokenAccount;
    const to = flow.destinationTokenAccount;
    if (from === null || to === null || from === to) continue;
    if (unobservableTouching(from) !== 1 || unobservableTouching(to) !== 1) continue;
    const netFrom = nets.get(from)?.net;
    const netTo = nets.get(to)?.net;
    if (netFrom === null || netFrom === undefined || netTo === null || netTo === undefined) continue;
    const residualFrom = netFrom - ledgerAt(from);
    const residualTo = netTo - ledgerAt(to);
    if (residualFrom === -residualTo && residualFrom < 0n) {
      const amount = -residualFrom;
      return {
        index,
        amount,
        flow: { ...flow, amount, amountSource: 'residual-reconciliation', confidence: 'reconciled' },
      };
    }
  }
  return null;
}

/** Conservation and identity checks that must hold when the data is complete. */
function invariantDiagnostics(
  input: EffectsInput,
  solFlows: readonly SolFlow[],
  tokenFlows: readonly TokenFlow[],
  netSol: readonly SolAccountNet[],
  netToken: readonly TokenAccountMintNet[],
  createdAddresses: ReadonlySet<string>,
  closedAddresses: ReadonlySet<string>,
): EffectsDiagnostic[] {
  const diagnostics: EffectsDiagnostic[] = [];
  const committedToken = tokenFlows.filter(flow => flow.commitState === 'committed');

  // 1. Lamports are conserved: everything that left one account arrived at
  //    another, except the fee, which leaves the observed account set entirely.
  if (netSol.every(net => net.netLamports !== null)) {
    const total = netSol.reduce((sum, net) => sum + (net.netLamports ?? 0n), 0n);
    if (input.feeLamports !== null && total + input.feeLamports !== 0n) {
      diagnostics.push({
        level: 'warning',
        code: 'effects-lamport-conservation-violated',
        message:
          `the lamport changes of all accounts sum to ${signed(total)}, which does not offset the ${input.feeLamports} lamport fee; ` +
          'lamports are conserved apart from the fee, so one of the two readings is wrong.',
        ref: null,
      });
    }
  }

  // 1b. Bookkeeping: every committed flow credits one account and debits another,
  //     so the accounts' explained totals must cancel exactly, leaving only the
  //     fee (which has no recipient among the transaction's accounts).
  const committedSol = solFlows.filter(flow => flow.commitState === 'committed');
  const endpointsKnown = committedSol.every(
    flow => flow.kind === 'fee' || (flow.from !== null && flow.to !== null),
  );
  if (endpointsKnown) {
    const explainedTotal = netSol.reduce((sum, net) => sum + net.explainedLamports, 0n);
    const feeTotal = committedSol
      .filter(flow => flow.kind === 'fee')
      .reduce((sum, flow) => sum + (flow.lamports ?? 0n), 0n);
    if (explainedTotal + feeTotal !== 0n) {
      diagnostics.push({
        level: 'warning',
        code: 'effects-sol-bookkeeping-violated',
        message:
          `the committed lamport flows explain ${signed(explainedTotal)} across all accounts, which does not cancel against the ` +
          `${feeTotal} lamport fee. Every flow debits one account and credits another, so this means a flow was lost, double ` +
          'counted, or aimed at an account outside the transaction.',
        ref: null,
      });
    }
  }

  // 2. Tokens are conserved per mint: the sum of the accounts' changes equals
  //    minted minus burned. Wrapped SOL is excluded: a native account's balance is
  //    a lamport claim, and closing one moves lamports rather than changing supply.
  const mints = new Set<string>();
  for (const net of netToken) if (net.mint !== null && !net.isNativeMint) mints.add(net.mint);
  let checkable = committedToken.every(flow => flow.mint !== null);
  for (const mint of [...mints].sort()) {
    const rows = netToken.filter(net => net.mint === mint);
    if (rows.some(row => row.netAmount === null)) {
      checkable = false;
      continue;
    }
    const claimedAddresses = new Set<string>();
    for (const flow of committedToken) {
      if (flow.mint !== mint) continue;
      if (flow.sourceTokenAccount !== null) claimedAddresses.add(flow.sourceTokenAccount);
      if (flow.destinationTokenAccount !== null) claimedAddresses.add(flow.destinationTokenAccount);
    }
    if ([...claimedAddresses].some(address => !rows.some(row => row.tokenAccount === address))) {
      // A committed movement of this mint touches an account the response has no
      // row for (one created and closed inside the transaction, for instance), so
      // the sum over rows is incomplete and the check would be meaningless.
      checkable = false;
      continue;
    }
    const changes = rows.reduce((sum, row) => sum + (row.netAmount ?? 0n), 0n);
    const minted = committedToken
      .filter(flow => flow.mint === mint && flow.kind === 'mint')
      .reduce((sum, flow) => sum + (flow.amount ?? 0n), 0n);
    const burned = committedToken
      .filter(flow => flow.mint === mint && flow.kind === 'burn')
      .reduce((sum, flow) => sum + (flow.amount ?? 0n), 0n);
    if (changes !== minted - burned) {
      diagnostics.push({
        level: 'warning',
        code: 'effects-token-conservation-violated',
        message:
          `mint ${mint}: the accounts' token changes sum to ${signed(changes)} raw units, but the transaction minted ${minted} and ` +
          `burned ${burned}. Tokens only come into existence through a mint and leave through a burn, so a decoded instruction is ` +
          'missing or one account was not reported.',
        ref: null,
      });
    }
  }
  if (!checkable) {
    diagnostics.push({
      level: 'info',
      code: 'effects-token-conservation-not-checkable',
      message:
        'per-mint token conservation could not be checked: a committed token movement touches an account with no balance row, or ' +
        'its mint is not readable from the instruction data.',
      ref: null,
    });
  }

  // 3. A wrapped-SOL account's lamports and token balance move together 1:1,
  //    unless something other than wrapping touched its lamports.
  for (const net of netToken) {
    if (!net.isNativeMint || net.tokenAccount === null || net.netAmount === null) continue;
    if (createdAddresses.has(net.tokenAccount) || closedAddresses.has(net.tokenAccount)) continue;
    const sol = netSol.find(entry => entry.address === net.tokenAccount);
    if (sol?.netLamports === null || sol?.netLamports === undefined) continue;
    if (sol.netLamports !== net.netAmount) {
      diagnostics.push({
        level: 'info',
        code: 'effects-native-lamport-identity-broken',
        message:
          `wrapped-SOL account ${net.tokenAccount}: its token balance moved ${signed(net.netAmount)} raw units while its lamports ` +
          `moved ${signed(sol.netLamports)}. They move 1:1 unless something else changed its lamports (a fee, a tip, rent, or a ` +
          'direct transfer to the account), which is the likely explanation here.',
        ref: null,
      });
    }
  }

  // 4. The token program only closes a non-native account at a zero balance, so
  //    an account that provably held units at close time contradicts its own rule.
  for (const net of netToken) {
    if (net.tokenAccount === null || net.isNativeMint) continue;
    if (!closedAddresses.has(net.tokenAccount)) continue;
    if (net.beforeAmount === null || net.beforeAmount === 0n) continue;
    if (net.unobservableFlowRefs.length > 0) continue;
    if (net.netAmount === -net.beforeAmount && net.explainedAmount === 0n) {
      diagnostics.push({
        level: 'info',
        code: 'effects-close-token-balance-nonzero',
        message:
          `token account ${net.tokenAccount} was closed in this transaction while its own row shows ${net.beforeAmount} raw units ` +
          'before it. A non-native account may only be closed at a zero balance, so those units must have left it during the ' +
          'transaction without any decoded instruction saying so.',
        ref: null,
      });
    }
  }

  return diagnostics;
}
