const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const ConfigManager = require('./config');
const { FirebaseService } = require('./firebase');

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// File upload setup
const storage = multer.diskStorage({
    destination: (req, res, cb) => {
        const uploadDir = path.join(__dirname, 'static', 'uploads');
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Bot manager for multiple clients
class BotManager {
    constructor() {
        this.bots = new Map();
        this.firebaseServices = new Map();
    }

    getBot(clientId) {
        return this.bots.get(clientId);
    }

    getFirebaseService(clientId) {
        if (!this.firebaseServices.has(clientId)) {
            this.firebaseServices.set(clientId, new FirebaseService(clientId));
        }
        return this.firebaseServices.get(clientId);
    }

    async initializeBot(clientId) {
        const config = ConfigManager.getClientConfig(clientId);
        const validation = new ConfigManager(clientId).validate();
        
        if (!validation.valid) {
            throw new Error(`Invalid config for client ${clientId}: ${validation.errors.join(', ')}`);
        }

        const bot = new TelegramBot(config.botToken, { polling: false });
        this.bots.set(clientId, bot);
        
        console.log(`✅ Bot initialized for client: ${clientId}`);
        return bot;
    }

    async getOrInitializeBot(clientId) {
        let bot = this.getBot(clientId);
        if (!bot) {
            bot = await this.initializeBot(clientId);
        }
        return bot;
    }
}

const botManager = new BotManager();

// Utility functions
function weightedChoice(items, weights) {
    if (items.length !== weights.length) {
        throw new Error("Items and weights must have same length");
    }
    
    const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
    if (total <= 0) {
        return items[Math.floor(Math.random() * items.length)];
    }
    
    let random = Math.random() * total;
    let sum = 0;
    
    for (let i = 0; i < items.length; i++) {
        sum += Math.max(0, weights[i]);
        if (random <= sum) {
            return items[i];
        }
    }
    
    return items[items.length - 1];
}

async function userSubscribed(bot, channelId, userId) {
    try {
        const member = await bot.getChatMember(channelId, userId);
        return !['left', 'kicked'].includes(member.status);
    } catch (error) {
        console.error('Check subscribe error:', error);
        return false;
    }
}

function buildRefLink(botUsername, userId) {
    return `https://t.me/${botUsername}?startapp=uid_${userId}`;
}

// Client middleware
function getClientMiddleware() {
    return async (req, res, next) => {
        // Extract client ID from header, query param, or body
        const clientId = req.headers['x-client-id'] || 
                        req.query.client_id || 
                        req.body.client_id ||
                        process.env.DEFAULT_CLIENT_ID;
        
        if (!clientId) {
            return res.status(400).json({ 
                error: 'Client ID is required. Use x-client-id header or client_id parameter' 
            });
        }
        
        try {
            // Get or initialize bot for this client
            const bot = await botManager.getOrInitializeBot(clientId);
            const firebaseService = botManager.getFirebaseService(clientId);
            const config = ConfigManager.getClientConfig(clientId);
            
            // Attach to request
            req.clientId = clientId;
            req.bot = bot;
            req.firebase = firebaseService;
            req.config = config;
            
            next();
        } catch (error) {
            console.error(`Error initializing client ${clientId}:`, error);
            res.status(400).json({ error: `Invalid client configuration: ${error.message}` });
        }
    };
}

// Admin middleware
function requireAdmin() {
    return (req, res, next) => {
        const adminId = parseInt(req.body.admin_id || req.query.admin_id || 0);
        const config = req.config;
        
        if (!config.adminUserIds.includes(adminId)) {
            return res.status(403).json({ error: 'Forbidden: Admin access required' });
        }
        
        req.adminId = adminId;
        next();
    };
}

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'static', 'admin.html'));
});

// API Routes with client middleware
app.post('/api/check-subscribe', getClientMiddleware(), async (req, res) => {
    try {
        const { user_id: userId } = req.body;
        const { bot, config } = req;
        
        const subscribed = await userSubscribed(bot, config.subscriptionChannelId, userId);
        res.json({ subscribed });
    } catch (error) {
        console.error('Check subscribe error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/status', getClientMiddleware(), async (req, res) => {
    try {
        const { user_id: userId } = req.body;
        const { firebase, config } = req;
        
        const stats = await firebase.getUserStats(userId);
        
        // Calculate attempts based on your logic
        const baseAttempts = config.baseAttemptsPerDay;
        const attemptsGranted = baseAttempts + (config.referralBonus * stats.totalReferrals);
        const attemptsLeft = Math.max(0, attemptsGranted - stats.totalSpins);
        
        res.json({
            attempts_left: attemptsLeft,
            bonus: stats.totalReferrals,
            spins_today: stats.totalSpins,
            ref_link: buildRefLink(config.botUsername, userId)
        });
    } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/spin', getClientMiddleware(), async (req, res) => {
    try {
        const { user_id: userId, username, referrer_id: referrerId } = req.body;
        const { bot, firebase, config } = req;
        
        // Update audience
        if (username) {
            await firebase.upsertAudience({
                userId: parseInt(userId),
                username: username.replace('@', ''),
                addedAt: new Date()
            });
        }
        
        // Check attempts
        const stats = await firebase.getUserStats(userId);
        const baseAttempts = config.baseAttemptsPerDay;
        const attemptsGranted = baseAttempts + (config.referralBonus * stats.totalReferrals);
        
        if (stats.totalSpins >= attemptsGranted) {
            return res.status(400).json({ error: 'Попыток больше нет.' });
        }
        
        // Get wheel configuration
        let wheelItems = await firebase.getWheelItems();
        let items = [], weights = [];
        
        if (wheelItems.length > 0) {
            items = wheelItems.map(item => item.label);
            weights = wheelItems.map(item => item.weight);
        } else {
            items = config.defaultPrizes;
            weights = new Array(items.length).fill(10);
        }
        
        // Select prize
        const prize = weightedChoice(items, weights);
        
        // Save spin
        const spin = await firebase.addSpin({
            userId: parseInt(userId),
            prize: prize,
            createdAt: new Date()
        });
        
        // Handle referral
        if (referrerId && parseInt(referrerId) !== parseInt(userId)) {
            await firebase.addReferral({
                referrerId: parseInt(referrerId),
                referredId: parseInt(userId),
                createdAt: new Date()
            });
        }
        
        // Queue fallback
        await firebase.addPendingFallback({
            spinId: spin.id,
            userId: parseInt(userId),
            prize: prize,
            username: (username || '').replace('@', ''),
            delay: config.fallbackTtlSeconds
        });
        
        res.json({
            prize: prize,
            spin_id: spin.id,
            attempts_left: Math.max(0, attemptsGranted - (stats.totalSpins + 1))
        });
    } catch (error) {
        console.error('Spin error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/submit-lead', getClientMiddleware(), async (req, res) => {
    try {
        const { user_id: userId, spin_id: spinId, name, phone, username } = req.body;
        const { bot, firebase, config } = req;
        
        // Update audience
        if (username) {
            await firebase.upsertAudience({
                userId: parseInt(userId),
                username: username.replace('@', ''),
                addedAt: new Date()
            });
        }
        
        // Get prize
        const spins = await firebase.getSpins(userId);
        const spin = spins.find(s => s.id === spinId);
        const prize = spin ? spin.prize : '—';
        
        // Save lead
        await firebase.saveLead({
            userId: parseInt(userId),
            username: (username || '').replace('@', ''),
            name: name || '',
            phone: phone || '',
            updatedAt: new Date()
        });
        
        // Add lead event
        await firebase.addLeadEvent({
            spinId: spinId,
            userId: parseInt(userId),
            type: 'full',
            createdAt: new Date()
        });
        
        // Update fallback state
        await firebase.updateFallbackState(spinId, 'full');
        
        // Send notification
        const escapedUsername = (username || '').replace('@', '');
        const text = `<b>📥 Лид (полный)</b>\n` +
                     `SpinID: <code>${spinId}</code>\n` +
                     `UserID: <code>${userId}</code>\n` +
                     `Username: @${escapedUsername || '—'}\n` +
                     `Имя: ${name || '—'}\n` +
                     `Телефон: ${phone || '—'}\n` +
                     `Результат: ${prize}`;
        
        await bot.sendMessage(config.leadsTargetId, text, { parse_mode: 'HTML' });
        
        res.json({ ok: true });
    } catch (error) {
        console.error('Submit lead error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Admin routes
app.post('/api/admin/wheel-config', getClientMiddleware(), requireAdmin(), async (req, res) => {
    try {
        const { items } = req.body;
        const { firebase } = req;
        
        if (!Array.isArray(items)) {
            return res.status(400).json({ error: 'Items must be an array' });
        }
        
        const updatedItems = await firebase.updateWheelItems(items);
        res.json({ ok: true, count: updatedItems.length });
    } catch (error) {
        console.error('Save wheel config error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/api/wheel-config', getClientMiddleware(), async (req, res) => {
    try {
        const { firebase, config } = req;
        
        const wheelItems = await firebase.getWheelItems();
        if (wheelItems.length > 0) {
            res.json({ items: wheelItems });
        } else {
            const items = config.defaultPrizes.map((label, index) => ({
                label,
                weight: 10,
                win_text: config.defaultPrizeWinTexts[index] || ''
            }));
            res.json({ items });
        }
    } catch (error) {
        console.error('Get wheel config error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.post('/api/admin/upload', getClientMiddleware(), requireAdmin(), upload.single('photo'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        res.json({
            ok: true,
            name: req.file.filename,
            url: `/uploads/${req.file.filename}`
        });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Serve static files
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use('/uploads', express.static(path.join(__dirname, 'static', 'uploads')));

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

// Background task processor
async function processBackgroundTasks() {
    console.log('Starting background task processor...');
    
    setInterval(async () => {
        // Process pending fallbacks for all clients
        // This would require iterating through all configured clients
        // For simplicity, we're processing only active clients
        console.log('Processing background tasks...');
    }, 60000); // Every minute
}

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📱 Multi-client Telegram Wheel Bot Backend`);
    console.log(`🔧 Default client ID: ${process.env.DEFAULT_CLIENT_ID}`);
    
    // Start background tasks
    processBackgroundTasks();
});
