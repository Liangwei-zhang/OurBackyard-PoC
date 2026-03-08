// DAO-lite Governance
// ZK-based community voting for content moderation

const DAOGovernance = {
  config: {
    quorum: 5,           // Min voters to pass
    voteThreshold: 0.6,  // 60% to pass
    vetoThreshold: 0.4,   // 40% vetoes rejects
    evidencePeriod: 24 * 60 * 60 * 1000 // 24 hours
  },
  
  db: null,
  
  // Initialize
  async init() {
    this.db = new Dexie('DAOGovernanceDB');
    this.db.version(1).stores({
      proposals: 'id, type, contentHash, status, timestamp',
      votes: 'id, proposalId, voter, decision, timestamp',
      rulings: 'id, proposalId, outcome, timestamp'
    });
    
    console.log('[DAO] Initialized');
    return this;
  },
  
  // Submit content for review
  async submitForReview(content, reporterDid) {
    const contentHash = await this.hash(content);
    
    // Check if already under review
    const existing = await this.db.proposals
      .where('contentHash')
      .equals(contentHash)
      .first();
    
    if (existing) {
      return { alreadySubmitted: true, proposal: existing };
    }
    
    // Create proposal
    const proposal = {
      id: crypto.randomUUID(),
      type: 'content_review',
      contentHash,
      reporter: reporterDid,
      evidence: content,
      status: 'pending',
      timestamp: Date.now(),
      expiresAt: Date.now() + this.config.evidencePeriod
    };
    
    await this.db.proposals.add(proposal);
    
    console.log('[DAO] Submitted for review:', contentHash?.substring(0, 8));
    
    return { proposal };
  },
  
  // Vote on proposal
  async vote(proposalId, voterDid, decision) {
    // Check if already voted
    const existing = await this.db.votes
      .where('proposalId')
      .equals(proposalId)
      .filter(v => v.voter === voterDid)
      .first();
    
    if (existing) {
      return { alreadyVoted: true };
    }
    
    // Record vote
    const vote = {
      id: crypto.randomUUID(),
      proposalId,
      voter: voterDid,
      decision, // 'keep', 'remove', 'veto'
      timestamp: Date.now()
    };
    
    await this.db.votes.add(vote);
    
    // Check if we have quorum
    const votes = await this.db.votes
      .where('proposalId')
      .equals(proposalId)
      .toArray();
    
    if (votes.length >= this.config.quorum) {
      await this.tallyVotes(proposalId);
    }
    
    return { voteRecorded: true, totalVotes: votes.length };
  },
  
  // Tally votes and make ruling
  async tallyVotes(proposalId) {
    const votes = await this.db.votes
      .where('proposalId')
      .equals(proposalId)
      .toArray();
    
    const keep = votes.filter(v => v.decision === 'keep').length;
    const remove = votes.filter(v => v.decision === 'remove').length;
    const veto = votes.filter(v => v.decision === 'veto').length;
    const total = votes.length;
    
    let outcome;
    
    if (veto / total >= this.config.vetoThreshold) {
      outcome = 'vetoed';
    } else if (remove / total >= this.config.voteThreshold) {
      outcome = 'removed';
    } else if (keep / total >= this.config.voteThreshold) {
      outcome = 'kept';
    } else {
      outcome = 'unresolved';
    }
    
    // Record ruling
    const ruling = {
      id: crypto.randomUUID(),
      proposalId,
      outcome,
      votes: { keep, remove, veto, total },
      timestamp: Date.now()
    };
    
    await this.db.rulings.add(ruling);
    
    // Update proposal status
    await this.db.proposals.update(proposalId, { status: outcome });
    
    console.log('[DAO] Ruling:', outcome, 'for', proposalId?.substring(0, 8));
    
    return ruling;
  },
  
  // Get my votes
  async getMyVotes(did) {
    return await this.db.votes
      .where('voter')
      .equals(did)
      .toArray();
  },
  
  // Get pending proposals
  async getPendingProposals() {
    const now = Date.now();
    return await this.db.proposals
      .filter(p => p.status === 'pending' && now < p.expiresAt)
      .toArray();
  },
  
  // Generate ZK proof for vote (anonymous)
  async generateVoteProof(proposalId, decision) {
    // In production, use actual ZK
    const proof = {
      proposalId,
      decision, // Not revealed
      commitment: await this.hash(proposalId + crypto.randomUUID()),
      timestamp: Date.now()
    };
    
    return proof;
  },
  
  // Hash helper
  async hash(data) {
    const encoder = new TextEncoder();
    const buffer = encoder.encode(JSON.stringify(data));
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  },
  
  // Get stats
  async getStats() {
    const proposals = await this.db.proposals.count();
    const votes = await this.db.votes.count();
    const rulings = await this.db.rulings.count();
    
    return { proposals, votes, rulings };
  }
};

window.DAOGovernance = DAOGovernance;
console.log('[OurBackyard] DAO Governance loaded');
