const admin = require('firebase-admin');

/**
 * Middleware для проверки аутентификации
 */
async function authenticate(req, res, next) {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Требуется аутентификация' });
    }
    
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Ошибка аутентификации:', error);
    res.status(401).json({ error: 'Недействительный токен' });
  }
}

/**
 * Middleware для проверки прав администратора
 */
async function requireAdmin(req, res, next) {
  try {
    const { adminId } = req.body;
    
    if (!adminId) {
      return res.status(400).json({ error: 'Не указан adminId' });
    }
    
    const userDoc = await admin.firestore().collection('users').doc(adminId).get();
    
    if (!userDoc.exists || !userDoc.data().isAdmin) {
      return res.status(403).json({ error: 'Требуются права администратора' });
    }
    
    next();
  } catch (error) {
    console.error('Ошибка проверки прав:', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
}

module.exports = { authenticate, requireAdmin };
