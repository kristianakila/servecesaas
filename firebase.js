const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK
let firebaseInitialized = false;

function initializeFirebase() {
    if (firebaseInitialized) {
        return admin.firestore();
    }

    try {
        // Get service account from environment variable or file
        let serviceAccount;
        
        if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
            // Parse from environment variable (for platforms like Render, Heroku)
            serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
        } else {
            // Load from file (for local development)
            const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
            serviceAccount = require(serviceAccountPath);
        }

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });

        console.log('✅ Firebase initialized successfully');
        firebaseInitialized = true;
        return admin.firestore();
    } catch (error) {
        console.error('❌ Failed to initialize Firebase:', error);
        throw error;
    }
}

// Firebase collections structure
const COLLECTIONS = {
    CLIENTS: 'clients',
    SPINS: 'spins',
    REFERRALS: 'referrals',
    LEADS: 'leads',
    LEAD_EVENTS: 'lead_events',
    AUDIENCE: 'audience',
    WHEEL_ITEMS: 'wheel_items',
    PENDING_FALLBACKS: 'pending_fallbacks',
    BROADCAST_JOBS: 'broadcast_jobs',
    BROADCAST_ITEMS: 'broadcast_items'
};

class FirebaseService {
    constructor(clientId) {
        this.db = initializeFirebase();
        this.clientId = clientId;
    }

    // Helper to get client-specific collection reference
    collection(collectionName) {
        return this.db
            .collection(COLLECTIONS.CLIENTS)
            .doc(this.clientId)
            .collection(collectionName);
    }

    // Client management
    async getClientData() {
        const doc = await this.db
            .collection(COLLECTIONS.CLIENTS)
            .doc(this.clientId)
            .get();
        
        return doc.exists ? doc.data() : null;
    }

    async updateClientData(data) {
        return await this.db
            .collection(COLLECTIONS.CLIENTS)
            .doc(this.clientId)
            .set(data, { merge: true });
    }

    // CRUD operations
    async addSpin(spinData) {
        const spinsRef = this.collection(COLLECTIONS.SPINS);
        const docRef = await spinsRef.add({
            ...spinData,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { id: docRef.id, ...spinData };
    }

    async getSpins(userId, limit = 100) {
        const spinsRef = this.collection(COLLECTIONS.SPINS);
        let query = spinsRef.where('userId', '==', parseInt(userId));
        query = query.orderBy('createdAt', 'desc').limit(limit);
        
        const snapshot = await query.get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    async countSpins(userId) {
        const spinsRef = this.collection(COLLECTIONS.SPINS);
        const snapshot = await spinsRef
            .where('userId', '==', parseInt(userId))
            .get();
        return snapshot.size;
    }

    async addReferral(referralData) {
        const referralsRef = this.collection(COLLECTIONS.REFERRALS);
        
        // Check if referral already exists
        const existing = await referralsRef
            .where('referrerId', '==', referralData.referrerId)
            .where('referredId', '==', referralData.referredId)
            .get();
        
        if (!existing.empty) {
            return { exists: true };
        }
        
        const docRef = await referralsRef.add({
            ...referralData,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { id: docRef.id, ...referralData };
    }

    async countReferrals(userId) {
        const referralsRef = this.collection(COLLECTIONS.REFERRALS);
        const snapshot = await referralsRef
            .where('referrerId', '==', parseInt(userId))
            .get();
        return snapshot.size;
    }

    async saveLead(leadData) {
        const leadsRef = this.collection(COLLECTIONS.LEADS);
        const docRef = await leadsRef.doc(leadData.userId.toString()).set({
            ...leadData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { id: leadData.userId, ...leadData };
    }

    async addLeadEvent(eventData) {
        const eventsRef = this.collection(COLLECTIONS.LEAD_EVENTS);
        const docRef = await eventsRef.add({
            ...eventData,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return { id: docRef.id, ...eventData };
    }

    async upsertAudience(audienceData) {
        const audienceRef = this.collection(COLLECTIONS.AUDIENCE);
        const docRef = await audienceRef.doc(audienceData.userId.toString()).set({
            ...audienceData,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        return { id: audienceData.userId, ...audienceData };
    }

    // Wheel configuration
    async getWheelItems() {
        const wheelRef = this.collection(COLLECTIONS.WHEEL_ITEMS);
        const snapshot = await wheelRef.orderBy('position').get();
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    async updateWheelItems(items) {
        const wheelRef = this.collection(COLLECTIONS.WHEEL_ITEMS);
        const batch = this.db.batch();
        
        // Delete existing items
        const snapshot = await wheelRef.get();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        
        // Add new items
        items.forEach((item, index) => {
            const newRef = wheelRef.doc();
            batch.set(newRef, {
                ...item,
                position: index,
                weight: parseInt(item.weight) || 0
            });
        });
        
        await batch.commit();
        return items;
    }

    // Pending fallbacks
    async addPendingFallback(fallbackData) {
        const fallbacksRef = this.collection(COLLECTIONS.PENDING_FALLBACKS);
        const docRef = await fallbacksRef.doc(fallbackData.spinId.toString()).set({
            ...fallbackData,
            state: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            dueAt: new Date(Date.now() + (fallbackData.delay || 120) * 1000)
        }, { merge: true });
        return { id: fallbackData.spinId, ...fallbackData };
    }

    async getPendingFallbacks(limit = 200) {
        const fallbacksRef = this.collection(COLLECTIONS.PENDING_FALLBACKS);
        const now = new Date();
        
        const snapshot = await fallbacksRef
            .where('state', '==', 'pending')
            .where('dueAt', '<=', now)
            .orderBy('dueAt', 'asc')
            .limit(limit)
            .get();
        
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    async updateFallbackState(spinId, state) {
        const fallbacksRef = this.collection(COLLECTIONS.PENDING_FALLBACKS);
        await fallbacksRef.doc(spinId.toString()).update({
            state: state,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }

    // Broadcast system
    async createBroadcastJob(jobData) {
        const jobsRef = this.collection(COLLECTIONS.BROADCAST_JOBS);
        const docRef = await jobsRef.add({
            ...jobData,
            status: 'pending',
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        return docRef.id;
    }

    async addBroadcastItems(jobId, userIds) {
        const itemsRef = this.collection(COLLECTIONS.BROADCAST_ITEMS);
        const batch = this.db.batch();
        
        userIds.forEach(userId => {
            const itemRef = itemsRef.doc();
            batch.set(itemRef, {
                jobId: jobId,
                userId: userId,
                state: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
        });
        
        await batch.commit();
        return userIds.length;
    }

    // Analytics and statistics
    async getUserStats(userId) {
        const [spinsCount, referralsCount] = await Promise.all([
            this.countSpins(userId),
            this.countReferrals(userId)
        ]);
        
        return {
            totalSpins: spinsCount,
            totalReferrals: referralsCount
        };
    }

    async getRecentActivity(sinceDays = 0, limit = 1000) {
        const now = new Date();
        const sinceDate = new Date(now.setDate(now.getDate() - sinceDays));
        
        // Get activity from multiple collections
        const [spins, leads, referrals] = await Promise.all([
            this.collection(COLLECTIONS.SPINS)
                .where('createdAt', '>=', sinceDate)
                .orderBy('createdAt', 'desc')
                .limit(limit)
                .get(),
            this.collection(COLLECTIONS.LEADS)
                .where('updatedAt', '>=', sinceDate)
                .orderBy('updatedAt', 'desc')
                .limit(limit)
                .get(),
            this.collection(COLLECTIONS.REFERRALS)
                .where('createdAt', '>=', sinceDate)
                .orderBy('createdAt', 'desc')
                .limit(limit)
                .get()
        ]);
        
        return {
            spins: spins.docs.map(d => ({ id: d.id, ...d.data() })),
            leads: leads.docs.map(d => ({ id: d.id, ...d.data() })),
            referrals: referrals.docs.map(d => ({ id: d.id, ...d.data() }))
        };
    }
}

module.exports = {
    FirebaseService,
    COLLECTIONS,
    initializeFirebase
};
