#!/usr/bin/env node
/**
 * Delta Bundle Script - Incremental updates using Merkle Tree chunking
 * Usage: node scripts/delta-bundle.js [version]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const DIST_DIR = path.join(__dirname, '..');
const OUTPUT_DIR = path.join(__dirname, '..', 'updates');

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const FILES = ['index.html', 'sw.js'];

async function createDeltaBundle(targetVersion) {
    console.log('📦 Creating delta bundle v' + targetVersion + '\n');
    
    // Ensure output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR);
    }
    
    // Read and combine all files
    let combinedContent = '';
    const fileHashes = {};
    
    for (const file of FILES) {
        const filePath = path.join(DIST_DIR, file);
        if (fs.existsSync(filePath)) {
            const content = fs.readFileSync(filePath, 'utf8');
            const hash = crypto.createHash('sha256').update(content).digest('hex');
            fileHashes[file] = hash;
            combinedContent += '<!--FILE:' + file + '-->\n' + content + '\n';
            console.log(`  ✓ ${file}: ${hash.substring(0, 12)}...`);
        }
    }
    
    // Convert to buffer and chunk
    const buffer = Buffer.from(combinedContent, 'utf8');
    const chunks = [];
    let offset = 0;
    
    while (offset < buffer.length) {
        const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
        chunks.push(chunk);
        offset += CHUNK_SIZE;
    }
    
    // Generate Merkle tree and block hashes
    const blocks = chunks.map((chunk, i) => {
        const hash = crypto.createHash('sha256').update(chunk).digest('hex');
        return {
            index: i,
            hash: hash,
            size: chunk.length,
            data: chunk.toString('base64')
        };
    });
    
    // Calculate Merkle root
    let merkleRoot = '';
    if (blocks.length > 0) {
        const hashes = blocks.map(b => b.hash);
        while (hashes.length > 1) {
            const newHashes = [];
            for (let i = 0; i < hashes.length; i += 2) {
                const combined = (hashes[i+1] || hashes[i]) + hashes[i];
                newHashes.push(crypto.createHash('sha256').update(combined).digest('hex'));
            }
            hashes.length = 0;
            hashes.push(...newHashes);
        }
        merkleRoot = hashes[0];
    }
    
    const bundle = {
        version: targetVersion,
        timestamp: Date.now(),
        merkleRoot: merkleRoot,
        totalSize: buffer.length,
        blockCount: blocks.length,
        fileHashes: fileHashes,
        blocks: blocks
    };
    
    // Save full bundle
    const bundlePath = path.join(OUTPUT_DIR, `v${targetVersion}.json`);
    fs.writeFileSync(bundlePath, JSON.stringify(bundle));
    
    // Save manifest only (for diffing)
    const manifest = {
        version: targetVersion,
        timestamp: Date.now(),
        merkleRoot: merkleRoot,
        totalSize: buffer.length,
        blockCount: blocks.length,
        fileHashes: fileHashes,
        blocks: blocks.map(b => ({ index: b.index, hash: b.hash, size: b.size }))
    };
    const manifestPath = path.join(OUTPUT_DIR, `v${targetVersion}-manifest.json`);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest));
    
    console.log(`\n✅ Delta bundle created: ${bundlePath}`);
    console.log(`   Version: ${targetVersion}`);
    console.log(`   Merkle Root: ${merkleRoot.substring(0, 16)}...`);
    console.log(`   Total Size: ${buffer.length} bytes`);
    console.log(`   Blocks: ${blocks.length} x 64KB`);
    console.log(`\n📡 To publish: PUT this bundle to a reachable URL`);
}

createDeltaBundle(process.argv[2] || '1.0.0').catch(console.error);
