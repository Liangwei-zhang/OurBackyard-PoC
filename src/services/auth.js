/**
 * Authentication Service (DID)
 * OurBackyard P2P Marketplace
 * Handles decentralized identity using ECDSA P-256 keys
 * 
 * SECURITY: Private keys stored in memory only, not localStorage
 */

const DIDService = {
    keyPair: null,      // In-memory only (secure)
    publicKey: null,    // Can be stored in localStorage (public)
    initialized: false,

    /**
     * Initialize DID service - load or generate keys
     * Keys are stored in memory for security
     */
    async init() {
        if (this.initialized) return;
        
        // Try to load existing keys from memory first
        if (this.keyPair && this.publicKey) {
            console.log("[DID] Using existing in-memory keys");
            this.initialized = true;
            return;
        }

        // Try to load public key from localStorage (safe - it's public)
        const savedPublicKey = localStorage.getItem("did_publicKey");

        if (savedPublicKey) {
            this.publicKey = savedPublicKey;
            console.log("[DID] Loaded public key from storage");
            
            // Note: Private key cannot be recovered - user needs to re-authenticate
            // In production, consider using IndexedDB with encryption
            console.log("[DID] Note: Private key in memory only. Re-authenticate if needed.");
            this.initialized = true;
            return;
        }

        // Generate new key pair
        await this.generateKeyPair();
        this.initialized = true;
    },

    /**
     * Generate new key pair
     */
    async generateKeyPair() {
        // Generate new key pair using Web Crypto API
        this.keyPair = await crypto.subtle.generateKey(
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["sign", "verify"],
        );

        // Export public key
        const publicKeyBuffer = await crypto.subtle.exportKey(
            "spki",
            this.keyPair.publicKey,
        );
        this.publicKey = this.arrayBufferToBase64(publicKeyBuffer);

        // Store ONLY public key in localStorage (private key stays in memory)
        localStorage.setItem("did_publicKey", this.publicKey);

        console.log(
            "[DID] Generated new identity:",
            this.publicKey.substring(0, 20) + "..."
        );
    },

    /**
     * Check if we have a valid key pair
     * @returns {boolean}
     */
    hasKeyPair() {
        return this.keyPair !== null;
    },

    /**
     * Sign a message with our private key
     * @param {Object} message - Message to sign
     * @returns {Promise<string>} Base64 encoded signature
     */
    async sign(message) {
        // Regenerate key pair if needed (user re-authentication)
        if (!this.keyPair) {
            console.log("[DID] No key pair in memory, regenerating...");
            await this.generateKeyPair();
        }

        const encoder = new TextEncoder();
        const data = encoder.encode(JSON.stringify(message));

        const signature = await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            this.keyPair.privateKey,
            data,
        );

        return this.arrayBufferToBase64(signature);
    },

    /**
     * Verify a signature
     * @param {Object} message - Original message
     * @param {string} signature - Base64 encoded signature
     * @param {string} publicKeyBase64 - Base64 encoded public key
     * @returns {Promise<boolean>}
     */
    async verify(message, signature, publicKeyBase64) {
        try {
            const publicKey =
                publicKeyBase64 === this.publicKey && this.keyPair?.publicKey
                    ? this.keyPair.publicKey
                    : await crypto.subtle.importKey(
                        "spki",
                        this.base64ToArrayBuffer(publicKeyBase64),
                        { name: "ECDSA", namedCurve: "P-256" },
                        false,
                        ["verify"],
                    );

            const encoder = new TextEncoder();
            const data = encoder.encode(JSON.stringify(message));
            const signatureBuffer = this.base64ToArrayBuffer(signature);

            return await crypto.subtle.verify(
                { name: "ECDSA", hash: "SHA-256" },
                publicKey,
                signatureBuffer,
                data,
            );
        } catch (err) {
            console.error("[DID] Verify failed:", err);
            return false;
        }
    },

    /**
     * Get our DID (public key)
     * @returns {string} Public key
     */
    getDID() {
        return this.publicKey;
    },

    /**
     * Get peer ID (same as DID)
     * @returns {string} Peer ID
     */
    getPeerId() {
        return this.publicKey;
    },

    /**
     * Clear keys from memory (logout)
     */
    clearKeys() {
        this.keyPair = null;
        this.publicKey = null;
        this.initialized = false;
        localStorage.removeItem("did_publicKey");
        console.log("[DID] Keys cleared from memory");
    },

    // ============ Helpers ============

    /**
     * Convert ArrayBuffer to Base64 string
     * @param {ArrayBuffer} buffer
     * @returns {string}
     */
    arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        if (typeof Buffer !== "undefined") {
            return Buffer.from(bytes).toString("base64");
        }
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    },

    /**
     * Convert Base64 string to ArrayBuffer
     * @param {string} base64
     * @returns {ArrayBuffer}
     */
    base64ToArrayBuffer(base64) {
        if (typeof Buffer !== "undefined") {
            const bytes = Uint8Array.from(Buffer.from(base64, "base64"));
            return bytes.buffer;
        }
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return bytes.buffer;
    },
};

// Export
window.DIDService = DIDService;
