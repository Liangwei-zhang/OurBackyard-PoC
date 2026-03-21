#!/usr/bin/env node
/**
 * App Bundle Script - Packages the frontend for P2P distribution
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const DIST_DIR = path.join(__dirname, '..');
const OUTPUT_FILE = path.join(__dirname, '..', 'app-bundle.json');

const FILES = ['index.html', 'sw.js'];

async function bundle() {
    console.log('📦 Packaging app for P2P distribution...\n');
    
    const bundle = {
        version: process.argv[2] || '1.0.0',
        timestamp: Date.now(),
        files: {}
    };
    
    for (const file of FILES) {
        const filePath = path.join(DIST_DIR, file);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath);
            bundle.files[file] = content.toString('base64');
            console.log(`  ✓ ${file} (${content.length} bytes)`);
        } else {
            console.log(`  ✗ ${file} not found`);
        }
    }
    
    const jsonContent = JSON.stringify(bundle);
    const compressed = zlib.gzipSync(Buffer.from(jsonContent));
    
    fs.writeFileSync(OUTPUT_FILE, jsonContent);
    fs.writeFileSync(OUTPUT_FILE.replace('.json', '.gz.json'), compressed);
    
    const hashBuffer = crypto.createHash('sha256').update(jsonContent).digest();
    const hash = 'app1-' + hashBuffer.toString('hex').substring(0, 40);
    
    console.log(`\n✅ Bundle created: ${OUTPUT_FILE}`);
    console.log(`   Version: ${bundle.version}`);
    console.log(`   Size: ${jsonContent.length} bytes (${compressed.length} compressed)`);
    console.log(`   Hash: ${hash}`);
}

bundle().catch(console.error);

// Developer keys (for demo - in production use environment variables)
const DEV_KEYS = {
    // In production, generate once and store securely:
    // privateKey: 'your-ed25519-private-key-base64'
    publicKey: 'ourbackyard-demo-key-v1'  // Embedded in app for verification
};

// Sign bundle
function signBundle(bundleHash) {
    // In real implementation, use libsodium or WebCrypto
    // For demo: simple HMAC
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', DEV_KEYS.publicKey);
    hmac.update(bundleHash);
    return hmac.digest('base64');
}

// Verify signature  
function verifySignature(signature, bundleHash) {
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', DEV_KEYS.publicKey);
    hmac.update(bundleHash);
    const expected = hmac.digest('base64');
    return signature === expected;
}

module.exports = { signBundle, verifySignature, DEV_KEYS };
