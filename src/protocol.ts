/**
 * Facts about the Zama protocol and its confidential tokens that this
 * indexer relies on. Every value was verified against onchain state, the
 * verified sources on Etherscan, or the Zama repositories at the commits
 * named below (fhevm tag v0.13.0 = 129333b9, protocol-apps 02333309,
 * openzeppelin-confidential-contracts v0.5.3). The FHEVMExecutor v0.5.0
 * upgrade (2026-10-05) and the Gateway upgrades of 2026-10-08 kept every
 * event decoded here.
 *
 * Zama confidential tokens are ERC-7984 wrappers of ERC-20 tokens. A
 * balance is a 32-byte handle that names a ciphertext held by the
 * coprocessors. Every FHE operation on handles is an FHEVMExecutor event
 * naming its operands and its result, and every transfer is a public
 * `ConfidentialTransfer(from, to, amountHandle)` event. So the address graph
 * is fully public, and every amount is a public expression over clear
 * constants, user inputs and earlier handles. Only the values of the inputs
 * are hidden, and only until somebody decrypts them.
 */

export const ETHEREUM_CHAIN_ID = 1
export const GATEWAY_CHAIN_ID = 261131

export const EXPLORER = 'https://etherscan.io'
export const GATEWAY_EXPLORER = 'https://explorer.mainnet.zama.org'

/** Host contracts on Ethereum (all UUPS proxies, owned by ZamaGovCore) */
export const HOST = {
  acl: '0xca2e8f1f656cd25c01f05d0b243ab1ecd4a8ffb6',
  executor: '0xd82385dada1ae3e969447f20a3164f6213100e75',
  kmsVerifier: '0x77627828a55156b04ac0dc0eb30467f1a552bb03',
  inputVerifier: '0xce0fc2e05cfff1b719eff7169f7d80af770c8ea2',
  protocolConfig: '0xd8236b57394f90726b26ab25d38ceac776e1a7c4',
  /** ConfidentialTokenWrappersRegistry, lists the official wrappers */
  registry: '0xeb5015ff021db115ace010f23f55c2591059bba0',
  /**
   * ZamaGovCore, an Aragon governance contract run by two multisigs, owns
   * every wrapper and can upgrade it instantly
   */
  dao: '0xb6d69d5f334d8b97b194617b53c6ab62f8681ef3',
} as const

/** Deployment blocks: indexing starts here */
export const HOST_FROM_BLOCK = 23_832_647 // ACL
export const REGISTRY_FROM_BLOCK = 24_096_655

/** Zama Gateway (Arbitrum Orbit L3, chain 261131) */
export const GATEWAY = {
  decryption: '0x0f6024a97684f7d90ddb0faad79cb15f2c888d24',
  inputVerification: '0xcb1bb072f38bdaf0f328cdef1fc6eda1df029287',
  config: '0xde537be194777a56f8b19d14079e6a78249390ab',
} as const
export const GATEWAY_FROM_BLOCK = 1_524 // Decryption, 2025-11-18
export const GATEWAY_RPC_URL = 'https://rpc.mainnet.zama.org'

/**
 * The wrappers were upgraded in block 25,077,611 (2026-05-12) to an
 * implementation with different events. Before it there was no `Wrap`
 * event and the unwrap events had no request id. Both are decoded.
 */
export const ERA_UPGRADE_BLOCK = 25_077_611

/** Event topics (keccak256 of the signature, checked with `cast keccak`) */
export const TOPICS = {
  // ERC-7984 wrapper (ConfidentialWrapper V4 and earlier)
  ConfidentialTransfer:
    '0x67500e8d0ed826d2194f514dd0d8124f35648ab6e3fb5e6ed867134cffe661e9',
  /** Wrap(address indexed to, uint256 roundedAmount, bytes32 encryptedWrappedAmount) */
  Wrap: '0xcda691c81d2fd787d8c209adb4ae8b138f857d7575adf7669195ed05482e701b',
  /** UnwrapRequested(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 amount) */
  UnwrapRequested:
    '0x4b1bfb262557cf08a74ddeefb8aef086b81deb08484bdc1820b9f420cdd1aa0e',
  /** before the upgrade: UnwrapRequested(address indexed receiver, bytes32 amount) */
  UnwrapRequestedLegacy:
    '0x77d02d353c5629272875d11f1b34ec4c65d7430b075575b78cd2502034c469ee',
  /** UnwrapFinalized(address indexed receiver, bytes32 indexed unwrapRequestId, bytes32 encryptedAmount, uint64 cleartextAmount) */
  UnwrapFinalized:
    '0x87061fd1a5b3714805472c94c9eb8a6b8491992ee77791aa2594be67b92fd962',
  /** before the upgrade: UnwrapFinalized(address indexed receiver, bytes32 encryptedAmount, uint64 cleartextAmount) */
  UnwrapFinalizedLegacy:
    '0x2d4edf3c2943002120f53dab3f8940043f34799f4a92ab90f2f81f7dd004a49e',
  /** AmountDiscloseRequested(bytes32 indexed encryptedAmount, address indexed requester) */
  AmountDiscloseRequested:
    '0x189c3bfae2e5ce7726b29d57bb6ed0f1a7ebcd153a863ff5ecb6cd998064c98c',
  /** AmountDisclosed(bytes32 indexed encryptedAmount, uint64 amount) */
  AmountDisclosed:
    '0x83bbbc07896439e5d950a6cead04cbc676180af7a61cecf43f5296475057f571',
  /** PublicDecryptionVerified(bytes32[] handlesList, bytes abiEncodedCleartexts), emitted by any app that checks KMS signatures */
  PublicDecryptionVerified:
    '0xc6366bab028b8d033cb362cfd1f2f3457ef4e92fc738b6788b90d5a7846367a0',
  /** OperatorSet(address indexed holder, address indexed operator, uint48 until) */
  OperatorSet:
    '0x921a218a75d18e8ec5704851e6b234a85725b21a2521ce889622c35dedc1fa12',
  ObserverAdded:
    '0x9e7e83ca24653c9e3f411044ebe8b4556a45c28aea2d89b408c19cb1c57fc05a',
  ObserverRemoved:
    '0xead397c44bfca7a31cf9a5fcbda7c84f8c50275b4d87e7ec8fa05cce3461472f',
  Upgraded:
    '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b',
  UserBlocked:
    '0xca86d8c91ca6d00afd863578cc633a0901fad724592f89649629fe65f61410d2',
  PauserUpdated:
    '0xa4336c0cb1e245b95ad204faed7e940d6dc999684fd8b5e1ff597a0c4efca8ab',
  // registry
  ConfidentialTokenRegistered:
    '0x42eed8e4b72463654392a0121509ef6828270926d399388ed06fa11c67087544',
  ConfidentialTokenRevoked:
    '0x9ad1148ea3c1565ed31fe78bfac14e54ac5d04fb74b22e47780055b92df63870',
  // ERC-20
  Transfer:
    '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  // ACL
  /** AllowedForDecryption(address indexed caller, bytes32[] handlesList): anyone may now ask the KMS to decrypt these */
  AllowedForDecryption:
    '0xd913ac93a959116526793ef772233273d5249597d33cddfdc34f29920541fd0a',
  /** DelegatedForUserDecryption(address indexed delegator, address indexed delegate, address contractAddress, uint64 counter, uint64 oldExpiration, uint64 newExpiration) */
  DelegatedForUserDecryption:
    '0x527b025d7ff06689c1ab9d32dfd7881c964cce72ce8ac5b2fe1d3be8cfda5bfc',
  /** RevokedDelegationForUserDecryption(address indexed delegator, address indexed delegate, address contractAddress, uint64 counter, uint64 oldExpiration) */
  RevokedDelegationForUserDecryption:
    '0x7aca80b6b7928b9038f186e3d9922a0fc5d52c398fbf144725c142c52a5277e4',
  // vault batchers (OpenZeppelin BatcherConfidential)
  Joined: '0x5f8ebbb209d7895cbfe5cf5a2dfcaedee39eb27774f2986578a70eb7e43031e8',
  Claimed: '0xbcb8b73e5a89971ee294cc3d2f51a084375b679f88047211b28c5344acb53df5',
  Quit: '0xfed44e18a570877ad40a09ae151beefb6eac79cca7bb4d393ce12451298d3e86',
  BatchDispatched:
    '0xfc50443e0b60182e19ff754c377e74204041a4c5313f72e29c827aa0c4794e72',
  BatchFinalized:
    '0x5586a68ae5708d58e7ce9e8a84d65ab6569a85e6d2e4b514e7f3175da129aad1',
  BatchCanceled:
    '0x9df57674fe50a01c8999a0ed6034d6e368eb2e2d1227f4120654a9df29eb6269',
  // ZAMA auction
  BidSubmitted:
    '0x5986d4da84b4e4719683f1ba6994a5bac9ff76c75db61b1a949e5b7d3424e892',
  BidCanceled:
    '0xbd8de31a25c2b7c2ddafffe72dab91b4ce5826cfd5664793eb206f572f732c27',
  PriceLevelRevealed:
    '0xcfb16c9262ee80d0bfdd01fa0cef049f4440b0811f46c4268e723a4d1fc462f4',
  AuctionSettled:
    '0x1aeffffe0a8c81c01a52942c1cdf52e39d45688c577968ebc98e4d3d505804dc',
  ZamaTokenDistributed:
    '0x63f3c1dfe868c93b4c1f789017d37f86d91f0df374cd4f16155c54dba820cb20',
  TokenRefunded:
    '0x8e79a06e8fa190d30622f1bd34864445aecf3656a9469472e05a204eadc2f4fe',
  // ConfidentialSwap
  /** IntentCreated(uint256 indexed intentId, address indexed maker, (uint128 pairId, uint8 direction, bool, address assetIn, address assetOut, bytes32 eAmountIn)[] orders, bytes32 eRealIndex, ...) */
  IntentCreated:
    '0x3a5afa894b934d042b20bcd6e25a8581bbb6ec43f4545afbff1e5ee37699dae5',
  IntentSettled:
    '0x6a0b861ca342ec2fb70bd11697fcacee627ab12c09c94a927af68740619a1f42',
  IntentReclaimed:
    '0xe2084892a9fadcab87201882539d1d936d5db4caf25d21857cf549a261fd104b',
  /** IntentQuoted(uint256 indexed intentId, address indexed marketMaker, bytes32[] eQuotes, bytes32 eIndexMask) */
  IntentQuoted:
    '0xfc9a866a4cd2f0de459626b8fd37e0c01696ed58df42833866559f065c805ff9',
  /** IntentResolved(uint256 indexed intentId, bytes32 eBestQuoter, bytes32 eMaskedIndex, bool earlyResolved) */
  IntentResolved:
    '0x6c9d616abbef2873c9959fd02f56c2cc51c76c60a7fbeb03091030dc271dfdfc',
  /** AnalyticsRevealed(address indexed asset, bytes32 eTotalVolume, uint64 fromTimestamp, uint64 toTimestamp): a period's swap volume of an asset, made publicly decryptable */
  AnalyticsRevealed:
    '0xbd2b96fe93b1f1c2c80a09e010bc61be58deee5e3dc6a85f62c9646549b95d6a',
  // Gateway Decryption
  /** PublicDecryptionRequest(uint256 indexed decryptionId, (bytes32 ctHandle, uint256 keyId, bytes32 snsCiphertextDigest, address[] coprocessorTxSenders)[] snsCtMaterials, bytes extraData) */
  PublicDecryptionRequest:
    '0x22db480a39bd72556438aadb4a32a3d2a6638b87c03bbec5fef6997e109587ff',
  /** PublicDecryptionResponse(uint256 indexed decryptionId, bytes decryptedResult, bytes[] signatures, bytes extraData) */
  PublicDecryptionResponse:
    '0xd7e58a367a0a6c298e76ad5d240004e327aa1423cbe4bd7ff85d4c715ef8d15f',
  /** UserDecryptionRequest(uint256 indexed decryptionId, (...)[] snsCtMaterials, address userAddress, bytes publicKey, bytes extraData) */
  UserDecryptionRequest:
    '0xf9011bd6ba0da6049c520d70fe5971f17ed7ab795486052544b51019896c596b',
} as const

/**
 * FHE operations, by FHEVMExecutor event topic (`FHEEvents.sol`). The
 * binary ones carry `lhs, rhs, scalarByte, result`; with scalarByte 1 the
 * rhs is a clear value, not a handle.
 */
export enum Op {
  Add = 1,
  Sub,
  Mul,
  Div,
  Rem,
  And,
  Or,
  Xor,
  Shl,
  Shr,
  Rotl,
  Rotr,
  Eq,
  Ne,
  Ge,
  Gt,
  Le,
  Lt,
  Min,
  Max,
  Neg,
  Not,
  Input,
  Cast,
  Trivial,
  Select,
  Rand,
  RandBounded,
  Sum,
  IsIn,
}

export const OP_TOPICS: Record<string, Op> = {
  '0xdb9050d65240431621d61d6f94b970e63f53a67a5766614ee6e5c5bbd41c8e2e': Op.Add,
  '0xeb6d37bd271abe1395b21d6d78f3487d6584862872c29ffd3f90736ee99b7393': Op.Sub,
  '0x215346a4f9f975e6d5484e290bd4e53ca14453a9d282ebd3ccedb2a0f171753d': Op.Mul,
  '0x3bab2ee0e2f90f4690c6a87bf63cf1a6b626086e95f231860b152966e8dabbf7': Op.Div,
  '0x0e691cd0bf8c4e9308e4ced1bb9c964117dc5c5bb9b9ab5bdfebf2c9b13a897c': Op.Rem,
  '0xe42486b0ccdbef81a2075c48c8e515c079aea73c8b82429997c72a2fe1bf4fef': Op.And,
  '0x56df279bbfb03d9ed097bbe2f28d520ca0c1161206327926e98664d70d2c24c4': Op.Or,
  '0x4d32284bd3193ecaa44e1ceca32f41c5d6c32803a92e07967dd3ee4229721582': Op.Xor,
  '0xe84282aaebcca698443e39a2a948a345d0d2ebc654af5cb657a2d7e8053bf6cb': Op.Shl,
  '0x324220bfc9cb158b492991c03c309cd86e5345cac45aacae2092ddabe31fa3d8': Op.Shr,
  '0xeb0e4f8dc74058194d0602425fe602f955c222200f7f10c6fe67992f7b24c7e9': Op.Rotl,
  '0xc148675905d07ad5496f8ef4d8195c907503f3ec12fd10ed5f21240abc693634': Op.Rotr,
  '0xb3d5c664ec86575818e8d75ff25c5f867250df8954088549c41c848cd10e76cb': Op.Eq,
  '0x6960c1e88f61c352dba34d1bbf6753e302795264d5d8ae82f7983c7004651e5d': Op.Ne,
  '0x38c3a63c4230de5b741f494ffb54e3087104030279bc7bccee8ad9ad31712b21': Op.Ge,
  '0xc9ff8f0d18a3f766ce5de3de216076050140e4fc2652f5e0e745f6fc836cda8b': Op.Gt,
  '0xdef2e704a077284a07f3d0b436db88f5d981b69f58ab7c1ae623252718a6de01': Op.Le,
  '0x0d483b100d8c73b208984ec697caa3091521ee5525ce69edcf97d7e395d3d059': Op.Lt,
  '0xc11d62b13c360a83082487064be1ec0878b2f0be4f012bf59f89e128063d47ff': Op.Min,
  '0xfd7c9208f956bf0c6ab76a667f04361245ad3e0a2d0eff92eb827acfcca68ea9': Op.Max,
  '0x8c664d3c3ca583fc5803b8a91c49644bbd9550bfa87967c73ad1de83027768c0': Op.Neg,
  '0x55aff4cc7a3d160c83f1f15b818011ede841a0b4597fb14dcd3603df3a11e5e0': Op.Not,
  '0xdc370db33589e73371dc3ee42c789c003d336eefcb7c3f56fe0f51ae5b1d9702':
    Op.Input,
  '0x31ccae6a2f8e3ced1692f77c8f668133e4afdaaa35afe844ff4659a6c27e627f': Op.Cast,
  '0x063ccd1bba45151d91f6a418065047a3d048d058a922535747bb2b575a01d236':
    Op.Trivial,
  '0x60be9d61aad849facc28c38b048cb5c4be3420b8fa2233e08cfa06be1b6d1c3e':
    Op.Select,
  '0x0c8aca6017003326051e19913ef02631f24b801125e1fa8a1d812e868319fda6': Op.Rand,
  '0x5222d96b836727a1d6fe1ee9aef27f9bb507bd41794defa376ff6c648aaf8ff1':
    Op.RandBounded,
  '0xd24d1fc700ce6a96b04d0ef048cb74e4c9647351da21b84501d848e16c161deb': Op.Sum,
  '0xa8b64ca323c46be8ad4087f46d85976cd3ab0bda32e171a8550a6c9b7c519a8a': Op.IsIn,
}

export const OP_NAMES: Record<Op, string> = {
  [Op.Add]: 'add',
  [Op.Sub]: 'sub',
  [Op.Mul]: 'mul',
  [Op.Div]: 'div',
  [Op.Rem]: 'rem',
  [Op.And]: 'and',
  [Op.Or]: 'or',
  [Op.Xor]: 'xor',
  [Op.Shl]: 'shl',
  [Op.Shr]: 'shr',
  [Op.Rotl]: 'rotl',
  [Op.Rotr]: 'rotr',
  [Op.Eq]: 'eq',
  [Op.Ne]: 'ne',
  [Op.Ge]: 'ge',
  [Op.Gt]: 'gt',
  [Op.Le]: 'le',
  [Op.Lt]: 'lt',
  [Op.Min]: 'min',
  [Op.Max]: 'max',
  [Op.Neg]: 'neg',
  [Op.Not]: 'not',
  [Op.Input]: 'input',
  [Op.Cast]: 'cast',
  [Op.Trivial]: 'trivial',
  [Op.Select]: 'select',
  [Op.Rand]: 'rand',
  [Op.RandBounded]: 'randBounded',
  [Op.Sum]: 'sum',
  [Op.IsIn]: 'isIn',
}

/**
 * Handle layout (`FHEVMExecutor.sol:874-899`): 21 bytes of hash, 1 byte
 * index (0xff for a computed handle, else the position in an input list),
 * 8 bytes chain id, 1 byte FHE type, 1 byte version.
 */
export enum FheType {
  Bool = 0,
  Uint8 = 2,
  Uint16 = 3,
  Uint32 = 4,
  Uint64 = 5,
  Uint128 = 6,
  Uint160 = 7,
  Uint256 = 8,
}

export const FHE_TYPE_BITS: Record<number, number> = {
  [FheType.Bool]: 1,
  [FheType.Uint8]: 8,
  [FheType.Uint16]: 16,
  [FheType.Uint32]: 32,
  [FheType.Uint64]: 64,
  [FheType.Uint128]: 128,
  [FheType.Uint160]: 160,
  [FheType.Uint256]: 256,
}

/** The wildcard contract of a user-decryption delegation: all contracts */
export const WILDCARD = '0xffffffffffffffffffffffffffffffffffffffff'

/** Zama's fees on the Gateway (ProtocolPayment), in ZAMA */
export const GATEWAY_FEES = {
  inputProof: 1,
  publicDecrypt: 0.1,
  userDecrypt: 0.1,
}

/**
 * KMS and coprocessor set at the time of writing (GatewayConfig, KMSVerifier,
 * InputVerifier on 2026-10-26): 13 KMS nodes, 7 of them can publicly
 * decrypt, 9 can re-encrypt for a user. Five coprocessors compute every
 * ciphertext; Ethereum accepts an input signed by 3 of them (1 of 1 until
 * 2026-10-22), and the Gateway commits a ciphertext 3 of them agree on, its
 * priority coprocessor being off.
 */
export const TRUST = {
  kmsNodes: 13,
  publicThreshold: 7,
  userThreshold: 9,
  coprocessors: 5,
  coprocessorThreshold: 3,
}

/** Zama's hosted relayer: public decryption requests, with an API key */
export const ZAMA_RELAYER_URL = 'https://relayer.mainnet.zama.org'

/**
 * Addresses whose role is known from the contracts and what they do onchain.
 * Contracts that interact with the wrappers are labelled at sync time from
 * their verified name on Etherscan (src/eth/contracts.ts).
 */
export const KNOWN: Record<string, { label: string; source: string }> = {
  [HOST.dao]: {
    label: 'ZamaGovCore (owner of every wrapper, run by two multisigs)',
    source: 'owner()',
  },
  '0x31bbd7a242a38372de92ca304fe29c12c90a382c': {
    label: 'ZamaDeFiGovCore (owner of the swap and the vault batchers)',
    source: 'owner() of every batcher, DEFAULT_ADMIN_ROLE of ConfidentialSwap',
  },
  '0x9b828219ad863491eb9b5225ae2d133eedea9b71': {
    label: 'Swap compliance (can decrypt every swap)',
    source: 'complianceAddress() of ConfidentialSwap',
  },
  '0x3db098436a9bd4dfd285d2289bac1f2cdb3f374e': {
    label: 'Zama vault operator (deploys and dispatches batchers)',
    source: 'deployer of every vault batcher, sender of dispatchBatch',
  },
  '0x82c4a2f27fd64c3e037e835b03109fbaccad3be6': {
    label: 'Zama hosted relayer (Gateway sender)',
    source: 'sender of the public decryption requests on the Gateway',
  },
  '0x11c6acfd368ddfab97d15649eb8043c0197fac4c': {
    label: 'Zama vault router',
    source: 'VaultBatcherConfidentialRouter, verified on Etherscan',
  },
  '0x8fe22dc7e624c02b1805d41e09741490e1018c01': {
    label: 'Zama ConfidentialSwap',
    source: 'ConfidentialSwap, verified on Etherscan',
  },
  '0x04a5b8c32f9c38092b008a4939f1f91d550c4345': {
    label: 'ZAMA token auction',
    source: 'AuctionToken, verified on Etherscan',
  },
}
