const { TOKENS, VALID_INTERVALS } = require('../config/tokens');
const { getUserPreferences, updateUserPreferences } = require('../utils/storage');
const { scheduleUserUpdates } = require('../services/scheduler');

// Handle callback queries (inline keyboard buttons)
async function handleCallbackQuery(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data;

  if (data.startsWith('toggle_')) {
    const token = data.replace('toggle_', '');
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    
    const index = prefs.tokens.indexOf(token);
    const hasMainToken = prefs.tokens.length > 0;
    
    if (index > -1) {
      // Remove token
      prefs.tokens.splice(index, 1);
    } else {
      // Add token (but limit to 1)
      if (hasMainToken) {
        await bot.answerCallbackQuery(query.id, {
          text: 'Limit: 1 main token. Remove existing first.',
          show_alert: true
        });
        return;
      }
      prefs.tokens.push(token);
    }
    
    await updateUserPreferences(chatId, { tokens: prefs.tokens });
    scheduleUserUpdates(bot, chatId, prefs);
    
    const tokenInfo = TOKENS[token];
    const isSelected = prefs.tokens.includes(token);
    
    await bot.answerCallbackQuery(query.id, {
      text: `${isSelected ? 'Added' : 'Removed'} ${tokenInfo.name}`
    });
    
    // Update the message
    const hasMainTokenNow = prefs.tokens.length > 0;
    const keyboard = {
      inline_keyboard: Object.keys(TOKENS).map(t => {
        const tInfo = TOKENS[t];
        const selected = prefs.tokens.includes(t);
        const isDisabled = !selected && hasMainTokenNow;
        return [{
          text: `${selected ? '✅' : isDisabled ? '🚫' : '⬜'} ${tInfo.name} (${tInfo.symbol})${isDisabled ? ' (Limit: 1)' : ''}`,
          callback_data: isDisabled ? 'disabled' : `toggle_${t}`
        }];
      })
    };
    
    await bot.editMessageReplyMarkup(keyboard, {
      chat_id: chatId,
      message_id: query.message.message_id
    });

  } else if (data.startsWith('interval_')) {
    const interval = parseInt(data.replace('interval_', ''));
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    
    await updateUserPreferences(chatId, { interval });
    scheduleUserUpdates(bot, chatId, prefs);
    
    await bot.answerCallbackQuery(query.id, {
      text: `Interval set to ${interval} minute${interval > 1 ? 's' : ''}`
    });
    
    await bot.sendMessage(chatId, `✅ Update interval set to ${interval} minute${interval > 1 ? 's' : ''}.`);
  }
}

module.exports = {
  handleCallbackQuery
};

