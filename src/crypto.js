// ============ Crypto Module (DID & Signatures) ============

const DIDService = {
    keyPair: null,
    publicKey: null,
    did: null,
    
    // Initialize or load DID
    async init() {
        const savedPublicKey = localStorage.getItem('did_publicKey');
        const savedPrivateKey = localStorage.getItem('did_privateKey');
        
        if (savedPublicKey && savedPrivateKey) {
            // Load existing identity
            this.publicKey = savedPublicKey;
            this.did = 'did:ourbackyard:' + this.publicKey.substring(0, 16);
            
            // Import private key
            const privateKeyBuffer = this.base64ToArrayBuffer(savedPrivateKey);
            this.keyPair = await crypto.subtle.importKey(
                'pkcs8',
                privateKeyBuffer,
                { name: 'ECDSA', namedCurve: 'P-256' },
                true,
                ['sign', 'verify']
            );
            
            console.log('[DID] Loaded existing identity:', this.did);
        } else {
            // Generate new identity
            await this.generateKeyPair();
        }
        
        return this.did;
    },
    
    // Generate new key pair
    async generateKeyPair() {
        this.keyPair = await crypto.subtle.generateKey(
            { name: 'ECDSA', namedCurve: 'P-256' },
            true,
            ['sign', 'verify']
        );
        
        // Export public key
        const publicKeyBuffer = await crypto.subtle.exportKey('spki', this.keyPair.publicKey);
        this.publicKey = this.arrayBufferToBase64(publicKeyBuffer);
        
        // Export private key
        const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', this.keyPair.privateKey);
        
        // SECURITY NOTE: Private key stored in localStorage for simplicity
        localStorage.setItem('did_privateKey', this.arrayBufferToBase64(privateKeyBuffer));
        localStorage.setItem('did_publicKey', this.publicKey);
        
        this.did = 'did:ourbackyard:' + this.publicKey.substring(0, 16);
        console.log('[DID] Generated new identity:', this.did);
    },
    
    // Sign data
    async sign(data) {
        if (!this.keyPair) {
            console.error('[DID] No keyPair available for signing');
            return null;
        }
        
        const encoded = new TextEncoder().encode(JSON.stringify(data));
        const signature = await crypto.subtle.sign(
            { name: 'ECDSA', hash: 'SHA-256' },
            this.keyPair.privateKey,
            encoded
        );
        
        return this.arrayBufferToBase64(signature);
    },
    
    // Verify signature
    async verify(data, signature, did) {
        try {
            // Extract public key from DID (simplified)
            const publicKeyHex = did.replace('did:ourbackyard:', '');
            const publicKeyBuffer = this.base64ToArrayBuffer(publicKeyHex);
            
            const key = await crypto.subtle.importKey(
                'spki',
                publicKeyBuffer,
                { name: 'ECDSA', namedCurve: 'P-256' },
                true,
                ['verify']
            );
            
            const encoded = new TextEncoder().encode(JSON.stringify(data));
            const signatureBuffer = this.base64ToArrayBuffer(signature);
            
            return await crypto.subtle.verify(
                { name: 'ECDSA', hash: 'SHA-256' },
                key,
                signatureBuffer,
                encoded
            );
        } catch (err) {
            console.error('[DID] Verification failed:', err);
            return false;
        }
    },
    
    // Helper: ArrayBuffer to Base64
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },
    
    // Helper: Base64 to ArrayBuffer
    base64ToArrayBuffer(base64) {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    }
};

// Secure messenger for signing messages
const SecureMessenger = {
    // Send signed message
    async send(msg) {
        msg.signature = await DIDService.sign(msg);
        msg.did = DIDService.did;
        msg.timestamp = Date.now();
        return msg;
    },
    
    // Verify incoming message
    async verify(msg) {
        if (!msg.signature || !msg.did) return false;
        
        // Include ALL fields that could be tampered with
        const dataToVerify = {
            type: msg.type,
            itemId: msg.itemId,
            title: msg.title,
            price: msg.price,
            description: msg.description,
            category: msg.category,
            status: msg.status,
            timestamp: msg.timestamp,
            sellerId: msg.sellerId,
        };
        
        return await DIDService.verify(dataToVerify, msg.signature, msg.did);
    }
};

// Export
window.DIDService = DIDService;
window.SecureMessenger = SecureMessenger;
