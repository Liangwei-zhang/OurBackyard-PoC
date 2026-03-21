// P2P Web Worker for background processing
// Offloads P2P operations from main thread

// Create inline worker code
const workerCode = `
// P2P Worker - Handles background P2P operations

let peerId = null;
let connected = false;
let messageQueue = [];

// Handle messages from main thread
self.onmessage = async function(e) {
  const { type, data } = e.data;
  
  switch (type) {
    case 'init':
      peerId = data.peerId;
      connected = true;
      self.postMessage({ type: 'ready', peerId });
      break;
      
    case 'send':
      await handleSend(data);
      break;
      
    case 'broadcast':
      await handleBroadcast(data);
      break;
      
    case 'sync':
      await handleSync(data);
      break;
      
    case 'compute':
      await handleCompute(data);
      break;
  }
};

// Handle send to specific peer
async function handleSend(data) {
  const { targetPeerId, message } = data;
  
  // Simulate network delay
  await new Promise(r => setTimeout(r, Math.random() * 100));
  
  // In production, would send via WebRTC/Libp2p
  self.postMessage({
    type: 'sent',
    targetPeerId,
    messageId: message.id
  });
}

// Handle broadcast to topic
async function handleBroadcast(data) {
  const { topic, message } = data;
  
  // Broadcast simulation
  self.postMessage({
    type: 'broadcasted',
    topic,
    messageId: message.id
  });
}

// Handle sync operations
async function handleSync(data) {
  const { localHashes, remoteHashes } = data;
  
  // Compute differences
  const missing = [];
  for (const hash of remoteHashes) {
    if (!localHashes.includes(hash)) {
      missing.push(hash);
    }
  }
  
  self.postMessage({
    type: 'sync_result',
    missing
  });
}

// Handle heavy computations (Merkle, hashing)
async function handleCompute(data) {
  const { operation, payload } = data;
  
  let result;
  
  switch (operation) {
    case 'hash':
      result = await computeHash(payload);
      break;
    case 'merkle_root':
      result = await computeMerkleRoot(payload);
      break;
    case 'encrypt':
      result = await encrypt(payload);
      break;
    default:
      result = null;
  }
  
  self.postMessage({
    type: 'compute_result',
    operation,
    result
  });
}

// Simple hash computation
async function computeHash(data) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(JSON.stringify(data));
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  return arrayBufferToHex(hashBuffer);
}

// Compute Merkle root
async function computeMerkleRoot(items) {
  if (items.length === 0) {
    return '0'.repeat(64);
  }
  
  let hashes = await Promise.all(items.map(item => computeHash(item)));
  
  while (hashes.length > 1) {
    const nextLevel = [];
    for (let i = 0; i < hashes.length; i += 2) {
      if (i + 1 < hashes.length) {
        const combined = hashes[i] + hashes[i + 1];
        nextLevel.push(await computeHash(combined));
      } else {
        nextLevel.push(hashes[i]);
      }
    }
    hashes = nextLevel;
  }
  
  return hashes[0];
}

// Simple encryption (for demo - use proper crypto in production)
async function encrypt(data) {
  return btoa(JSON.stringify(data));
}

// Helper: ArrayBuffer to Hex
function arrayBufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
`;

// P2P Worker Manager
const P2PWorker = {
  worker: null,
  ready: false,
  callbacks: new Map(),
  messageId: 0,
  
  // Initialize worker
  async init(peerId) {
    // Create worker from blob
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    
    this.worker = new Worker(workerUrl);
    
    // Handle messages from worker
    this.worker.onmessage = (e) => {
      this.handleMessage(e.data);
    };
    
    // Initialize with peer ID
    this.send('init', { peerId });
    
    // Wait for ready
    await new Promise(resolve => {
      const checkReady = (msg) => {
        if (msg.type === 'ready') {
          this.callbacks.delete('init_check');
          resolve();
        }
      };
      this.callbacks.set('init_check', checkReady);
    });
    
    this.ready = true;
    console.log('[P2PWorker] Ready');
    
    return this;
  },
  
  // Send message to worker
  send(type, data) {
    if (!this.worker) {
      console.error('[P2PWorker] Not initialized');
      return;
    }
    
    this.worker.postMessage({ type, data });
  },
  
  // Handle message from worker
  handleMessage(msg) {
    const { type, result } = msg;
    
    // Check for callback
    if (this.callbacks.has(type)) {
      const callback = this.callbacks.get(type);
      callback(msg);
    }
    
    // Also emit event
    if (window.dispatchEvent) {
      window.dispatchEvent(new CustomEvent('p2pworker:' + type, { detail: msg }));
    }
  },
  
  // Send message to peer (via worker)
  async sendToPeer(targetPeerId, message) {
    const id = ++this.messageId;
    
    return new Promise((resolve) => {
      this.callbacks.set('sent_' + id, (msg) => {
        resolve({ success: true, messageId: id });
      });
      
      this.send('send', {
        targetPeerId,
        message: { ...message, id }
      });
      
      // Timeout after 10 seconds
      setTimeout(() => {
        if (this.callbacks.has('sent_' + id)) {
          this.callbacks.delete('sent_' + id);
          resolve({ success: false, error: 'timeout' });
        }
      }, 10000);
    });
  },
  
  // Broadcast to topic
  async broadcast(topic, message) {
    const id = ++this.messageId;
    
    return new Promise((resolve) => {
      this.callbacks.set('broadcasted_' + id, () => {
        resolve({ success: true, messageId: id });
      });
      
      this.send('broadcast', { topic, message: { ...message, id } });
    });
  },
  
  // Sync with peer
  async sync(localHashes, remoteHashes) {
    return new Promise((resolve) => {
      this.send('sync', { localHashes, remoteHashes });
      
      this.callbacks.set('sync_result', (msg) => {
        resolve(msg.missing);
      });
    });
  },
  
  // Compute hash
  async computeHash(data) {
    return this.compute('hash', data);
  },
  
  // Compute Merkle root
  async computeMerkleRoot(items) {
    return this.compute('merkle_root', items);
  },
  
  // Generic compute
  async compute(operation, payload) {
    return new Promise((resolve) => {
      const id = 'compute_' + Date.now();
      
      this.callbacks.set(id, (msg) => {
        resolve(msg.result);
      });
      
      this.send('compute', { operation, payload });
    });
  },
  
  // Check if ready
  isReady() {
    return this.ready;
  },
  
  // Terminate worker
  terminate() {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
  }
};

// Export
window.P2PWorker = P2PWorker;
console.log('[OurBackyard] P2P Worker loaded');
