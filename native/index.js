/**
 * OurBackyard - Module Index
 * 
 * 統一的模塊導出入口
 * 
 * @version 2.0.0
 * @date 2026-03-08
 */

// 通訊層
const Communication = {
  Libp2p: require('./communication/libp2p'),
  HyperswarmDHT: require('./communication/hyperswarm-dht'),
  GossipSub: require('./communication/gossipsub'),
  mDNS: require('./communication/mDNS'),
  BLEWiFiDirect: require('./communication/ble-wifi-direct'),
  CircuitRelay: require('./communication/circuit-relay'),
  IntentRouting: require('./communication/intent-routing'),
  DynamicRelaySelection: require('./communication/dynamic-relay-selection')
};

// AI 層
const AI = {
  LocalAI: require('./ai/local-ai'),
  LocalAIComplete: require('./ai/local-ai-complete'),
  FederatedLearning: require('./ai/federated-learning'),
  DPFederatedLearning: require('./ai/dp-federated-learning'),
  AIAssistant: require('./ai/ai-assistant'),
  PrivacyBudgetManager: require('./ai/privacy-budget-manager')
};

// 安全層
const Security = {
  E2EEncryption: require('./security/e2e-encryption'),
  PostQuantumCrypto: require('./security/post-quantum-crypto'),
  HomomorphicSearch: require('./security/homomorphic-search'),
  TEESecureEnclave: require('./security/tee-secure-enclave')
};

// 治理層
const Governance = {
  UCAN: require('./governance/ucan'),
  WoTTrust: require('./governance/wot-trust'),
  ZKReputation: require('./governance/zk-reputation'),
  ZKReputationComplete: require('./governance/zk-reputation-complete'),
  PoWSpamProtection: require('./governance/pow-spam-protection'),
  DAOGoverance: require('./governance/dao-governance'),
  LiquidDemocracy: require('./governance/liquid-democracy')
};

// 數據層
const Data = {
  Hypercore: require('./data/hypercore'),
  CRDTStore: require('./data/crdt-store'),
  P2PStore: require('./data/p2p-store'),
  SponsorNode: require('./data/sponsor-node'),
  GeoReplication: require('./data/geo-replication'),
  LogCompaction: require('./data/log-compaction'),
  AdaptiveRedundancy: require('./data/adaptive-redundancy'),
  GeoPrefetch: require('./data/geo-prefetch'),
  HolographicStorage: require('./data/holographic-storage'),
  ZKStorageProof: require('./data/zk-storage-proof'),
  IncrementalSnapshots: require('./data/incremental-snapshots')
};

// 其他核心模塊
const Core = {
  DeadDrop: require('./dead-drop'),
  DesktopFullNode: require('./desktop-full-node'),
  DTNDataMule: require('./dtn-data-mule'),
  MultiLayerDiscovery: require('./multi-layer-discovery'),
  P2PWorker: require('./p2p-worker'),
  ResourceQuota: require('./resource-quota'),
  TrustedComputeOffload: require('./trusted-compute-offload'),
  ZKTimebanking: require('./zk-timebanking')
};

// 統一導出
module.exports = {
  // 版本
  VERSION: '2.0.0',
  
  // 層次
  Communication,
  AI,
  Security,
  Governance,
  Data,
  Core,
  
  // 快捷導入
  createLibp2p: () => new Communication.Libp2p(),
  createAIAssistant: (libp2p) => new AI.AIAssistant(libp2p),
  createTEESecureEnclave: () => new Security.TEESecureEnclave(),
  createZKTimebanking: () => new Core.ZKTimebanking(),
  
  // 獲取所有模塊列表
  getAllModules: () => ({
    communication: Object.keys(Communication),
    ai: Object.keys(AI),
    security: Object.keys(Security),
    governance: Object.keys(Governance),
    data: Object.keys(Data),
    core: Object.keys(Core)
  })
};
