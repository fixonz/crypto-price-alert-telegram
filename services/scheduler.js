const cron = require('node-cron');
const { getUserPreferences } = require('../utils/storage');
const { sendUserUpdates } = require('./priceUpdates');

// Scheduled job to send updates
let scheduledJobs = {};

// Schedule updates for a user
function scheduleUserUpdates(bot, chatId, userPrefs) {
  // Cancel existing job if any
  if (scheduledJobs[chatId]) {
    scheduledJobs[chatId].destroy();
    delete scheduledJobs[chatId];
  }

  const hasStandardTokens = userPrefs.tokens && userPrefs.tokens.length > 0;
  const hasCustomTokens = userPrefs.customTokens && userPrefs.customTokens.length > 0;
  
  if (!userPrefs.subscribed || (!hasStandardTokens && !hasCustomTokens)) {
    return;
  }

  const intervalMinutes = userPrefs.interval || 1;
  const cronPattern = `*/${intervalMinutes} * * * *`;

  const job = cron.schedule(cronPattern, async () => {
    const userInfo = await getUserPreferences(chatId);
    const currentPrefs = { ...userInfo };
    delete currentPrefs.isNew;
    await sendUserUpdates(bot, chatId, currentPrefs);
  });

  const tokenList = [
    ...(userPrefs.tokens || []).map(t => require('../config/tokens').TOKENS[t]?.symbol || t),
    ...(userPrefs.customTokens || []).map(ct => ct.symbol || 'Unknown')
  ].join(', ');
  
  scheduledJobs[chatId] = job;
  console.log(`Scheduled updates for user ${chatId}: ${tokenList} every ${intervalMinutes} minute(s)`);
}

// Initialize all user schedules
async function initializeSchedules(bot) {
  const { loadUsers } = require('../utils/storage');
  const users = await loadUsers();
  for (const [chatId, prefs] of Object.entries(users)) {
    const hasStandardTokens = prefs.tokens && prefs.tokens.length > 0;
    const hasCustomTokens = prefs.customTokens && prefs.customTokens.length > 0;
    
    if (prefs.subscribed && (hasStandardTokens || hasCustomTokens)) {
      scheduleUserUpdates(bot, chatId, prefs);
    }
  }
}

// Get scheduled jobs (for cleanup)
function getScheduledJobs() {
  return scheduledJobs;
}

module.exports = {
  scheduleUserUpdates,
  initializeSchedules,
  getScheduledJobs
};

