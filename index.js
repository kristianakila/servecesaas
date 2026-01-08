const express = require('express');
const admin = require('firebase-admin');
const TelegramBot = require('node-telegram-bot-api');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// ===== НАСТРОЙКА FIREBASE =====
const serviceAccount = require('./firebase-config.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL
});

const db = admin.firestore();

// ===== MIDDLEWARE =====
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Ограничение запросов
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100 // лимит запросов
});
app.use('/api/', apiLimiter);

// ===== КЭШ БОТОВ =====
const botInstances = new Map();

/**
 * Получает или создает экземпляр бота по токену
 */
async function getBotInstance(botId) {
  try {
    // Проверяем кэш
    if (botInstances.has(botId)) {
      return botInstances.get(botId);
    }

    // Получаем токен из базы данных
    const botDoc = await db.collection('bots').doc(botId).get();
    if (!botDoc.exists) {
      throw new Error('Бот не найден');
    }

    const botData = botDoc.data();
    const token = botData.botToken;

    if (!token) {
      throw new Error('Токен бота не найден');
    }

    // Создаем экземпляр бота
    const bot = new TelegramBot(token, { polling: false });
    
    // Сохраняем в кэш
    botInstances.set(botId, bot);
    
    return bot;
  } catch (error) {
    console.error('Ошибка создания экземпляра бота:', error);
    throw error;
  }
}

/**
 * Очищает неиспользуемые экземпляры ботов
 */
function cleanupBotInstances() {
  // Здесь можно добавить логику очистки старых экземпляров
  // Пока оставляем простую реализацию
  console.log(`Активных ботов в кэше: ${botInstances.size}`);
}

// Запускаем периодическую очистку каждые 10 минут
setInterval(cleanupBotInstances, 10 * 60 * 1000);

// ===== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ =====
/**
 * Проверяет подписку пользователя на канал
 */
async function checkSubscription(botInstance, userId, channelId) {
  try {
    const member = await botInstance.getChatMember(channelId, userId);
    return member.status !== 'left' && member.status !== 'kicked';
  } catch (error) {
    console.error('Ошибка проверки подписки:', error);
    return false;
  }
}

/**
 * Генерирует реферальную ссылку
 */
function generateReferralLink(botUsername, userId) {
  return `https://t.me/${botUsername}?start=${userId}`;
}

/**
 * Получает конфигурацию колеса для бота
 */
async function getWheelConfig(botId) {
  try {
    const wheelItemsRef = db.collection('bots').doc(botId).collection('wheelItems');
    const snapshot = await wheelItemsRef.orderBy('position').get();
    
    if (snapshot.empty) {
      // Возвращаем дефолтные настройки
      return [
        { label: 'Приз 1', weight: 10, winText: 'Поздравляем!' },
        { label: 'Приз 2', weight: 10, winText: 'Удача на вашей стороне!' }
      ];
    }
    
    return snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));
  } catch (error) {
    console.error('Ошибка получения конфигурации колеса:', error);
    throw error;
  }
}

// ===== API РОУТЫ =====

// === ПРОВЕРКА ПОДКЛЮЧЕНИЯ ===
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    botsInCache: botInstances.size 
  });
});

// === РАБОТА С БОТАМИ ===

/**
 * Получает информацию о боте
 */
app.get('/api/bot/:botId/info', async (req, res) => {
  try {
    const { botId } = req.params;
    const botDoc = await db.collection('bots').doc(botId).get();
    
    if (!botDoc.exists) {
      return res.status(404).json({ error: 'Бот не найден' });
    }
    
    res.json(botDoc.data());
  } catch (error) {
    console.error('Ошибка получения информации о боте:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// === ПОЛЬЗОВАТЕЛИ ===

/**
 * Получает статус пользователя
 */
app.post('/api/bot/:botId/status', async (req, res) => {
  try {
    const { botId } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Не указан userId' });
    }

    const botInstance = await getBotInstance(botId);
    const botDoc = await db.collection('bots').doc(botId).get();
    const botData = botDoc.data();
    
    // Получаем статистику пользователя
    const userSpinsRef = db.collection('bots').doc(botId).collection('users').doc(userId);
    const userDoc = await userSpinsRef.get();
    
    let totalSpins = 0;
    let totalReferrals = 0;
    let lastSpin = null;
    
    if (userDoc.exists) {
      const userData = userDoc.data();
      totalSpins = userData.totalSpins || 0;
      totalReferrals = userData.referralsCount || 0;
      lastSpin = userData.lastSpin || null;
    }
    
    // Получаем рефералы
    const referralsSnapshot = await db.collection('bots').doc(botId)
      .collection('referrals')
      .where('referrerId', '==', parseInt(userId))
      .get();
    
    totalReferrals = referralsSnapshot.size;
    
    // Рассчитываем доступные попытки
    const baseAttempts = botData.baseAttempts || 2;
    const referralBonus = botData.referralBonus || 2;
    const attemptsGranted = baseAttempts + (referralBonus * totalReferrals);
    const attemptsLeft = Math.max(0, attemptsGranted - totalSpins);
    
    // Проверяем подписку
    const isSubscribed = await checkSubscription(
      botInstance, 
      userId, 
      botData.subscriptionChannel
    );
    
    // Генерируем реферальную ссылку
    const referralLink = generateReferralLink(botData.botUsername, userId);
    
    res.json({
      userId,
      attemptsLeft,
      totalSpins,
      totalReferrals,
      isSubscribed,
      referralLink,
      lastSpin,
      bonus: totalReferrals
    });
    
  } catch (error) {
    console.error('Ошибка получения статуса:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Крутим колесо
 */
app.post('/api/bot/:botId/spin', async (req, res) => {
  try {
    const { botId } = req.params;
    const { userId, username, referrerId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'Не указан userId' });
    }
    
    const botInstance = await getBotInstance(botId);
    const botDoc = await db.collection('bots').doc(botId).get();
    const botData = botDoc.data();
    
    // Проверяем подписку
    const isSubscribed = await checkSubscription(
      botInstance, 
      userId, 
      botData.subscriptionChannel
    );
    
    if (!isSubscribed && botData.requireSubscription) {
      return res.status(403).json({ error: 'Требуется подписка на канал' });
    }
    
    // Получаем статус пользователя для проверки попыток
    const userRef = db.collection('bots').doc(botId).collection('users').doc(userId.toString());
    const userDoc = await userRef.get();
    
    let totalSpins = 0;
    if (userDoc.exists) {
      totalSpins = userDoc.data().totalSpins || 0;
    }
    
    // Рассчитываем доступные попытки
    const baseAttempts = botData.baseAttempts || 2;
    const referralsSnapshot = await db.collection('bots').doc(botId)
      .collection('referrals')
      .where('referrerId', '==', parseInt(userId))
      .get();
    
    const referralBonus = botData.referralBonus || 2;
    const attemptsGranted = baseAttempts + (referralBonus * referralsSnapshot.size);
    
    if (totalSpins >= attemptsGranted) {
      return res.status(400).json({ error: 'Попытки закончились' });
    }
    
    // Получаем конфигурацию колеса
    const wheelItems = await getWheelConfig(botId);
    
    // Выбираем приз по весам
    const totalWeight = wheelItems.reduce((sum, item) => sum + (item.weight || 10), 0);
    let randomWeight = Math.random() * totalWeight;
    
    let selectedPrize = wheelItems[0];
    for (const item of wheelItems) {
      randomWeight -= (item.weight || 10);
      if (randomWeight <= 0) {
        selectedPrize = item;
        break;
      }
    }
    
    // Создаем запись о спине
    const spinId = Date.now().toString();
    const spinData = {
      userId: parseInt(userId),
      spinId,
      prize: selectedPrize.label,
      winText: selectedPrize.winText,
      timestamp: new Date().toISOString(),
      username: username || '',
      isLeadCollected: false
    };
    
    // Сохраняем спин
    const spinRef = db.collection('bots').doc(botId).collection('spins').doc(spinId);
    await spinRef.set(spinData);
    
    // Обновляем статистику пользователя
    await userRef.set({
      userId: parseInt(userId),
      totalSpins: totalSpins + 1,
      lastSpin: new Date().toISOString(),
      username: username || '',
      updatedAt: new Date().toISOString()
    }, { merge: true });
    
    // Обрабатываем реферала если есть
    if (referrerId && referrerId !== userId) {
      const referralRef = db.collection('bots').doc(botId)
        .collection('referrals')
        .doc(`${referrerId}_${userId}`);
      
      await referralRef.set({
        referrerId: parseInt(referrerId),
        referredId: parseInt(userId),
        timestamp: new Date().toISOString(),
        username: username || ''
      }, { merge: true });
    }
    
    // Запускаем отложенную отправку лида (фолбэк)
    scheduleFallbackLead(botId, spinId, userId, selectedPrize.label, username);
    
    res.json({
      success: true,
      spinId,
      prize: selectedPrize.label,
      winText: selectedPrize.winText,
      attemptsLeft: attemptsGranted - (totalSpins + 1)
    });
    
  } catch (error) {
    console.error('Ошибка вращения колеса:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Сохраняет лид (контактные данные)
 */
app.post('/api/bot/:botId/lead', async (req, res) => {
  try {
    const { botId } = req.params;
    const { userId, spinId, name, phone, username } = req.body;
    
    if (!userId || !spinId) {
      return res.status(400).json({ error: 'Не указаны обязательные поля' });
    }
    
    // Получаем информацию о спине
    const spinRef = db.collection('bots').doc(botId).collection('spins').doc(spinId);
    const spinDoc = await spinRef.get();
    
    if (!spinDoc.exists || spinDoc.data().userId !== parseInt(userId)) {
      return res.status(404).json({ error: 'Спин не найден' });
    }
    
    const spinData = spinDoc.data();
    
    // Создаем или обновляем лид
    const leadRef = db.collection('bots').doc(botId).collection('leads').doc(userId.toString());
    await leadRef.set({
      userId: parseInt(userId),
      spinId,
      name: name || '',
      phone: phone || '',
      username: username || '',
      prize: spinData.prize,
      timestamp: new Date().toISOString(),
      isProcessed: false
    }, { merge: true });
    
    // Отмечаем спин как обработанный
    await spinRef.update({ isLeadCollected: true });
    
    // Отправляем уведомление в телеграм (если настроен канал для лидов)
    try {
      const botDoc = await db.collection('bots').doc(botId).get();
      const botData = botDoc.data();
      
      if (botData.leadsChannel) {
        const botInstance = await getBotInstance(botId);
        const leadMessage = `
📥 <b>Новый лид</b>
Bot: ${botData.name}
UserID: ${userId}
Username: @${username || '—'}
Имя: ${name || '—'}
Телефон: ${phone || '—'}
Приз: ${spinData.prize}
SpinID: ${spinId}
        `.trim();
        
        await botInstance.sendMessage(botData.leadsChannel, leadMessage, { parse_mode: 'HTML' });
      }
    } catch (telegramError) {
      console.error('Ошибка отправки уведомления:', telegramError);
      // Не прерываем выполнение из-за ошибки телеграма
    }
    
    res.json({ success: true });
    
  } catch (error) {
    console.error('Ошибка сохранения лида:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// === АДМИН АПИ ===

/**
 * Получает статистику бота
 */
app.get('/api/admin/bot/:botId/stats', async (req, res) => {
  try {
    const { botId } = req.params;
    const { adminId } = req.query;
    
    // Проверяем права администратора
    const adminDoc = await db.collection('users').doc(adminId).get();
    if (!adminDoc.exists || !adminDoc.data().isAdmin) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
    
    // Получаем общую статистику
    const [
      usersSnapshot,
      spinsSnapshot,
      leadsSnapshot,
      referralsSnapshot
    ] = await Promise.all([
      db.collection('bots').doc(botId).collection('users').get(),
      db.collection('bots').doc(botId).collection('spins').get(),
      db.collection('bots').doc(botId).collection('leads').get(),
      db.collection('bots').doc(botId).collection('referrals').get()
    ]);
    
    // Статистика за последние 7 дней
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    
    const recentSpinsSnapshot = await db.collection('bots').doc(botId)
      .collection('spins')
      .where('timestamp', '>=', weekAgo.toISOString())
      .get();
    
    const recentLeadsSnapshot = await db.collection('bots').doc(botId)
      .collection('leads')
      .where('timestamp', '>=', weekAgo.toISOString())
      .get();
    
    res.json({
      totalUsers: usersSnapshot.size,
      totalSpins: spinsSnapshot.size,
      totalLeads: leadsSnapshot.size,
      totalReferrals: referralsSnapshot.size,
      spinsLast7Days: recentSpinsSnapshot.size,
      leadsLast7Days: recentLeadsSnapshot.size,
      botId
    });
    
  } catch (error) {
    console.error('Ошибка получения статистики:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Получает список пользователей бота
 */
app.get('/api/admin/bot/:botId/users', async (req, res) => {
  try {
    const { botId } = req.params;
    const { adminId, limit = 50, offset = 0 } = req.query;
    
    // Проверяем права администратора
    const adminDoc = await db.collection('users').doc(adminId).get();
    if (!adminDoc.exists || !adminDoc.data().isAdmin) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
    
    const usersSnapshot = await db.collection('bots').doc(botId)
      .collection('users')
      .orderBy('lastSpin', 'desc')
      .limit(parseInt(limit))
      .offset(parseInt(offset))
      .get();
    
    const users = [];
    for (const doc of usersSnapshot.docs) {
      const userData = doc.data();
      
      // Получаем дополнительную информацию
      const userSpins = await db.collection('bots').doc(botId)
        .collection('spins')
        .where('userId', '==', userData.userId)
        .get();
      
      const userLeads = await db.collection('bots').doc(botId)
        .collection('leads')
        .where('userId', '==', userData.userId)
        .get();
      
      const userReferrals = await db.collection('bots').doc(botId)
        .collection('referrals')
        .where('referrerId', '==', userData.userId)
        .get();
      
      users.push({
        userId: userData.userId,
        username: userData.username || '',
        totalSpins: userSpins.size,
        totalLeads: userLeads.size,
        totalReferrals: userReferrals.size,
        lastActivity: userData.lastSpin || userData.updatedAt,
        isSubscribed: true // Можно добавить проверку подписки
      });
    }
    
    res.json({ users });
    
  } catch (error) {
    console.error('Ошибка получения пользователей:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Обновляет настройки колеса
 */
app.post('/api/admin/bot/:botId/wheel-config', async (req, res) => {
  try {
    const { botId } = req.params;
    const { adminId, items } = req.body;
    
    if (!items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Неверный формат данных' });
    }
    
    // Проверяем права администратора
    const adminDoc = await db.collection('users').doc(adminId).get();
    if (!adminDoc.exists || !adminDoc.data().isAdmin) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
    
    // Очищаем старые настройки
    const wheelItemsRef = db.collection('bots').doc(botId).collection('wheelItems');
    const snapshot = await wheelItemsRef.get();
    
    const batch = db.batch();
    snapshot.docs.forEach(doc => {
      batch.delete(doc.ref);
    });
    await batch.commit();
    
    // Добавляем новые настройки
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      await wheelItemsRef.add({
        position: i,
        label: item.label,
        weight: item.weight || 10,
        winText: item.winText || '',
        isActive: true
      });
    }
    
    res.json({ success: true, count: items.length });
    
  } catch (error) {
    console.error('Ошибка обновления конфигурации колеса:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Отправляет рассылку
 */
app.post('/api/admin/bot/:botId/broadcast', async (req, res) => {
  try {
    const { botId } = req.params;
    const { adminId, message, userIds, attachRefLink } = req.body;
    
    if (!message) {
      return res.status(400).json({ error: 'Не указано сообщение' });
    }
    
    // Проверяем права администратора
    const adminDoc = await db.collection('users').doc(adminId).get();
    if (!adminDoc.exists || !adminDoc.data().isAdmin) {
      return res.status(403).json({ error: 'Доступ запрещен' });
    }
    
    const botInstance = await getBotInstance(botId);
    const botDoc = await db.collection('bots').doc(botId).get();
    const botData = botDoc.data();
    
    let usersToSend = [];
    
    if (userIds && Array.isArray(userIds) && userIds.length > 0) {
      // Отправляем выбранным пользователям
      usersToSend = userIds;
    } else {
      // Отправляем всем пользователям бота
      const usersSnapshot = await db.collection('bots').doc(botId)
        .collection('users')
        .get();
      
      usersToSend = usersSnapshot.docs.map(doc => doc.data().userId);
    }
    
    const results = {
      sent: 0,
      failed: 0,
      errors: []
    };
    
    // Отправляем сообщения с задержкой
    for (const userId of usersToSend) {
      try {
        let finalMessage = message;
        
        if (attachRefLink) {
          const referralLink = generateReferralLink(botData.botUsername, userId);
          finalMessage += `\n\n🔗 Ваша реферальная ссылка: ${referralLink}`;
        }
        
        await botInstance.sendMessage(userId, finalMessage, { parse_mode: 'HTML' });
        results.sent++;
        
        // Задержка чтобы не превысить лимиты Telegram
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (error) {
        results.failed++;
        results.errors.push({
          userId,
          error: error.message
        });
      }
    }
    
    // Логируем рассылку
    await db.collection('bots').doc(botId).collection('broadcasts').add({
      adminId,
      message,
      totalRecipients: usersToSend.length,
      sent: results.sent,
      failed: results.failed,
      timestamp: new Date().toISOString()
    });
    
    res.json(results);
    
  } catch (error) {
    console.error('Ошибка рассылки:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// === ФОЛБЭК СИСТЕМА ===

/**
 * Планирует отложенную отправку лида (фолбэк)
 */
async function scheduleFallbackLead(botId, spinId, userId, prize, username) {
  try {
    const fallbackRef = db.collection('bots').doc(botId).collection('fallbacks').doc(spinId);
    
    await fallbackRef.set({
      spinId,
      userId,
      prize,
      username: username || '',
      scheduledAt: new Date().toISOString(),
      dueAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 минуты
      status: 'pending',
      sent: false
    });
    
    // Запускаем таймер для проверки фолбэков
    setTimeout(() => checkFallback(botId, spinId), 2 * 60 * 1000);
    
  } catch (error) {
    console.error('Ошибка планирования фолбэка:', error);
  }
}

/**
 * Проверяет и отправляет фолбэк лид
 */
async function checkFallback(botId, spinId) {
  try {
    const fallbackRef = db.collection('bots').doc(botId).collection('fallbacks').doc(spinId);
    const fallbackDoc = await fallbackRef.get();
    
    if (!fallbackDoc.exists) return;
    
    const fallbackData = fallbackDoc.data();
    
    // Проверяем, был ли собран полный лид
    const leadRef = db.collection('bots').doc(botId).collection('leads')
      .where('spinId', '==', spinId)
      .limit(1);
    
    const leadSnapshot = await leadRef.get();
    
    if (leadSnapshot.empty && !fallbackData.sent) {
      // Полный лид не собран, отправляем фолбэк
      const botDoc = await db.collection('bots').doc(botId).get();
      const botData = botDoc.data();
      
      if (botData.leadsChannel) {
        const botInstance = await getBotInstance(botId);
        const fallbackMessage = `
📥 <b>Лид (фолбэк)</b>
Bot: ${botData.name}
UserID: ${fallbackData.userId}
Username: @${fallbackData.username || '—'}
Имя: Не указано
Телефон: Не указан
Приз: ${fallbackData.prize}
SpinID: ${spinId}
        `.trim();
        
        await botInstance.sendMessage(botData.leadsChannel, fallbackMessage, { parse_mode: 'HTML' });
        
        // Отмечаем как отправленный
        await fallbackRef.update({ 
          sent: true, 
          sentAt: new Date().toISOString(),
          status: 'sent'
        });
      }
    } else if (leadSnapshot.docs.length > 0) {
      // Полный лид собран, удаляем фолбэк
      await fallbackRef.delete();
    }
    
  } catch (error) {
    console.error('Ошибка проверки фолбэка:', error);
  }
}

/**
 * Фоновая задача для обработки просроченных фолбэков
 */
async function processExpiredFallbacks() {
  try {
    const botsSnapshot = await db.collection('bots').get();
    
    for (const botDoc of botsSnapshot.docs) {
      const botId = botDoc.id;
      
      const expiredFallbacks = await db.collection('bots').doc(botId)
        .collection('fallbacks')
        .where('status', '==', 'pending')
        .where('dueAt', '<=', new Date().toISOString())
        .limit(10)
        .get();
      
      for (const fallbackDoc of expiredFallbacks.docs) {
        const fallbackData = fallbackDoc.data();
        await checkFallback(botId, fallbackData.spinId);
      }
    }
  } catch (error) {
    console.error('Ошибка обработки просроченных фолбэков:', error);
  }
}

// Запускаем обработку фолбэков каждую минуту
setInterval(processExpiredFallbacks, 60 * 1000);

// === WEBHOOK ДЛЯ TELEGRAM ===

/**
 * Устанавливает webhook для бота
 */
app.post('/api/bot/:botId/webhook', async (req, res) => {
  try {
    const { botId } = req.params;
    const { url } = req.body;
    
    const botInstance = await getBotInstance(botId);
    await botInstance.setWebHook(url);
    
    res.json({ success: true });
  } catch (error) {
    console.error('Ошибка установки webhook:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Получает обновления от Telegram
 */
app.post('/webhook/:botToken', async (req, res) => {
  try {
    const { botToken } = req.params;
    const update = req.body;
    
    // Находим бота по токену (в реальном проекте нужно кэшировать)
    const botsSnapshot = await db.collection('bots')
      .where('botToken', '==', botToken)
      .limit(1)
      .get();
    
    if (botsSnapshot.empty) {
      return res.status(404).json({ error: 'Бот не найден' });
    }
    
    const botData = botsSnapshot.docs[0].data();
    const botId = botsSnapshot.docs[0].id;
    
    // Обрабатываем обновление
    await handleTelegramUpdate(botId, update);
    
    res.json({ ok: true });
  } catch (error) {
    console.error('Ошибка обработки webhook:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

/**
 * Обрабатывает обновления от Telegram
 */
async function handleTelegramUpdate(botId, update) {
  try {
    const botInstance = await getBotInstance(botId);
    
    if (update.message) {
      const { chat, text, from } = update.message;
      
      // Обработка команды /start
      if (text && text.startsWith('/start')) {
        const referrerId = text.split(' ')[1];
        const welcomeMessage = `
🎉 Добро пожаловать!
      
Крутите колесо фортуны и выигрывайте призы!

Для начала проверьте подписку на канал и нажмите /spin
        `.trim();
        
        await botInstance.sendMessage(chat.id, welcomeMessage);
        
        // Сохраняем пользователя в базу
        const userRef = db.collection('bots').doc(botId).collection('users').doc(from.id.toString());
        await userRef.set({
          userId: from.id,
          username: from.username || '',
          firstName: from.first_name || '',
          lastName: from.last_name || '',
          joinedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }, { merge: true });
        
        // Обрабатываем реферала если есть
        if (referrerId && referrerId !== from.id.toString()) {
          const referralRef = db.collection('bots').doc(botId)
            .collection('referrals')
            .doc(`${referrerId}_${from.id}`);
          
          await referralRef.set({
            referrerId: parseInt(referrerId),
            referredId: from.id,
            timestamp: new Date().toISOString(),
            username: from.username || ''
          }, { merge: true });
        }
      }
      
      // Обработка команды /spin
      else if (text === '/spin') {
        const botDoc = await db.collection('bots').doc(botId).get();
        const botData = botDoc.data();
        
        // Проверяем подписку
        const isSubscribed = await checkSubscription(
          botInstance, 
          from.id, 
          botData.subscriptionChannel
        );
        
        if (!isSubscribed && botData.requireSubscription) {
          await botInstance.sendMessage(chat.id, 
            `📢 Пожалуйста, подпишитесь на наш канал: ${botData.subscriptionChannel}`
          );
          return;
        }
        
        // Отправляем ссылку на веб-приложение
        const webAppUrl = `${process.env.WEB_APP_URL}/wheel?bot=${botId}&user=${from.id}`;
        const keyboard = {
          inline_keyboard: [[{
            text: '🎡 Крутить колесо',
            web_app: { url: webAppUrl }
          }]]
        };
        
        await botInstance.sendMessage(chat.id, 
          '🎡 Нажмите кнопку ниже, чтобы открыть колесо фортуны:',
          { reply_markup: keyboard }
        );
      }
    }
    
  } catch (error) {
    console.error('Ошибка обработки обновления Telegram:', error);
  }
}

// ===== ЗАПУСК СЕРВЕРА =====
app.listen(PORT, () => {
  console.log(`🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📊 Подключено к Firebase`);
  console.log(`🤖 Готов к работе с множеством ботов`);
});

// Обработка ошибок
process.on('uncaughtException', (error) => {
  console.error('Необработанное исключение:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Необработанный промис:', promise, 'причина:', reason);
});
