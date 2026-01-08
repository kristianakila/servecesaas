const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK
let firebaseInitialized = false;

function initializeFirebase() {
    if (firebaseInitialized) {
        return admin.firestore();
    }

    try {
        // Check if already initialized
        if (admin.apps.length > 0) {
            firebaseInitialized = true;
            return admin.firestore();
        }

        // Get service account from environment variable or file
        let serviceAccount;
        
        if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
            // Parse from environment variable
            try {
                serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY);
            } catch (parseError) {
                console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT_KEY from env:', parseError.message);
                throw new Error('Invalid FIREBASE_SERVICE_ACCOUNT_KEY JSON');
            }
        } else {
            // Try to load from file
            try {
                const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
                if (require('fs').existsSync(serviceAccountPath)) {
                    serviceAccount = require(serviceAccountPath);
                } else {
                    throw new Error('serviceAccountKey.json not found and FIREBASE_SERVICE_ACCOUNT_KEY env var not set');
                }
            } catch (fileError) {
                console.error('Failed to load Firebase service account:', fileError.message);
                throw fileError;
            }
        }

        // Initialize Firebase
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            databaseURL: process.env.FIREBASE_DATABASE_URL || `https://${serviceAccount.project_id}.firebaseio.com`
        });

        console.log('✅ Firebase initialized successfully');
        firebaseInitialized = true;
        return admin.firestore();
    } catch (error) {
        console.error('❌ Failed to initialize Firebase:', error.message);
        // Don't crash the app, allow it to start but log errors
        firebaseInitialized = false;
        return null;
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
        this.initialized = this.db !== null;
    }

    // Check if Firebase is ready
    isReady() {
        return this.initialized;
    }

    // Helper to get client-specific collection reference
    collection(collectionName) {
        if (!this.isReady()) {
            throw new Error('Firebase not initialized');
        }
        return this.db
            .collection(COLLECTIONS.CLIENTS)
            .doc(this.clientId)
            .collection(collectionName);
    }

    // Client management
    async getClientData() {
        if (!this.isReady()) return null;
        
        try {
            const doc = await this.db
                .collection(COLLECTIONS.CLIENTS)
                .doc(this.clientId)
                .get();
            
            return doc.exists ? doc.data() : null;
        } catch (error) {
            console.error('Error getting client data:', error.message);
            return null;
        }
    }

    async updateClientData(data) {
        if (!this.isReady()) return null;
        
        try {
            return await this.db
                .collection(COLLECTIONS.CLIENTS)
                .doc(this.clientId)
                .set(data, { merge: true });
        } catch (error) {
            console.error('Error updating client data:', error.message);
            throw error;
        }
    }

    // CRUD operations with error handling
    async addSpin(spinData) {
        if (!this.isReady()) {
            // Return mock data if Firebase is not available
            return { id: 'mock-' + Date.now(), ...spinData };
        }
        
        try {
            const spinsRef = this.collection(COLLECTIONS.SPINS);
            const docRef = await spinsRef.add({
                ...spinData,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return { id: docRef.id, ...spinData };
        } catch (error) {
            console.error('Error adding spin:', error.message);
            throw error;
        }
    }

    async getSpins(userId, limit = 100) {
        if (!this.isReady()) return [];
        
        try {
            const spinsRef = this.collection(COLLECTIONS.SPINS);
            let query = spinsRef.where('userId', '==', parseInt(userId));
            query = query.orderBy('createdAt', 'desc').limit(limit);
            
            const snapshot = await query.get();
            return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (error) {
            console.error('Error getting spins:', error.message);
            return [];
        }
    }

    async countSpins(userId) {
        if (!this.isReady()) return 0;
        
        try {
            const spinsRef = this.collection(COLLECTIONS.SPINS);
            const snapshot = await spinsRef
                .where('userId', '==', parseInt(userId))
                .get();
            return snapshot.size;
        } catch (error) {
            console.error('Error counting spins:', error.message);
            return 0;
        }
    }

    // ... остальные методы с аналогичной обработкой ошибок ...

    async addReferral(referralData) {
        if (!this.isReady()) return { exists: false };
        
        try {
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
        } catch (error) {
            console.error('Error adding referral:', error.message);
            return { exists: false };
        }
    }

    async countReferrals(userId) {
        if (!this.isReady()) return 0;
        
        try {
            const referralsRef = this.collection(COLLECTIONS.REFERRALS);
            const snapshot = await referralsRef
                .where('referrerId', '==', parseInt(userId))
                .get();
            return snapshot.size;
        } catch (error) {
            console.error('Error counting referrals:', error.message);
            return 0;
        }
    }

    // Simplified error handling for other methods
    async saveLead(leadData) {
        if (!this.isReady()) return { id: leadData.userId, ...leadData };
        
        try {
            const leadsRef = this.collection(COLLECTIONS.LEADS);
            await leadsRef.doc(leadData.userId.toString()).set({
                ...leadData,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            return { id: leadData.userId, ...leadData };
        } catch (error) {
            console.error('Error saving lead:', error.message);
            return { id: leadData.userId, ...leadData };
        }
    }

    async addLeadEvent(eventData) {
        if (!this.isReady()) return { id: 'mock', ...eventData };
        
        try {
            const eventsRef = this.collection(COLLECTIONS.LEAD_EVENTS);
            const docRef = await eventsRef.add({
                ...eventData,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            });
            return { id: docRef.id, ...eventData };
        } catch (error) {
            console.error('Error adding lead event:', error.message);
            return { id: 'mock', ...eventData };
        }
    }

    async upsertAudience(audienceData) {
        if (!this.isReady()) return { id: audienceData.userId, ...audienceData };
        
        try {
            const audienceRef = this.collection(COLLECTIONS.AUDIENCE);
            await audienceRef.doc(audienceData.userId.toString()).set({
                ...audienceData,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            }, { merge: true });
            return { id: audienceData.userId, ...audienceData };
        } catch (error) {
            console.error('Error upserting audience:', error.message);
            return { id: audienceData.userId, ...audienceData };
        }
    }

    async getWheelItems() {
        if (!this.isReady()) return [];
        
        try {
            const wheelRef = this.collection(COLLECTIONS.WHEEL_ITEMS);
            const snapshot = await wheelRef.orderBy('position').get();
            return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        } catch (error) {
            console.error('Error getting wheel items:', error.message);
            return [];
        }
    }

    async updateWheelItems(items) {
        if (!this.isReady()) return items;
        
        try {
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
        } catch (error) {
            console.error('Error updating wheel items:', error.message);
            throw error;
        }
    }

    async addPendingFallback(fallbackData) {
        if (!this.isReady()) return { id: fallbackData.spinId, ...fallbackData };
        
        try {
            const fallbacksRef = this.collection(COLLECTIONS.PENDING_FALLBACKS);
            await fallbacksRef.doc(fallbackData.spinId.toString()).set({
                ...fallbackData,
                state: 'pending',
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                dueAt: new Date(Date.now() + (fallbackData.delay || 120) * 1000)
            }, { merge: true });
            return { id: fallbackData.spinId, ...fallbackData };
        } catch (error) {
            console.error('Error adding pending fallback:', error.message);
            return { id: fallbackData.spinId, ...fallbackData };
        }
    }

    async updateFallbackState(spinId, state) {
        if (!this.isReady()) return;
        
        try {
            const fallbacksRef = this.collection(COLLECTIONS.PENDING_FALLBACKS);
            await fallbacksRef.doc(spinId.toString()).update({
                state: state,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
        } catch (error) {
            console.error('Error updating fallback state:', error.message);
        }
    }

    async getUserStats(userId) {
        if (!this.isReady()) return { totalSpins: 0, totalReferrals: 0 };
        
        try {
            const [spinsCount, referralsCount] = await Promise.all([
                this.countSpins(userId),
                this.countReferrals(userId)
            ]);
            
            return {
                totalSpins: spinsCount,
                totalReferrals: referralsCount
            };
        } catch (error) {
            console.error('Error getting user stats:', error.message);
            return { totalSpins: 0, totalReferrals: 0 };
        }
    }
}

module.exports = {
    FirebaseService,
    COLLECTIONS,
    initializeFirebase
};
