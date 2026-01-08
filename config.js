// Configuration manager for multi-client support
require('dotenv').config();

class ConfigManager {
    constructor(clientId = null) {
        this.clientId = clientId || process.env.DEFAULT_CLIENT_ID;
    }

    getConfig() {
        // In production, this would fetch from Firebase or database
        // For now, we use environment variables with client prefixes
        const prefix = this.clientId ? `${this.clientId.toUpperCase()}_` : '';
        
        return {
            // Bot configuration
            botToken: process.env[`${prefix}BOT_TOKEN`],
            botUsername: process.env[`${prefix}BOT_USERNAME`]?.replace('@', ''),
            
            // Channel/group IDs
            subscriptionChannelId: process.env[`${prefix}SUBSCRIPTION_CHANNEL_ID`],
            leadsTargetId: process.env[`${prefix}LEADS_TARGET_ID`],
            
            // Admin configuration
            adminUserIds: (process.env[`${prefix}ADMIN_USER_IDS`] || '')
                .split(',')
                .filter(id => id.trim())
                .map(id => parseInt(id.trim())),
            
            // Game settings
            baseAttemptsPerDay: parseInt(process.env[`${prefix}BASE_ATTEMPTS_PER_DAY`] || '2'),
            referralBonus: parseInt(process.env[`${prefix}REFERRAL_BONUS`] || '2'),
            
            // Timing settings
            sweepIntervalSeconds: parseInt(process.env[`${prefix}SWEEP_INTERVAL_SECONDS`] || '60'),
            fallbackTtlSeconds: parseInt(process.env[`${prefix}FALLBACK_TTL_SECONDS`] || '120'),
            
            // Default prizes (fallback)
            defaultPrizes: [
                '100.000р на косметологию',
                'Годовой абонемент на лазер',
                '-50% на лазерную эпиляцию',
                'Пилинг BioRePeel + маска',
                'Сеанс вибромассажа',
                'Бикини + подмышки + малая зона за 1890',
                '50% сидка на ручной массаж',
                'Комбинированная чистка + маска в подарок',
                'Подмышки в подарок',
                'Сертификат на 1500р'
            ],
            defaultPrizeWinTexts: [
                'Вам очень повезло! Вы счастливчик!',
                'Вам очень повезло! Вы счастливчик!',
                'Поздравляем! Вы выиграли 50% на лазерную эпиляцию! Скоро с Вами свяжемся!',
                'Поздравляем, пилинг + маска в подарок! Скоро свяжемся с Вами!',
                'Ура! Процедура вибромассажа Ваша. Скоро с Вами свяжутся для записи',
                'Поздравляем! Глубокое бикини + подмышки + малая зона за 1890р. Вы счастливый обладатель комплекса! Мы скоро с Вами свяжемся.',
                'Вау! Скидка -50% на ручной массаж, теперь Ваша. Скоро с Вами свяжемся!',
                'Поздравляем! Вы выиграли! Скоро с тобой свяжемся!',
                'Ура! Вы выиграли процедуру азерная эпиляция подмышечных впаден. С Вами свяжемся в ближайшее время!',
                'Вы счастливчик! Получаете подарочный сертификат! Скоро с Вами свяжемся.'
            ]
        };
    }

    // Helper to get client-specific config
    static getClientConfig(clientId) {
        return new ConfigManager(clientId).getConfig();
    }

    // Validate config for a client
    validate() {
        const config = this.getConfig();
        const errors = [];
        
        if (!config.botToken) errors.push('BOT_TOKEN is required');
        if (!config.subscriptionChannelId) errors.push('SUBSCRIPTION_CHANNEL_ID is required');
        if (!config.leadsTargetId) errors.push('LEADS_TARGET_ID is required');
        if (!config.botUsername) errors.push('BOT_USERNAME is required');
        
        return {
            valid: errors.length === 0,
            errors
        };
    }
}

module.exports = ConfigManager;
