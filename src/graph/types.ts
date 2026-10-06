/**
 * Shapes of the JSON API, shared by the server and the web UI. Amounts are
 * decimal strings in the confidential token's smallest unit (6 decimals);
 * handles and hashes are hex without 0x; addresses are lowercase with 0x.
 */

/**
 * What the public data says an encrypted amount is: lo <= value <= hi.
 * Equal bounds mean the amount is public. `hi` is absent when nothing
 * bounds it from above.
 */
export interface Amount {
  lo: string
  hi?: string
  /** where an exact value comes from, when one source published it */
  source?: ClearSource
  /** the step behind each bound the derivation narrowed */
  why?: { lo?: Because; hi?: Because }
}

/** The step that last narrowed a bound. Handles are hex. */
export type Because =
  | { step: 'published' }
  | { step: 'wrap' }
  /** at most what was in circulation: wrapped so far minus unwrapped */
  | { step: 'supply'; wrapped: string; unwrapped: string }
  /** a balance is what came in minus what went out; a pool returns no more than was paid in */
  | { step: 'pool' }
  /** the token's whole history as one flow allows no more (or less) */
  | { step: 'flow' }
  /** every operation of its transaction, solved exactly, allows no more */
  | { step: 'exact' }
  /** the transactions linked to it, solved together, allow no more */
  | { step: 'lp' }
  /** computed from the operands of the operation that produced it */
  | { step: 'forward'; op: string; at: string; args: string[] }
  /** constrained by an operation that uses it, whose result is `result` */
  | { step: 'backward'; op: string; at: string; result: string }
  /** a debit: what is kept plus what is sent equals the balance before */
  | {
      step: 'ledger'
      as: 'sent' | 'kept' | 'balance'
      balance: string
      kept: string
      sent: string
      /** what the balance before is known to be: what caps sent and kept */
      before?: { lo: string; hi?: string }
    }
  /** provably the same value as another handle, and what that one is */
  | { step: 'equal'; handle: string; role?: string }

export type ClearSource =
  | 'wrap'
  | 'finalize'
  | 'disclose'
  | 'verified'
  | 'gateway'
  | 'relayer'
  /** a clear constant made into a handle: its value is in the event */
  | 'trivial'
  | 'inferred'

export interface TokenInfo {
  address: string
  symbol: string
  underlying: string
  uSymbol: string | null
  uDecimals: number | null
  rate: string
  decimals: number
}

export interface Status {
  ethBlock: number | null
  gatewayBlock: number | null
  bounds: {
    ops: number
    pairs: number
    rounds: number
    contradictions: number
    at: number
  } | null
  traces: { count: number; at: number } | null
  tokens: TokenInfo[]
}

/** The scoreboard: what the public data reveals, over all tokens */
export interface Stats {
  /** One finalized, proven link, cached during derivation for the homepage. */
  example?: LiveEvent
  accounts: number
  transfers: {
    total: number
    /** pinned to one value by the public data */
    exact: number
    /** of which provably zero (failed transfers, decoys) */
    zero: number
    /** known to within a factor of two */
    narrow: number
    /** some upper bound, wider than that */
    bounded: number
  }
  wraps: { total: number }
  unwraps: {
    total: number
    finalized: number
    /** not finalized, but the value is public anyway (Gateway or inferred) */
    pendingKnown: number
    /** not finalized and not yet decrypted: anyone may decrypt it */
    pendingDecryptable: number
  }
  balances: {
    accounts: number
    /** current balance known exactly */
    exact: number
    /** of which exactly zero */
    zero: number
  }
  links: {
    traced: number
    /** all of it provably from one depositor */
    oneDepositor: number
    /** that depositor is the withdrawing address itself */
    self: number
    viaHub: number
    several: number
  }
  /**
   * withdrawals by their anonymity set, the depositors that can have
   * funded them: one (linked), 2, 3 to 5, 6 to 20, more; and through a
   * pool, where it is unknown
   */
  sets: Record<SetFilter, number>
  /** withdrawals per month (YYYY-MM) by what the data proves */
  months: { month: string; linked: number; pool: number; several: number }[]
  readers: {
    delegations: number
    delegates: number
    wildcard: number
    userDecryptions: number
  }
  gateway: {
    publicDecryptions: number
    userDecryptions: number
  }
  /**
   * the vault router sends a leg to every vault to hide which one a user
   * picked; when every other leg is provably zero, the pick is public
   */
  router: { deposits: number; revealed: number; legs: number; zero: number }
  /** accounts with a primary ENS or GNS name */
  named: {
    accounts: number
    /** their withdrawals provably funded in full by one depositor */
    linked: number
    /** their current balance in some token known exactly and not zero */
    exactBalance: number
  }
  byToken: TokenStats[]
}

export interface TokenStats {
  token: string
  symbol: string
  transfers: number
  exact: number
  wraps: number
  unwraps: number
  holders: number
}

/**
 * What the live view can be narrowed to, each a number on the scoreboard:
 * unwraps by what the public data proves about their funds, unwraps never
 * finalized, transfers whose amount it pins, router deposits that reveal
 * their vault, and accounts with a name.
 */
export const LIVE_FILTERS = [
  'all',
  'linked',
  'self',
  'other',
  'pool',
  'several',
  'set-2',
  'set-3-5',
  'set-6-20',
  'set-21',
  'pending',
  'pinned',
  'router',
  'unwraps',
  'named',
] as const

export type LiveFilter = (typeof LIVE_FILTERS)[number]

/** The live filters of the anonymity sets, smallest first */
export const SET_FILTERS = [
  'linked',
  'set-2',
  'set-3-5',
  'set-6-20',
  'set-21',
  'pool',
] as const satisfies readonly LiveFilter[]

export type SetFilter = (typeof SET_FILTERS)[number]

export type LiveKind = 'wrap' | 'transfer' | 'unwrap'

export interface LiveEvent {
  kind: LiveKind
  time: number
  tx: string
  token: string
  symbol: string
  from: string
  to: string
  amount: Amount
  handle: string
  /** unwraps: where the funds came from */
  trace?: TraceSummary
  /** unwraps: finalized or still pending */
  finalized?: boolean
}

export interface TraceSummary {
  /**
   * deposit: funded by wraps alone; several: by more than one depositor and
   * none of them provably all; hub: partly through a contract that pools
   * funds; limit: too large to walk; empty: the withdrawal was provably 0
   */
  origin: 'deposit' | 'several' | 'hub' | 'none' | 'limit' | 'empty'
  depositors: number
  sender?: string
  senderMin?: string
  senderMax?: string
  hubs: string[]
  /** pools it went through that return members their own funds */
  via: string[]
}

export interface AddressEvent {
  time: number
  tx: string
  block: number
  log: number
  token: string
  symbol: string
  kind: 'wrap' | 'unwrap' | 'in' | 'out'
  /** the other party: sender, recipient, depositor or receiver */
  counterparty: string
  amount: Amount
  handle: string
  /** the account's balance after this event */
  balance: Amount | null
  balanceHandle: string | null
  /** unwraps: request finalized */
  finalized?: boolean
  /** wraps: who paid for it when not this account */
  depositor?: string
  /** unwraps: who receives the underlying */
  receiver?: string
}

export interface Counterparty {
  address: string
  sent: number
  received: number
  label?: string
}

export interface Link {
  address: string
  /** how many withdrawals */
  withdrawals: number
  /** provably at least this much in total */
  min: string
  token: string
}

export interface Delegation {
  delegator: string
  delegate: string
  contract: string
  expiry: string | null
  time: number
  tx: string
  active: boolean
}

export interface UserDecryption {
  id: string
  time: number
  tx: string
  user: string
  key: string
  handles: string[]
  /** what the handles are, when the index knows them */
  known: { handle: string; what: string; amount: Amount }[]
}

export interface TokenDetail {
  token: TokenInfo
  wraps: { count: number; amount: string }
  unwraps: { count: number; finalized: string; pending: number }
  transfers: number
  holders: number
  /** confidentialTotalSupply() now, and what the public data pins it to */
  /** confidentialTotalSupply() now; indexed: the index has its handle yet */
  supply: { handle: string; indexed: boolean; amount: Amount } | null
  /** inferredTotalSupply(): the underlying it holds / rate, in clear */
  escrow: string | null
}

export interface AccountInfo {
  address: string
  /** set when the address is a confidential token */
  token?: boolean
  kind: 'eoa' | 'delegated' | 'contract' | 'unknown'
  delegate?: string | null
  name?: string | null
  label?: string
  hub?: string
}

/** A withdrawal that provably came in full from one depositor */
export interface LinkedUnwrap {
  handle: string
  /** the transaction that requested it */
  tx: string
  token: string
  symbol: string
  /** the amount, exact */
  amount: string
  time: number
  depositor: string
  burner: string
  receiver: string
  /** pools on the way that only return members their own funds */
  via: string[]
  /** how the page's address or transaction takes part in it */
  role: 'depositor' | 'path' | 'unwrapper' | 'receiver' | 'unwrap'
}

export interface AddressSummary {
  account: AccountInfo
  events: AddressEvent[]
  /** current balance per token */
  balances: { token: string; symbol: string; balance: Amount | null }[]
  counterparties: Counterparty[]
  /** withdrawals linked in full that it is part of, newest first */
  linked: { total: number; rows: LinkedUnwrap[] }
  /** depositors whose wraps provably funded part of its withdrawals */
  fundedBy: Link[]
  /** withdrawals elsewhere this address's wraps provably funded in part */
  funded: Link[]
  /** who can decrypt this account's balances besides itself */
  delegations: Delegation[]
  /** decryptions this address asked the KMS for, on the Gateway (latest) */
  userDecryptions: UserDecryption[]
  /** all of them: requests, and whose balances they were */
  reads: { requests: number; accounts: number; first: number | null }
  /** decryptions of this account's handles asked for by others */
  viewedBy: { user: string; requests: number; last: number }[]
  /** the histories of the withdrawals it takes part in, newest */
  graph?: HistoryGraph
}

export interface ShareRow {
  depositor: string
  wraps: number
  min: string
  max: string | null
  first: number
  last: number
}

export interface UnwrapDetail {
  handle: string
  token: string
  symbol: string
  burner: string
  receiver: string
  time: number
  tx: string
  amount: Amount
  finalized: boolean
  finTx?: string
  finTime?: number
  finalizer?: string | null
  decryptable: boolean
  trace?: TraceSummary & { truncated: boolean; cut: boolean; events: number }
  shares: ShareRow[]
}

export interface HistoryNode {
  /**
   * `${account}`, `${account}@${token}` for an account in another token
   * than the withdrawal's, `deposit:`, `hub:` or `batch:` and the address
   */
  id: string
  account: string
  kind: 'account' | 'deposit' | 'hub' | 'target'
  label?: string
  /** the token, when not the withdrawal's */
  symbol?: string
  /** deposits: depositor and amount */
  depositor?: string
  amount?: Amount
  time?: number
  /** a vault batch the funds went through, and its exchange rate (6 decimals) */
  batch?: number
  rate?: string
  /** withdrawals: the transaction that requested it, and whether it is linked */
  tx?: string
  linked?: boolean
}

export interface HistoryEdge {
  from: string
  to: string
  amount: Amount
  time: number
  tx: string
  count: number
}

export interface HistoryGraph {
  nodes: HistoryNode[]
  edges: HistoryEdge[]
  truncated: boolean
}

/** How much is known of a value: exactly, a range, or nothing usable */
export type Known = 'exact' | 'bounded' | 'hidden'

/** The bounds of a value, without where they come from */
export interface Range {
  lo: string
  hi?: string
}

export interface OpNode {
  /** block and log index of the executor event */
  at: string
  handle: string
  op: string
  /** operands: handles with what is known of each, or a clear value */
  args: ({ handle: string; range: Range } | { value: string })[]
  caller: string
  tx: string
  time: number
  amount: Amount
  /** what the handle is: a transfer amount, a balance, ... */
  role?: string
}

/** What a handle is, in terms a reader knows */
export type About =
  | { kind: 'transfer'; symbol: string; from: string; to: string }
  | { kind: 'wrap'; symbol: string; to: string }
  | { kind: 'unwrap'; symbol: string; from: string }
  | { kind: 'balance'; symbol: string; account: string }

/** A transfer an encrypted input asked for */
export interface InputSend {
  /** the transfer's amount */
  handle: string
  amount: Amount
  about: About | null
  /**
   * sent only if the sender's balance covered the input, else nothing
   * (ERC-7984 `_update`: select(ge(balance, input), input, 0))
   */
  checked: boolean
}

/** One step of where a bound comes from, followed back toward public data */
export interface WhyStep {
  handle: string
  amount: Amount
  role: string | null
  /** which end of the range the step explains */
  side: 'lo' | 'hi'
  because: Because
  /** an equality: the if/else behind it */
  branch?: Branch
  /** the operands of a computed step, with what is known of each */
  args?: WhyTerm[]
  /** a flow step: what pins it, see `Cut` in fhe/flow.ts */
  cut?: {
    /** what came in (upper bound) or had to come in (lower bound) */
    plus: WhyTerm[]
    /** what else had to leave (upper bound) or could leave (lower bound) */
    minus: WhyTerm[]
    /** terms not listed, and what they added up to at the solve */
    morePlus: { count: number; total: string }
    moreMinus: { count: number; total: string }
    /** all plus terms minus all minus terms: the bound */
    total: string
    rounding?: 'up' | 'down'
  }
}

export interface WhyChain {
  side: 'lo' | 'hi' | 'both'
  steps: WhyStep[]
}

export interface WhyTerm {
  value?: string
  weight?: string
  handle: string
  amount: Amount
  role: string | null
}

/**
 * An encrypted if/else whose condition is known, so its result is the
 * choice it took: the two are one value
 */
export interface Branch {
  cond: WhyTerm
  /** what the condition is known to be */
  holds: boolean
  taken: WhyTerm
  other: WhyTerm
  result: WhyTerm
  /**
   * a transfer's debit: the amount asked for if the balance covers it,
   * otherwise 0
   */
  debit: boolean
  /** why the condition is known */
  because:
    | {
        /** the result does not fit what the other choice can be */
        step: 'result'
      }
    | {
        /** a comparison whose two sides allow one answer */
        step: 'compare'
        op: string
        a: WhyTerm
        b: WhyTerm | { clear: string }
      }
    | { step: 'other'; why: Because | null }
}

export interface HandleDetail {
  handle: string
  type: string
  chainId: number
  computed: boolean
  amount: Amount
  clear: {
    source: ClearSource
    value: string
    time: number
    ref: string | null
  }[]
  /**
   * where each end of its range comes from, step by step back toward
   * public data; `both` when one chain explains an exact value. An end a
   * story explains has no chain.
   */
  why: WhyChain[]
  /** an if/else with a known condition that makes it the same as another */
  same: Branch | null
  /** for each end revealed by what happened later: the trail to it */
  stories: (Story & { side: 'lo' | 'hi' })[]
  /** the operation that produced it and its operands, a few levels deep */
  expression: OpNode[]
  /** what uses it */
  usedBy: OpNode[]
  role: string | null
  about: About | null
  /** for an encrypted input: the transfers it asked for */
  sends: InputSend[]
  decryptable: { caller: string; time: number; tx: string } | null
  /**
   * an encrypted input: the address its proof binds it to, the contract it
   * is for, and the transaction that submitted it (encrypted offchain before)
   */
  input: { user: string; caller: string; tx: string; time: number } | null
  gateway: {
    id: string
    kind: 'public' | 'user'
    user: string | null
    time: number
    tx: string
  }[]
}

export interface TxDetail {
  hash: string
  block: number
  time: number
  sender: string | null
  target: string | null
  transfers: {
    log: number
    token: string
    symbol: string
    from: string
    to: string
    amount: Amount
    handle: string
    /** settled by what happened after the transaction: when the public value came */
    revealed: { time: number } | null
  }[]
  ops: OpNode[]
  /** unwraps requested or finalized in it (handles) */
  unwraps: string[]
  /** linked withdrawals whose path goes through it */
  linked: { total: number; rows: LinkedUnwrap[] }
  /** the histories of its unwraps and of those linked through it */
  graph?: HistoryGraph
  /**
   * Accounts whose balance is known exactly before and after the
   * transaction: what they received minus what they sent is exactly the
   * difference. Transfers by their place in `transfers` (0 first).
   */
  sums: {
    account: string
    symbol: string
    before: string
    after: string
    received: number[]
    sent: number[]
  }[]
}

export interface ReadersSummary {
  trust: {
    kmsNodes: number
    publicThreshold: number
    userThreshold: number
    coprocessors: number
  }
  delegates: {
    delegate: string
    delegators: number
    contracts: number
    wildcard: number
    active: number
    first: number
    last: number
    userDecryptions: number
    /** accounts whose balance handles it asked the KMS to decrypt */
    viewedAccounts: number
    label?: string
  }[]
  observers: {
    token: string
    observer: string
    added: number
    removed: number | null
  }[]
  decryptors: {
    user: string
    requests: number
    handles: number
    keys: number
    last: number
  }[]
}

/** ENS and GNS primary names by address */
export type Names = Record<string, { ens?: string; gns?: string }>

export interface Resolved {
  type: 'address' | 'tx' | 'handle' | 'unknown'
  value: string
}

/** Pooling contracts: what their own events make public */
export interface BatchMember {
  account: string
  joined: Amount
  joinHandle: string
  claimed?: Amount
  claimHandle?: string
  quit?: Amount
}

export interface BatchRow {
  id: number
  state: 'open' | 'dispatched' | 'finalized' | 'canceled'
  members: BatchMember[]
  /** what the batch unwrapped at dispatch, public */
  total?: Amount
  /** BatchFinalized: to-token units per 10^6 from-token units, public */
  rate?: string
  time: number
}

export interface PriceLevel {
  price: string
  /** PriceLevelRevealed: the sum of the quantities bid at this price */
  total: string | null
  bids: number
  bidders: number
  /** with a single bid, its quantity is the level's total */
  solo?: {
    bidder: string
    paid: Amount
    paidHandle: string
    /** a clear bid placed for an escrow, paid outside the auction */
    external: boolean
  }
}

export interface IntentRow {
  id: string
  maker: string
  time: number
  /** candidate orders: one is real, which one is encrypted */
  candidates: { assetIn: string; assetOut: string }[]
  taker?: string
  outcome: 'settled' | 'reclaimed' | 'open'
  /** what moved per asset at settlement or reclaim */
  legs: { asset: string; amount: Amount; handle: string }[]
}

export interface HubDetail {
  address: string
  kind: string | null
  name: string | null
  label?: string
  counterparties: number
  fromSymbol?: string
  toSymbol?: string
  batches?: BatchRow[]
  auction?: {
    address: string
    bids: number
    bidders: number
    canceled: number
    settlementPrice: string | null
    allocated: string | null
    winners: number
    levels: PriceLevel[]
  }
  intents?: IntentRow[]
}

/**
 * How a bound was reached: the operations that carried it, grouped by
 * transaction, from the value out to the public fact it rests on
 */
export interface Story {
  steps: StoryStep[]
  /** the public value at the end, if the trail reaches one */
  fact: {
    /** unwrap (finalized), wrap, or a clear source: gateway, disclose, ... */
    kind: string
    value: string
    handle: string
    account: string | null
    tx: string | null
    time: number | null
  } | null
  /** otherwise the rule it rests on: supply, pool, flow, exact */
  rule: string | null
  /** whether a step happened after the value's own transaction */
  later: boolean
  /**
   * along sums and differences: the bound is the public value (with its
   * sign) plus these other bounds, each with its sign, checked to add up
   */
  equation: {
    factSign: 1 | -1
    terms: {
      handle: string
      value: string
      side: 'lo' | 'hi'
      sign: 1 | -1
      /** what the amount is, what is known of it, and what made it */
      role?: string | null
      range?: Range
      made?: { time: number; tx: string; sender: string | null }
    }[]
    bound: string
  } | null
}

export interface StoryStep {
  /** the contract that ran the operations */
  caller: string
  /** the operations, in order, once each */
  ops: string[]
  /** one transaction, or the same step repeated in several */
  txs: { hash: string; block: number; time: number; sender: string | null }[]
  /** after the value's own transaction */
  later: boolean
}
