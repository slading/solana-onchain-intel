/**
 * SPL Token / Token-2022 decoder.
 *
 * Layout (from `token/interface/src/instruction.rs::pack()`), discriminator
 * first, then payload:
 *
 *   Transfer        (3)  u8 tag | u64 amount LE
 *   Approve         (4)  u8 tag | u64 amount LE
 *   Revoke          (5)  u8 tag
 *   MintTo          (7)  u8 tag | u64 amount LE
 *   Burn            (8)  u8 tag | u64 amount LE
 *   CloseAccount    (9)  u8 tag
 *   TransferChecked (12) u8 tag | u64 amount LE | u8 decimals
 *   MintToChecked   (14) u8 tag | u64 amount LE | u8 decimals
 *   BurnChecked     (15) u8 tag | u64 amount LE | u8 decimals
 *
 * Note the field order of the *Checked variants: amount comes before decimals.
 *
 * Account roles come from the "Accounts expected by this instruction" blocks in
 * the same file. Two facts are load-bearing and are deliberately NOT
 * "corrected" here:
 *
 *  - `Transfer` (3) does not carry the mint or the decimals. Those exist only in
 *    the transaction's token balances. We do not look them up: the instruction
 *    does not prove them, so they stay absent from the decoded action.
 *  - Token-2022 reuses the same numeric tags for these core instructions, so the
 *    same decoders apply; only the program id differs.
 */
import { asBigIntLike, asNumber, asRecord, asString, pick } from '../lib/read-json.ts';
import { readU8, readU64LE, takeAccountRoles, type Bytes } from './bytes.ts';
import {
  SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_2022_EXTENSION_INSTRUCTION_NAMES,
  TOKEN_CORE_INSTRUCTION_NAMES,
  notInScopeNote,
  type ByteDecodeResult,
  type ParsedDecodeResult,
  type ProgramDecoder,
} from './programs.ts';

/** Tags this milestone decodes to actions. Everything else is reported as-is. */
export const DECODED_TOKEN_TAGS = new Set([3, 4, 5, 7, 8, 9, 12, 14, 15]);

function instructionName(tag: number, isToken2022: boolean): string | null {
  const core = TOKEN_CORE_INSTRUCTION_NAMES[tag];
  if (core !== undefined) return core;
  return isToken2022 ? (TOKEN_2022_EXTENSION_INSTRUCTION_NAMES[tag] ?? null) : null;
}

function decodeBytes(
  input: { readonly bytes: Bytes; readonly accounts: readonly string[] },
  isToken2022: boolean,
): ByteDecodeResult {
  const { bytes, accounts } = input;
  const tag = readU8(bytes, 0);
  if (tag === null) {
    return {
      outcome: 'malformed',
      note: 'the instruction has no data at all, so its SPL Token discriminator cannot be read.',
    };
  }

  const notes: string[] = [];
  const amount = (): bigint | null => {
    const value = readU64LE(bytes, 1);
    if (value === null) {
      notes.push(
        `expected 8 bytes of amount after the tag, found ${Math.max(bytes.length - 1, 0)}.`,
      );
    }
    return value;
  };
  const decimals = (offset: number): number | null => {
    const value = readU8(bytes, offset);
    if (value === null) {
      notes.push(`expected a decimals byte at offset ${offset}, but the data ends earlier.`);
    }
    return value;
  };

  switch (tag) {
    case 3: {
      const {source, destination, authority} = takeAccountRoles(accounts, ['source', 'destination', 'authority'] as const, notes);
      // No mint, no decimals: a plain Transfer does not carry them.
      return {
        outcome: 'decoded',
        fields: { kind: 'spl-token.transfer', source, destination, authority, amount: amount() },
        notes,
      };
    }
    case 4: {
      const {source, delegate, authority} = takeAccountRoles(accounts, ['source', 'delegate', 'authority'] as const, notes);
      return {
        outcome: 'decoded',
        fields: { kind: 'spl-token.approve', source, delegate, authority, amount: amount() },
        notes,
      };
    }
    case 5: {
      const {source, authority} = takeAccountRoles(accounts, ['source', 'authority'] as const, notes);
      return { outcome: 'decoded', fields: { kind: 'spl-token.revoke', source, authority }, notes };
    }
    case 7: {
      const {mint, destination, authority} = takeAccountRoles(accounts, ['mint', 'destination', 'authority'] as const, notes);
      return {
        outcome: 'decoded',
        fields: { kind: 'spl-token.mintTo', mint, destination, authority, amount: amount() },
        notes,
      };
    }
    case 8: {
      const {account, mint, authority} = takeAccountRoles(accounts, ['account', 'mint', 'authority'] as const, notes);
      return {
        outcome: 'decoded',
        fields: { kind: 'spl-token.burn', account, mint, authority, amount: amount() },
        notes,
      };
    }
    case 9: {
      const {account, destination, authority} = takeAccountRoles(accounts, ['account', 'destination', 'authority'] as const, notes);
      return {
        outcome: 'decoded',
        fields: { kind: 'spl-token.closeAccount', account, destination, authority },
        notes,
      };
    }
    case 12: {
      const {source, mint, destination, authority} = takeAccountRoles(accounts, ['source', 'mint', 'destination', 'authority'] as const, notes);
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.transferChecked',
          source,
          mint,
          destination,
          authority,
          amount: amount(),
          decimals: decimals(9),
        },
        notes,
      };
    }
    case 14: {
      const {mint, destination, authority} = takeAccountRoles(accounts, ['mint', 'destination', 'authority'] as const, notes);
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.mintToChecked',
          mint,
          destination,
          authority,
          amount: amount(),
          decimals: decimals(9),
        },
        notes,
      };
    }
    case 15: {
      const {account, mint, authority} = takeAccountRoles(accounts, ['account', 'mint', 'authority'] as const, notes);
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.burnChecked',
          account,
          mint,
          authority,
          amount: amount(),
          decimals: decimals(9),
        },
        notes,
      };
    }
    default: {
      const name = instructionName(tag, isToken2022);
      if (name === null) {
        return {
          outcome: 'unknown-tag',
          note: `SPL Token instruction tag ${tag} is not part of the official instruction set.`,
        };
      }
      return {
        outcome: 'not-in-scope',
        note: notInScopeNote(isToken2022 ? 'Token-2022' : 'SPL Token', name, `tag ${tag}`),
      };
    }
  }
}

/**
 * RPC parser type names -> our kinds, for the target set only.
 *
 * Field names come from the node's own parser (`transaction-status/src/
 * parse_token.rs` in Agave), not from guesswork:
 *
 *   transfer        source, destination, amount,            authority | multisigAuthority
 *   transferChecked source, mint, destination, tokenAmount, authority | multisigAuthority
 *   mintTo          mint, account, amount,                  mintAuthority | multisigMintAuthority
 *   mintToChecked   mint, account, tokenAmount,             mintAuthority | multisigMintAuthority
 *   burn            account, mint, amount,                  authority | multisigAuthority
 *   burnChecked     account, mint, tokenAmount,             authority | multisigAuthority
 *   approve         source, delegate, amount,               owner | multisigOwner
 *   revoke          source,                                 owner | multisigOwner
 *   closeAccount    account, destination,                   owner | multisigOwner
 *
 * Two subtleties that matter:
 *  - the *Checked variants wrap the amount in a `tokenAmount` object, while the
 *    non-checked ones use a plain `amount` string;
 *  - when the authority is a multisig the parser emits `multisigAuthority`
 *    (etc.) plus a `signers` array instead of the plain key. Both spellings hold
 *    the same account as the instruction's account list (account 2 is the owner
 *    *or* the multisig), so both map to our `authority`.
 */
function decodeParsed(
  input: { readonly parsedType: string; readonly parsedInfo: unknown },
  isToken2022: boolean,
): ParsedDecodeResult {
  const { parsedType, parsedInfo } = input;
  const info = asRecord(parsedInfo);
  const notes: string[] = [];
  if (info === null) {
    notes.push('the RPC reported a parsed instruction without an info object; its fields are null.');
  }
  const field = (key: string): unknown => (info === null ? undefined : pick(info, key));
  const sub = (key: string): Record<string, unknown> | null => asRecord(field(key));
  const subField = (key: string, inner: string): unknown => {
    const parent = sub(key);
    return parent === null ? undefined : pick(parent, inner);
  };

  /** The non-checked variants carry a bare amount string. */
  const plainAmount = (): bigint | null => asBigIntLike(field('amount'));
  /** The checked variants carry { amount, decimals, uiAmount, uiAmountString }. */
  const checkedAmount = (key: string): bigint | null => asBigIntLike(subField(key, 'amount'));
  const checkedDecimals = (key: string): number | null => asNumber(subField(key, 'decimals'));

  /**
   * Authority, accepting the multisig spelling. The node uses the multisig key
   * only when a multisig is in use, so we record that rather than hide it.
   */
  const authorityOf = (single: string, multisig: string): string | null => {
    const singleValue = asString(field(single));
    if (singleValue !== null) return singleValue;
    const multisigValue = asString(field(multisig));
    if (multisigValue !== null) {
      const signers = field('signers');
      notes.push(
        `the RPC reported a multisig authority ("${multisig}")` +
          (Array.isArray(signers) ? ` with ${signers.length} signer account(s)` : '') +
          `; the authority field holds the multisig account itself.`,
      );
      return multisigValue;
    }
    return null;
  };

  switch (parsedType) {
    case 'transfer':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.transfer',
          source: asString(field('source')),
          destination: asString(field('destination')),
          authority: authorityOf('authority', 'multisigAuthority'),
          amount: plainAmount(),
        },
        notes,
      };
    case 'transferChecked':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.transferChecked',
          source: asString(field('source')),
          mint: asString(field('mint')),
          destination: asString(field('destination')),
          authority: authorityOf('authority', 'multisigAuthority'),
          amount: checkedAmount('tokenAmount'),
          decimals: checkedDecimals('tokenAmount'),
        },
        notes,
      };
    case 'mintTo':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.mintTo',
          mint: asString(field('mint')),
          destination: asString(field('account')),
          authority: authorityOf('mintAuthority', 'multisigMintAuthority'),
          amount: plainAmount(),
        },
        notes,
      };
    case 'mintToChecked':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.mintToChecked',
          mint: asString(field('mint')),
          destination: asString(field('account')),
          authority: authorityOf('mintAuthority', 'multisigMintAuthority'),
          amount: checkedAmount('tokenAmount'),
          decimals: checkedDecimals('tokenAmount'),
        },
        notes,
      };
    case 'burn':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.burn',
          account: asString(field('account')),
          mint: asString(field('mint')),
          authority: authorityOf('authority', 'multisigAuthority'),
          amount: plainAmount(),
        },
        notes,
      };
    case 'burnChecked':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.burnChecked',
          account: asString(field('account')),
          mint: asString(field('mint')),
          authority: authorityOf('authority', 'multisigAuthority'),
          amount: checkedAmount('tokenAmount'),
          decimals: checkedDecimals('tokenAmount'),
        },
        notes,
      };
    case 'approve':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.approve',
          source: asString(field('source')),
          delegate: asString(field('delegate')),
          authority: authorityOf('owner', 'multisigOwner'),
          amount: plainAmount(),
        },
        notes,
      };
    case 'revoke':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.revoke',
          source: asString(field('source')),
          authority: authorityOf('owner', 'multisigOwner'),
        },
        notes,
      };
    case 'closeAccount':
      return {
        outcome: 'decoded',
        fields: {
          kind: 'spl-token.closeAccount',
          account: asString(field('account')),
          destination: asString(field('destination')),
          authority: authorityOf('owner', 'multisigOwner'),
        },
        notes,
      };
    default:
      break;
  }

  if (TOKEN_PARSED_TYPE_NAMES.has(parsedType)) {
    return {
      outcome: 'not-in-scope',
      note: notInScopeNote(isToken2022 ? 'Token-2022' : 'SPL Token', parsedType, 'parsed by the RPC'),
    };
  }
  if (TOKEN_2022_EXTENSION_PARSED_TYPES.has(parsedType) && isToken2022) {
    return {
      outcome: 'not-in-scope',
      note: notInScopeNote('Token-2022', parsedType, 'parsed by the RPC'),
    };
  }
  return {
    outcome: 'unknown-type',
    note: `the RPC parsed this as SPL Token instruction "${parsedType}", which is not part of the official instruction set.`,
  };
}


/** Core types the RPC's spl-token parser emits that we recognize but do not decode. */
const TOKEN_PARSED_TYPE_NAMES = new Set([
  'initializeMint',
  'initializeMint2',
  'initializeAccount',
  'initializeAccount2',
  'initializeAccount3',
  'initializeMultisig',
  'initializeMultisig2',
  'setAuthority',
  'freezeAccount',
  'thawAccount',
  'approveChecked',
  'syncNative',
  'getAccountDataSize',
  'initializeImmutableOwner',
  'amountToUiAmount',
  'uiAmountToAmount',
  'withdrawExcessLamports',
  'unwrapLamports',
]);

/** Token-2022 extension types (a subset the node's parser may emit). */
const TOKEN_2022_EXTENSION_PARSED_TYPES = new Set([
  'initializeMintCloseAuthority',
  'transferFeeExtension',
  'confidentialTransferExtension',
  'defaultAccountStateExtension',
  'reallocate',
  'memoTransferExtension',
  'createNativeMint',
  'initializeNonTransferableMint',
  'interestBearingMintExtension',
  'cpiGuardExtension',
  'initializePermanentDelegate',
  'transferHookExtension',
  'withdrawWithheldTokensFromMints',
  'withdrawWithheldTokensFromAccounts',
  'harvestWithheldTokensToMint',
  'setTransferFee',
  'initializeConfidentialTransferMint',
  'initializeMetadataPointer',
  'initializeGroupPointer',
  'initializeGroupMemberPointer',
  'initializeScaledUiAmount',
  'initializePausable',
]);

function makeDecoder(isToken2022: boolean): ProgramDecoder {
  return {
    label: isToken2022 ? 'spl-token-2022' : 'spl-token',
    programId: isToken2022 ? TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID,
    decodeBytes: input => decodeBytes(input, isToken2022),
    decodeParsed: input => decodeParsed(input, isToken2022),
    instructionName: tag => instructionName(tag, isToken2022),
  };
}

export const splTokenProgramDecoder: ProgramDecoder = makeDecoder(false);
export const token2022ProgramDecoder: ProgramDecoder = makeDecoder(true);
