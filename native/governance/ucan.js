// UCAN-based Identity Service for OurBackyard
// Offline-capable, capability-based authorization

const UCANIdentity = {
  keyPair: null,
  peerId: null,
  
  // Initialize identity
  async init() {
    // Load or generate Ed25519 key pair
    this.keyPair = await this.loadOrGenerateKeyPair();
    
    // Generate peer ID from public key
    const { createFromEd25519PeerId } = await import('@peer-id');
    this.peerId = await createFromEd25519PeerId(this.keyPair.publicKey);
    
    console.log('[UCAN] Identity initialized:', this.getShortId());
    
    return this.peerId;
  },
  
  // Load or generate key pair
  async loadOrGenerateKeyPair() {
    const savedPrivateKey = localStorage.getItem('ucan_privateKey');
    
    if (savedPrivateKey) {
      const { importKey } = await import('@libp2p/crypto/keys');
      const privateKeyBuffer = this.base64ToArrayBuffer(savedPrivateKey);
      return await importKey(privateKeyBuffer, 'ed25519');
    }
    
    // Generate new key pair
    const { generateKeyPair } = await import('@libp2p/crypto/keys');
    const keyPair = await generateKeyPair('ed25519');
    
    // Export and save private key
    const exported = await keyPair.export();
    localStorage.setItem('ucan_privateKey', this.arrayBufferToBase64(exported));
    
    return keyPair;
  },
  
  // Sign data with private key
  async sign(data) {
    const { sign } = await import('@libp2p/crypto/keys');
    const encoder = new TextEncoder();
    const encoded = encoder.encode(JSON.stringify(data));
    const signature = await sign(this.keyPair, encoded);
    return this.arrayBufferToBase64(signature);
  },
  
  // Verify signature
  async verify(data, signature, publicKey) {
    const { verify } = await import('@libp2p/crypto/keys');
    const encoder = new TextEncoder();
    const encoded = encoder.encode(JSON.stringify(data));
    const signatureBuffer = this.base64ToArrayBuffer(signature);
    
    try {
      return await verify(publicKey, encoded, signatureBuffer);
    } catch (e) {
      return false;
    }
  },
  
  // Create UCAN token (capability)
  async createUCAN(audience, capabilities, expiryHours = 24) {
    const now = Date.now();
    const expires = now + (expiryHours * 60 * 60 * 1000);
    
    const token = {
      iss: this.getShortId(),  // Issuer
      aud: audience,            // Audience (recipient)
      cap: capabilities,       // Capabilities
      exp: expires,            // Expiry
      nbf: now,                // Not before
      nonce: crypto.randomUUID()
    };
    
    // Sign the token
    token.sig = await this.sign(token);
    
    return this.encodeUCAN(token);
  },
  
  // Verify UCAN token
  async verifyUCAN(token) {
    try {
      const decoded = this.decodeUCAN(token);
      
      // Check expiry
      if (Date.now() > decoded.exp) {
        return { valid: false, reason: 'Expired' };
      }
      
      // Check not-before
      if (Date.now() < decoded.nbf) {
        return { valid: false, reason: 'Not yet valid' };
      }
      
      // Verify signature (simplified - in production, fetch issuer's public key)
      // For now, we accept our own tokens
      const valid = await this.verify(decoded, decoded.sig, this.keyPair.publicKey);
      
      return { valid, capabilities: decoded.cap };
    } catch (e) {
      return { valid: false, reason: e.message };
    }
  },
  
  // Encode UCAN to string
  encodeUCAN(token) {
    return btoa(JSON.stringify(token));
  },
  
  // Decode UCAN from string
  decodeUCAN(str) {
    return JSON.parse(atob(str));
  },
  
  // Delegate capability to another user
  async delegate(audience, capability, expiryHours = 1) {
    return await this.createUCAN(audience, [capability], expiryHours);
  },
  
  // Get peer ID
  getPeerId() {
    return this.peerId ? this.peerId.toString() : null;
  },
  
  // Get short ID for display
  getShortId() {
    const id = this.getPeerId();
    return id ? id.substring(0, 8) + '...' : id;
  },
  
  // Helpers
  arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  },
  
  base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }
};

// Export for use in main app
window.UCANIdentity = UCANIdentity;
console.log('[OurBackyard] UCAN Identity Service loaded');
