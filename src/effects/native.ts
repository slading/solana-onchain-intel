/**
 * The wrapped-SOL (native) mint rule.
 *
 * Solana's SPL Token program treats accounts holding the *wrapped SOL* mint
 * specially: when an account is initialised with that mint, the program records
 * `is_native = Some(rent_exempt_reserve)` on the account, and from then on the
 * account's token `amount` is a claim on its own lamports. Two consequences are
 * load-bearing for the effects layer, both taken from the program source
 * (`token/program/src/processor.rs`):
 *
 * 1. **A transfer between native accounts moves lamports.** In `process_transfer`
 *    the program does, for a native source account:
 *
 *        source.lamports -= amount
 *        destination.lamports += amount
 *
 *    in addition to updating the token amounts. So a wrapped-SOL token transfer
 *    is *also* a lamport transfer of the same size, and a lamport reconciliation
 *    that ignored this would report a spurious residual on every WSOL account.
 *    (`solFlows` records these legs as `kind: 'native-token-leg'`.)
 *
 * 2. **A native account may be closed with a non-zero balance.** `process_close_account`
 *    rejects a non-native account whose `amount != 0` (`NonNativeHasBalance`) but
 *    allows a native one, moving *all* of the account's lamports to the
 *    destination: `destination += source.lamports; source = 0; delete(source)`.
 *    So what a closed native account returns is its rent deposit *plus* its
 *    unwrapped balance, while a closed non-native account returns only lamports
 *    (its token balance had to be zero).
 *
 * Nothing here is inferred: the mint address is the protocol's, the account's
 * native-ness follows from its mint, and both effects are visible in the
 * program source above.
 */

/** The wrapped-SOL mint (`native_mint::id()`). */
export const NATIVE_MINT = 'So11111111111111111111111111111111111111112';

/** `true` when `mint` is the wrapped-SOL mint, i.e. its accounts hold lamports. */
export function isNativeMint(mint: string | null): boolean {
  return mint === NATIVE_MINT;
}
