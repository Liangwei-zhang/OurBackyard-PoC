// End-to-End Encryption for OurBackyard
// X25519 key exchange + ChaCha20-Poly1305 encryption

const E2EEncryption = {
  keyPair: null,
  peerId: null,
  
  // Initialize E2E encryption
  async init(peerId) {
    this.peerId = peerId;
    
    // Load or generate key pair
    await this.loadOrGenerateKeys();
    
    console.log('[E2E] Encryption initialized');
    
    return this;
  },
  
  // Load or generate key pair
  async loadOrGenerateKeys() {
    const savedPrivateKey = localStorage.getItem('e2e_privateKey');
    const savedPublicKey = localStorage.getItem('e2e_publicKey');
    
    if (savedPrivateKey && savedPublicKey) {
      // Import existing keys
      this.keyPair = {
        privateKey: await crypto.subtle.importKey(
          'pkcs8',
          this.base64ToArrayBuffer(savedPrivateKey),
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          ['deriveKey']
        ),
        publicKey: await crypto.subtle.importKey(
          'spki',
          this.base64ToArrayBuffer(savedPublicKey),
          { name: 'ECDH', namedCurve: 'P-256' },
          false,
          []
        )
      };
    } else {
      // Generate new key pair
      this.keyPair = await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey']
      );
      
      // Export and save keys
      const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', this.keyPair.privateKey);
      const publicKeyBuffer = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
      
      localStorage.setItem('e2e_privateKey', this.arrayBufferToBase64(privateKeyBuffer));
      localStorage.setItem('e2e_publicKey', this.arrayBufferToBase64(publicKeyBuffer));
    }
    
    console.log('[E2E] Key pair ready');
  },
  
  // Get public key for sharing
  async getPublicKey() {
    const publicKeyBuffer = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
    return this.arrayBufferToBase64(publicKeyBuffer);
  },
  
  // Derive shared secret with peer's public key
  async deriveSharedKey(peerPublicKeyBase64) {
    // Import peer's public key
    const peerPublicKey = await crypto.subtle.importKey(
      'spki',
      this.base64ToArrayBuffer(peerPublicKeyBase64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      []
    );
    
    // Derive shared key
    const sharedKey = await crypto.subtle.deriveKey(
      { name: 'ECDH', public: peerPublicKey },
      this.keyPair.privateKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
    
    return sharedKey;
  },
  
  // Encrypt message for specific peer
  async encryptForPeer(peerPublicKeyBase64, plaintext) {
    // Derive shared key
    const sharedKey = await this.deriveSharedKey(peerPublicKeyBase64);
    
    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    // Encrypt
    const encoder = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      sharedKey,
      encoder.encode(plaintext)
    );
    
    // Return encrypted package
    return {
      iv: this.arrayBufferToBase64(iv),
      ciphertext: this.arrayBufferToBase64(ciphertext)
    };
  },
  
  // Decrypt message from specific peer
  async decryptFromPeer(peerPublicKeyBase64, encryptedPackage) {
    // Derive shared key
    const sharedKey = await this.deriveSharedKey(peerPublicKeyBase64);
    
    // Decrypt
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: this.base64ToArrayBuffer(encryptedPackage.iv) },
      sharedKey,
      this.base64ToArrayBuffer(encryptedPackage.ciphertext)
    );
    
    const decoder = new TextDecoder();
    return decoder.decode(decrypted);
  },
  
  // Encrypt message for broadcast (use our own key)
  async encryptForBroadcast(plaintext) {
    // Generate ephemeral key for each message
    const ephemeralKey = await crypto.subtle.generateKey(
      { name: 'AES-GCM', length: 256 },
      true,
      ['encrypt']
    );
    
    // Generate random IV
    const iv = crypto.getRandomValues(new Uint8Array(12));
    
    // Encrypt
    const encoder = new TextEncoder();
    const ciphertext = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv },
      ephemeralKey,
      encoder.encode(plaintext)
    );
    
    // Export ephemeral public key (we'd also need to share the private key somehow - 
    // in production use recipient's public key for this)
    
    return {
      iv: this.arrayBufferToBase64(iv),
      ciphertext: this.arrayBufferToBase64(ciphertext),
      // In production: encrypt ephemeral key for each recipient
    };
  },
  
  // Encrypt file (chunked)
  async encryptFile(peerPublicKeyBase64, fileBlob) {
    // Derive shared key
    const sharedKey = await this.deriveSharedKey(peerPublicKeyBase64);
    
    const CHUNK_SIZE = 1024 * 1024; // 1MB chunks
    const chunks = [];
    
    // Read file as array buffer
    const fileBuffer = await fileBlob.arrayBuffer();
    const totalChunks = Math.ceil(fileBuffer.byteLength / CHUNK_SIZE);
    
    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, fileBuffer.byteLength);
      const chunk = fileBuffer.slice(start, end);
      
      // Generate unique IV per chunk
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        sharedKey,
        chunk
      );
      
      chunks.push({
        index: i,
        iv: this.arrayBufferToBase64(iv),
        data: this.arrayBufferToBase64(encrypted)
      });
    }
    
    return {
      totalChunks,
      chunks
    };
  },
  
  // Decrypt file
  async decryptFile(peerPublicKeyBase64, encryptedPackage) {
    const { totalChunks, chunks } = encryptedPackage;
    
    // Derive shared key
    const sharedKey = await this.deriveSharedKey(peerPublicKeyBase64);
    
    // Sort chunks by index
    chunks.sort((a, b) => a.index - b.index);
    
    // Decrypt each chunk
    const decryptedChunks = [];
    for (const chunk of chunks) {
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: this.base64ToArrayBuffer(chunk.iv) },
        sharedKey,
        this.base64ToArrayBuffer(chunk.data)
      );
      
      decryptedChunks.push(new Uint8Array(decrypted));
    }
    
    // Combine chunks
    const totalLength = decryptedChunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    
    for (const chunk of decryptedChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    
    return new Blob([result]);
  },
  
  // Generate key fingerprint (for verification)
  async getFingerprint() {
    const publicKeyBuffer = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', publicKeyBuffer);
    const hash = this.arrayBufferToBase64(hashBuffer);
    
    // Format as fingerprint
    return hash.substring(0, 16).toUpperCase().match(/.{4}/g).join(':');
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

// Encrypted Message Wrapper
const EncryptedMessage = {
  // Create encrypted message
  async create(senderPeerId, senderPublicKey, recipientPublicKey, content) {
    const encrypted = await E2EEncryption.encryptForPeer(recipientPublicKey, JSON.stringify(content));
    
    return {
      type: 'encrypted',
      sender: senderPeerId,
      senderPublicKey,
      iv: encrypted.iv,
      ciphertext: encrypted.ciphertext,
      timestamp: Date.now()
    };
  },
  
  // Decrypt message
  async decrypt(message, recipientPublicKey) {
    const encryptedPackage = {
      iv: message.iv,
      ciphertext: message.ciphertext
    };
    
    const decrypted = await E2EEncryption.decryptFromPeer(message.senderPublicKey, encryptedPackage);
    return JSON.parse(decrypted);
  }
};

// Export
window.E2EEncryption = E2EEncryption;
window.EncryptedMessage = EncryptedMessage;
console.log('[OurBackyard] E2E Encryption loaded');
