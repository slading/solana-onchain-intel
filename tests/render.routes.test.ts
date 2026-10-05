/**
 * The ROUTES section: an exact rendering of the three acceptance fixtures, and the
 * properties the wording has to keep — that a route is never confused with a swap,
 * that no executed amount is ever attached to an envelope, and that a caller who
 * does not ask for routes gets, byte for byte, what the renderer produced before
 * this milestone existed.
 *
 * The goldens are deliberate: this section is the milestone's whole user-visible
 * surface, so it is pinned line by line rather than probed with substrings.
 */
import { describe, expect, it } from 'vitest';
import { transactionEffects } from '../src/effects/build.ts';
import { renderSummary } from '../src/render/summary.ts';
import { renderSwapSection } from '../src/render/swaps.ts';
import { renderRouteSection } from '../src/render/routes.ts';
import { recognizeRoutes } from '../src/route/recognize-routes.ts';
import { recognizeSwaps } from '../src/swap/recognize-swaps.ts';
import { allFixtureNames, normalizeFixture } from './helpers/fixtures.ts';
import { onlyEnvelope, routeFixture } from './helpers/routes.ts';

const GOLDEN_PROVEN = [
'TRANSACTION 26v8KDhQMUXVLCB2Xzfi3VXTDnvp61r3TLVRB3F9dJixFP7p1kkhskGrkmNshcqPA8wP5K9Th3tYqzCisvLR8ce4',
'',
'ROUTES (Jupiter route_v2 — a route envelope: intent, quote and plan only; movement stays with the legs)',
'  1 recognized • 1 proven • 0 partially proven • 0 not committed • 0 conflicting',
'',
'  [3]  route_v2  JUP6…TaV4  committed  proven',
'      route    E5JX…YTir authorizes CLD7…ruTt → Cr5v…qAeh  mints 9pJW…9ZMr → So11…1112',
'      intent   declared in 4774791332475 raw units (authorized, not proof of movement)  quoted out 15234269261 raw units',
'      policy   slippage 774 bps  declared minimum out 14055136820 raw units (route-level arithmetic on the quote; the value the program compares it against is not established)  platform fee 10 bps  positive slippage 0 bps',
'      accounts 81 slot(s): 10 declared roles  71 remaining (opaque; no role is provable and none is used as evidence)',
'      plan     3 step(s) decoded exactly (every payload byte consumed)',
'        step 0  swap tag 148 pumpSwapSellV3WithCashbackClaim  variant payload 0 byte(s)  bps 5716  input_index 0  output_index 3',
'        step 1  swap tag 75 meteoraDlmmSwapV2  variant payload 4 byte(s)  bps 1261  input_index 0  output_index 3',
'        step 2  swap tag 75 meteoraDlmmSwapV2  variant payload 4 byte(s)  bps 3023  input_index 0  output_index 3',
'      legs     3 dispatched instruction(s)  (1 self-call(s) and 1 token/system/account instruction(s) excluded)  3 recognized by the swap layer',
'        [3.0]  pAMM…fXEA  sell  plan step 0  recognized by the swap layer (pump-amm sell)',
'        [3.8]  LBUZ…Pwxo  swap2  plan step 1  recognized by the swap layer (meteora-dlmm swap2)',
'        [3.13]  LBUZ…Pwxo  swap2  plan step 2  recognized by the swap layer (meteora-dlmm swap2)',
'      align    aligned — all 3 plan step(s) matched a dispatched instruction, in order, with none left over',
'      checks  6 pass • 0 fail • 0 not-checkable',
'      unknown  plan-index-space-unknown, min-out-comparison-target-unknown, platform-fee-recipient-unknown, platform-fee-amount-unknown',
'',
'  a route appears here only because a JUP6 instruction carried the route_v2 discriminator and its header parsed with exact byte consumption. The envelope owns the declared input, the quote, the slippage tolerance, the platform-fee rate and the decoded plan — never an executed amount: every movement stays owned by the inner legs (and by EFFECTS), so a route is never counted into a swap or movement total. Plan weights are reported verbatim: a split’s weights sum to 10000 while chained steps each carry 10000, so no global-sum rule is applied. The space input_index/output_index point into is not established, so they stay opaque topology indices.',
];

const GOLDEN_REVERTED_CHAIN = [
'TRANSACTION 23JgzJH8s6CYBZ63aB7s4x4kEcuXj4YTTCmPUmzNjwEP3naN4djdjVYTP4UVbxc25KYHuiaK3Dy7wLeE4hvK5xJK',
'',
'ROUTES (Jupiter route_v2 — a route envelope: intent, quote and plan only; movement stays with the legs)',
'  1 recognized • 0 proven • 0 partially proven • 1 not committed • 0 conflicting',
'',
'  [0]  route_v2  JUP6…TaV4  reverted  NOT COMMITTED (transaction failed)',
'      note  the transaction failed and rolled back: what follows is the route’s intent, never settled movement',
'      route    9Zdi…XTgE authorizes Bc4k…1uBS → Bc4k…1uBS  mints EPjF…Dt1v → EPjF…Dt1v',
'      intent   declared in 180000000 raw units (authorized, not proof of movement)  quoted out 180000600 raw units',
'      policy   slippage 0 bps  declared minimum out 180000600 raw units (route-level arithmetic on the quote; the value the program compares it against is not established)  platform fee 0 bps  positive slippage 0 bps',
'      accounts 64 slot(s): 10 declared roles  54 remaining (opaque; no role is provable and none is used as evidence)',
'      plan     4 step(s) decoded exactly (every payload byte consumed)',
'        step 0  swap tag 151 goonFiV3  variant payload 1 byte(s)  bps 10000  input_index 0  output_index 1',
'        step 1  swap tag 17 whirlpool  variant payload 1 byte(s)  bps 10000  input_index 1  output_index 2',
'        step 2  swap tag 141 bisonFiV2  variant payload 1 byte(s)  bps 10000  input_index 2  output_index 3',
'        step 3  swap tag 151 goonFiV3  variant payload 1 byte(s)  bps 10000  input_index 4  output_index 5',
'      legs     4 dispatched instruction(s)  (0 self-call(s) and 0 token/system/account instruction(s) excluded)  0 recognized by the swap layer',
'        [0.0]  goon…RSLE  discriminator 01010095ba0a0000 (name not proven)  plan step 0  not recognized as a swap',
'        [0.3]  whir…tyCc  swap  plan step 1  not recognized as a swap',
'        [0.6]  BiSo…Uypi  discriminator 0227865458000000 (name not proven)  plan step 2  not recognized as a swap',
'        [0.9]  goon…RSLE  discriminator 0100000000000000 (name not proven)  plan step 3  not recognized as a swap',
'      align    aligned — all 4 plan step(s) matched a dispatched instruction, in order, with none left over',
'      checks  4 pass • 0 fail • 2 not-checkable (legs-covered-by-swap-recognizers, transaction-committed)',
'      unknown  plan-index-space-unknown, min-out-comparison-target-unknown',
'',
'  a route appears here only because a JUP6 instruction carried the route_v2 discriminator and its header parsed with exact byte consumption. The envelope owns the declared input, the quote, the slippage tolerance, the platform-fee rate and the decoded plan — never an executed amount: every movement stays owned by the inner legs (and by EFFECTS), so a route is never counted into a swap or movement total. Plan weights are reported verbatim: a split’s weights sum to 10000 while chained steps each carry 10000, so no global-sum rule is applied. The space input_index/output_index point into is not established, so they stay opaque topology indices.',
];

const GOLDEN_REVERTED_BOUND = [
'TRANSACTION JJ8wdEQwqJY8wqv4EVJ62PBuKpQn3VRmJzAHvGjBqUaji7UaoPMC32PfLbh4NbJSqu4re3AuYX3WU3mCuFP48E3',
'',
'ROUTES (Jupiter route_v2 — a route envelope: intent, quote and plan only; movement stays with the legs)',
'  1 recognized • 0 proven • 0 partially proven • 1 not committed • 0 conflicting',
'',
'  [1]  route_v2  JUP6…TaV4  reverted  NOT COMMITTED (transaction failed)',
'      note  the transaction failed and rolled back: what follows is the route’s intent, never settled movement',
'      route    3y5u…Gas5 authorizes FKmx…mKvD → FKmx…mKvD  mints EPjF…Dt1v → EPjF…Dt1v',
'      intent   declared in 28574769 raw units (authorized, not proof of movement)  quoted out 28575384 raw units',
'      policy   slippage 0 bps  declared minimum out 28575384 raw units (route-level arithmetic on the quote; the value the program compares it against is not established)  platform fee 0 bps  positive slippage 0 bps',
'      accounts 45 slot(s): 10 declared roles  35 remaining (opaque; no role is provable and none is used as evidence)',
'      plan     2 step(s) decoded exactly (every payload byte consumed)',
'        step 0  swap tag 151 goonFiV3  variant payload 1 byte(s)  bps 10000  input_index 0  output_index 1',
'        step 1  swap tag 156 byrealDynamicV3  variant payload 0 byte(s)  bps 10000  input_index 1  output_index 0',
'      legs     2 dispatched instruction(s)  (1 self-call(s) and 0 token/system/account instruction(s) excluded)  0 recognized by the swap layer',
'        [1.0]  goon…RSLE  discriminator 01013104b4010000 (name not proven)  plan step 0  not recognized as a swap',
'        [1.3]  REAL…Q5N2  discriminator e52ed584692828e4 (name not proven)  plan step 1  not recognized as a swap',
'      align    aligned — all 2 plan step(s) matched a dispatched instruction, in order, with none left over',
'      checks  4 pass • 0 fail • 2 not-checkable (legs-covered-by-swap-recognizers, transaction-committed)',
'      unknown  plan-index-space-unknown, min-out-comparison-target-unknown',
'',
'  a route appears here only because a JUP6 instruction carried the route_v2 discriminator and its header parsed with exact byte consumption. The envelope owns the declared input, the quote, the slippage tolerance, the platform-fee rate and the decoded plan — never an executed amount: every movement stays owned by the inner legs (and by EFFECTS), so a route is never counted into a swap or movement total. Plan weights are reported verbatim: a split’s weights sum to 10000 while chained steps each carry 10000, so no global-sum rule is applied. The space input_index/output_index point into is not established, so they stay opaque topology indices.',
];


function analysis(name: string) {
  const { transaction } = normalizeFixture(name);
  const effects = transactionEffects(transaction);
  const swaps = recognizeSwaps(transaction, { effects });
  return { transaction, effects, swaps, routes: recognizeRoutes(transaction, { swaps }) };
}

/** Renders a fixture exactly as the CLI does, with or without the route model. */
function render(name: string, withRoutes: boolean): string {
  const { transaction, effects, swaps, routes } = analysis(name);
  return renderSummary(transaction, {
    includeLogs: true,
    effects,
    swaps,
    routes: withRoutes ? routes : null,
  });
}

/** The ROUTES-only rendering of a fixture, exactly as the CLI prints it for `--routes`. */
function routesOnly(name: string): readonly string[] {
  const { transaction, swaps, routes } = analysis(name);
  const text = renderSummary(transaction, {
    includeLogs: false,
    effects: null,
    swaps,
    routes,
    onlyRoutes: true,
  });
  return text.split('\n').slice(1);
}

const SECTION_HEADING = /^[A-Z][A-Z ]+/;

/**
 * Splits a full summary at its ROUTES section: everything before it, the block
 * itself (heading included), and everything from the blank line that separates it
 * from the next section onwards.
 */
function splitRoutes(text: string): { before: string[]; block: string[]; after: string[] } {
  const lines = text.split('\n');
  const start = lines.findIndex(line => line.startsWith('ROUTES ('));
  expect(start, 'no ROUTES section').toBeGreaterThanOrEqual(0);
  const next = lines.slice(start + 1).findIndex(line => SECTION_HEADING.test(line));
  const end = next < 0 ? lines.length : start + 1 + next;
  const block = lines.slice(start, end);
  while (block.length > 0 && (block.at(-1) as string).trim() === '') block.pop();
  return { before: lines.slice(0, start - 1), block, after: lines.slice(end - 1) };
}

/** The ROUTES block of a full summary, heading included. */
function routesBlock(name: string): readonly string[] {
  return splitRoutes(render(name, true)).block;
}

/** The same transaction rendered as if Milestone 4.4 had never been written. */
function withoutRoutes(name: string): string {
  const { before, after } = splitRoutes(render(name, true));
  return [...before, ...after].join('\n');
}

/** Every amount the swap layer reported as moved in this transaction. */
function movedAmounts(name: string): readonly string[] {
  const { swaps } = analysis(name);
  const text = renderSwapSection(swaps, { abbreviateAddresses: true }).join('\n');
  return [...text.matchAll(/(\d+) raw units/g)].map(match => match[1] as string);
}

/** Whole-number tokens of at least `minDigits` digits, ignoring hex and address text. */
function numbersIn(text: string, minDigits = 4): ReadonlySet<string> {
  const pattern = new RegExp(`(?<![0-9A-Za-z_])(\\d{${minDigits},})(?![0-9A-Za-z_])`, 'g');
  return new Set([...text.matchAll(pattern)].map(match => match[1] as string));
}

describe('the ROUTES section, fixture by fixture', () => {
  it('renders v0-success-swap exactly', () => {
    expect(routesOnly('v0-success-swap')).toEqual(GOLDEN_PROVEN);
  });

  it('renders v1-failed-custom11 exactly', () => {
    expect(routesOnly('v1-failed-custom11')).toEqual(GOLDEN_REVERTED_CHAIN);
  });

  it('renders v1-failed-custom6001 exactly', () => {
    expect(routesOnly('v1-failed-custom6001')).toEqual(GOLDEN_REVERTED_BOUND);
  });
});

describe('a route is never presented as a swap', () => {
  it('uses route vocabulary in its header, labels and footer', () => {
    const block = routesBlock('v0-success-swap').join('\n');
    expect(block).toContain('ROUTES (Jupiter route_v2 — a route envelope');
    for (const label of ['route', 'intent', 'policy', 'plan', 'legs', 'align', 'accounts', 'checks', 'unknown']) {
      expect(block, label).toContain(`      ${label} `);
    }
    for (const word of ['Jupiter swap', 'JUPITER SWAP', 'settled ', 'swap executed']) {
      expect(block, word).not.toContain(word);
    }
  });

  it('does not reuse the SWAPS labels for any of its own envelope lines', () => {
    const labels = routesBlock('v0-success-swap')
      .filter(line => /^\s{6}\S/.test(line))
      .map(line => line.trimStart().split(/\s{2,}/)[0] as string);
    expect(labels).not.toContain('in');
    expect(labels).not.toContain('out');
    expect(labels).not.toContain('roles');
    expect(labels).not.toContain('fees');
    expect(labels).not.toContain('min out');
  });

  it('sits below SWAPS and above EFFECTS, so it cannot obscure either', () => {
    const lines = render('v0-success-swap', true).split('\n');
    const at = (heading: string) => lines.findIndex(line => line.startsWith(heading));
    expect(at('SWAPS (')).toBeGreaterThan(0);
    expect(at('ROUTES (')).toBeGreaterThan(at('SWAPS ('));
    expect(at('EFFECTS (')).toBeGreaterThan(at('ROUTES ('));
    expect(at('SOL BALANCE CHANGES')).toBeGreaterThan(at('EFFECTS ('));
  });

  it('keeps the dev note about plan weights and opaque indices in the footer', () => {
    const footer = routesBlock('v0-success-swap').find(line => line.includes('a route appears here'));
    expect(footer).toBeDefined();
    expect(footer).toContain('no global-sum rule is applied');
    expect(footer).toContain('opaque topology indices');
    expect(footer).toContain('never counted into a swap or movement total');
  });
});

describe('no executed amount is ever attached to a route', () => {
  it('prints no amount the swap layer reported as moved', () => {
    for (const name of ['v0-success-swap', 'v1-failed-custom11', 'v1-failed-custom6001']) {
      const printed = numbersIn(routesBlock(name).join('\n'));
      const moved = movedAmounts(name);
      if (name === 'v0-success-swap') expect(moved.length, name).toBeGreaterThan(0);
      for (const amount of moved) {
        expect(printed.has(amount), `${name} printed the swap-layer amount ${amount}`).toBe(false);
      }
    }
  });

  it('prints only the envelope’s own declared numbers', () => {
    for (const name of ['v0-success-swap', 'v1-failed-custom11', 'v1-failed-custom6001']) {
      const envelope = onlyEnvelope(analysis(name).routes);
      const declared = new Set<bigint>();
      for (const value of [
        envelope.intent.declaredInAmount,
        envelope.intent.quotedOutAmount,
        envelope.intent.declaredMinOutAmount,
      ]) {
        expect(value, name).not.toBeNull();
        if (value !== null) declared.add(value);
      }
      // Raw discriminators are byte dumps, not amounts, and are excluded here.
      const block = routesBlock(name)
        .join('\n')
        .replace(/discriminator [0-9a-f]+/g, 'discriminator <bytes>');
      const numbers = [...numbersIn(block, 6)].map(value => BigInt(value));
      const ascending = (a: bigint, b: bigint): number => (a < b ? -1 : 1);
      expect([...numbers].sort(ascending), name).toEqual([...declared].sort(ascending));
    }
  });

  it('labels the declared input as intent, and the derived floor as arithmetic only', () => {
    const block = routesBlock('v1-failed-custom11').join('\n');
    expect(block).toContain('declared in 180000000 raw units (authorized, not proof of movement)');
    expect(block).toContain('declared minimum out 180000600 raw units (route-level arithmetic on the quote');
    expect(block).toContain('the value the program compares it against is not established');
    expect(block).toContain('never settled movement');
  });
});

describe('turning the route section off is byte-identical to not having it', () => {
  it('reproduces the pre-4.4 rendering for every fixture', () => {
    for (const name of allFixtureNames()) {
      const withRoutes = analysis(name);
      const off = renderSummary(withRoutes.transaction, {
        includeLogs: true,
        effects: withRoutes.effects,
        swaps: withRoutes.swaps,
      });
      expect(withoutRoutes(name), name).toBe(off);
    }
  });

  it('leaves everything outside the block byte-identical when routes are on', () => {
    for (const name of allFixtureNames()) {
      const off = render(name, false).split('\n');
      const { before, block, after } = splitRoutes(render(name, true));
      // The block is the only insertion: what precedes it is a prefix of the old
      // rendering, and what follows it is the remainder.
      expect(before, name).toEqual(off.slice(0, before.length));
      expect(after, name).toEqual(off.slice(before.length));
      expect(block.filter(line => SECTION_HEADING.test(line)), name).toHaveLength(1);
      expect(before.some(line => line.startsWith('SWAPS (')), name).toBe(true);
      expect(after.some(line => line.startsWith('EFFECTS (')), name).toBe(true);
    }
  });

  it('renders the empty ROUTES section for a transaction with no route, and nothing more', () => {
    for (const name of allFixtureNames()) {
      if (routeFixture(name).routes.envelopes.length > 0) continue;
      expect(routesBlock(name), name).toEqual([
        'ROUTES (Jupiter route_v2 — a route envelope: intent, quote and plan only; movement stays with the legs)',
        '  (no Jupiter route_v2 instruction was recognized in this transaction)',
      ]);
      expect(withoutRoutes(name), name).toBe(render(name, false));
    }
  });
});

describe('the ROUTES-only rendering', () => {
  it('shows the transaction line and the section, and no other section', () => {
    const lines = routesOnly('v0-success-swap');
    const headings = lines.filter(line => line.trim() !== '' && !line.startsWith(' ')).map(line => line.split(' ')[0]);
    expect(headings).toEqual(['TRANSACTION', 'ROUTES']);
  });

  it('says the section was not computed when it was not asked for', () => {
    const { transaction, swaps } = analysis('v0-success-swap');
    const text = renderSummary(transaction, {
      includeLogs: false,
      effects: null,
      swaps,
      routes: null,
      onlyRoutes: true,
    });
    expect(text).toContain('ROUTES (not computed)');
  });

  it('renders an empty report as an empty section', () => {
    const empty = {
      envelopes: [],
      counts: { recognized: 0, proven: 0, partiallyProven: 0, notCommitted: 0, conflicting: 0 },
      diagnostics: [],
    };
    expect(renderRouteSection(empty, { abbreviateAddresses: true })).toEqual([
      'ROUTES (Jupiter route_v2 — a route envelope: intent, quote and plan only; movement stays with the legs)',
      '  (no Jupiter route_v2 instruction was recognized in this transaction)',
    ]);
  });
});
