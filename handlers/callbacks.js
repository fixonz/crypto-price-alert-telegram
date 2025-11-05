const { TOKENS, VALID_INTERVALS } = require('../config/tokens');
const { getUserPreferences, updateUserPreferences, loadUsers, saveUsers, setTempFlag, clearTempFlag } = require('../utils/storage');
const { scheduleUserUpdates } = require('../services/scheduler');
const { handleStart } = require('./commands');

// Handle callback queries (inline keyboard buttons)
async function handleCallbackQuery(bot, query) {
  const chatId = query.message.chat.id;
  const data = query.data;

  // Menu actions
  if (data === 'menu_add_main') {
    await handleSelectFromMenu(bot, query);
    return;
  } else if (data === 'menu_add_solana') {
    await handleAddTokenFromMenu(bot, query);
    return;
  } else if (data === 'menu_remove') {
    await handleRemoveTokensFromMenu(bot, query);
    return;
  } else if (data === 'menu_interval') {
    await handleIntervalFromMenu(bot, query);
    return;
  } else if (data === 'menu_pause') {
    await updateUserPreferences(chatId, { subscribed: false });
    await bot.answerCallbackQuery(query.id, { text: 'Updates paused' });
    // Refresh menu
    await handleStart(bot, { chat: { id: chatId } });
    return;
  } else if (data === 'menu_resume') {
    await updateUserPreferences(chatId, { subscribed: true });
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    scheduleUserUpdates(bot, chatId, prefs);
    await bot.answerCallbackQuery(query.id, { text: 'Updates resumed' });
    // Refresh menu
    await handleStart(bot, { chat: { id: chatId } });
    return;
  } else if (data === 'menu_back') {
    await handleStart(bot, { chat: { id: chatId } });
    return;
  } else if (data.startsWith('remove_main_')) {
    const token = data.replace('remove_main_', '');
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    const index = prefs.tokens.indexOf(token);
    if (index > -1) {
      prefs.tokens.splice(index, 1);
      await updateUserPreferences(chatId, { tokens: prefs.tokens });
      scheduleUserUpdates(bot, chatId, prefs);
      await bot.answerCallbackQuery(query.id, { text: `${TOKENS[token]?.name || token} removed` });
      await handleRemoveTokensFromMenu(bot, query);
    }
    return;
  } else if (data.startsWith('remove_solana_')) {
    const address = data.replace('remove_solana_', '');
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    if (prefs.customTokens && prefs.customTokens.length > 0) {
      const tokenToRemove = prefs.customTokens.find(ct => ct.address === address);
      prefs.customTokens = prefs.customTokens.filter(ct => ct.address !== address);
      await updateUserPreferences(chatId, { customTokens: prefs.customTokens });
      scheduleUserUpdates(bot, chatId, prefs);
      await bot.answerCallbackQuery(query.id, { 
        text: `${tokenToRemove?.symbol || 'Token'} removed` 
      });
      // Refresh remove menu or go back if no tokens left
      if (prefs.customTokens.length === 0 && (prefs.tokens || []).length === 0) {
        await handleStart(bot, { chat: { id: chatId } });
      } else {
        await handleRemoveTokensFromMenu(bot, query);
      }
    }
    return;
  }

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
    
    // If coming from menu, update selection screen or go back to menu
    if (query.message.text && query.message.text.includes('Select *ONE* main token')) {
      // Update the selection screen
      const hasMainTokenNow = prefs.tokens.length > 0;
      const keyboard = {
        inline_keyboard: [
          ...Object.keys(TOKENS).map(t => {
            const tInfo = TOKENS[t];
            const selected = prefs.tokens.includes(t);
            const isDisabled = !selected && hasMainTokenNow;
            return [{
              text: `${selected ? '✅' : isDisabled ? '🚫' : '⬜'} ${tInfo.emoji} ${tInfo.name} (${tInfo.symbol})${isDisabled ? ' (Limit: 1)' : ''}`,
              callback_data: isDisabled ? 'disabled' : `toggle_${t}`
            }];
          }),
          [{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]
        ]
      };
      
      await bot.editMessageReplyMarkup(keyboard, {
        chat_id: chatId,
        message_id: query.message.message_id
      });
    } else {
      // If from old /select command, just update that screen
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
    }

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
    // Refresh menu
    await handleStart(bot, { chat: { id: chatId } });
  } else if (data.startsWith('set_interval_after_token_')) {
    // Handle interval selection after adding a token
    const interval = parseInt(data.replace('set_interval_after_token_', ''));
    const userInfo = await getUserPreferences(chatId);
    const prefs = { ...userInfo };
    delete prefs.isNew;
    
    await updateUserPreferences(chatId, { interval });
    scheduleUserUpdates(bot, chatId, prefs);
    
    await bot.answerCallbackQuery(query.id, {
      text: `Interval set to ${interval} minute${interval > 1 ? 's' : ''}`
    });
    
    // Delete the interval selection message
    try {
      await bot.deleteMessage(chatId, query.message.message_id);
    } catch (error) {
      // Ignore if message can't be deleted
    }
    
    await bot.sendMessage(chatId, `✅ Update interval set to ${interval} minute${interval > 1 ? 's' : ''}.\n\n📊 Sending current prices for your tracked tokens...`);
    
    // Reload user preferences to ensure we have the latest data (including newly added tokens)
    const freshUserInfo = await getUserPreferences(chatId);
    const freshPrefs = { ...freshUserInfo };
    delete freshPrefs.isNew;
    
    // Log what we're about to send
    console.log(`About to send updates for user ${chatId}:`, {
      subscribed: freshPrefs.subscribed,
      tokens: freshPrefs.tokens || [],
      customTokensCount: (freshPrefs.customTokens || []).length,
      customTokens: (freshPrefs.customTokens || []).map(ct => ({ symbol: ct.symbol, address: ct.address?.substring(0, 8) + '...' }))
    });
    
    // Send immediate price updates for all tracked tokens
    const { sendUserUpdates } = require('../services/priceUpdates');
    try {
      await sendUserUpdates(bot, chatId, freshPrefs);
      console.log(`✅ Successfully sent updates for user ${chatId}`);
    } catch (error) {
      console.error(`❌ Error sending updates for user ${chatId}:`, error.message, error.stack);
    }
    
    // Refresh main menu after a short delay
    setTimeout(async () => {
      await handleStart(bot, { chat: { id: chatId } });
    }, 2000);
  }
}

// Handle add main token from menu
async function handleSelectFromMenu(bot, query) {
  const chatId = query.message.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;
  
  const hasMainToken = prefs.tokens.length > 0;
  
  const keyboard = {
    inline_keyboard: [
      ...Object.keys(TOKENS).map(token => {
        const tokenInfo = TOKENS[token];
        const isSelected = prefs.tokens.includes(token);
        const isDisabled = !isSelected && hasMainToken;
        return [{
          text: `${isSelected ? '✅' : isDisabled ? '🚫' : '⬜'} ${tokenInfo.emoji} ${tokenInfo.name} (${tokenInfo.symbol})${isDisabled ? ' (Limit: 1)' : ''}`,
          callback_data: isDisabled ? 'disabled' : `toggle_${token}`
        }];
      }),
      [{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]
    ]
  };

  await bot.editMessageText(
    'Select *ONE* main token to monitor:\n\n_You can also add 1 Solana token_',
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
}

// Handle add Solana token from menu
async function handleAddTokenFromMenu(bot, query) {
  const chatId = query.message.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;

  if (prefs.customTokens && prefs.customTokens.length >= 1) {
    await bot.answerCallbackQuery(query.id, {
      text: 'Limit: 1 Solana token. Remove existing first.',
      show_alert: true
    });
    return;
  }

  const keyboard = {
    inline_keyboard: [
      [{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]
    ]
  };

  await bot.editMessageText(
    '📝 *Add Custom Solana Token*\n\n' +
    'Please send me the Solana token address.\n\n' +
    '_Example: So11111111111111111111111111111111111111112_\n\n' +
    'Or click back to cancel.',
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );

  // Store that we're waiting for token address (using temp flag)
  setTempFlag(chatId, 'waitingForTokenAddress', true);
}

// Handle remove tokens from menu
async function handleRemoveTokensFromMenu(bot, query) {
  const chatId = query.message.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;

  const buttons = [];
  
  // Add main token removal buttons
  if (prefs.tokens && prefs.tokens.length > 0) {
    prefs.tokens.forEach(tokenKey => {
      const tokenInfo = TOKENS[tokenKey];
      if (tokenInfo) {
        buttons.push([{
          text: `➖ Remove ${tokenInfo.emoji} ${tokenInfo.name} (${tokenInfo.symbol})`,
          callback_data: `remove_main_${tokenKey}`
        }]);
      }
    });
  }

  // Add Solana token removal buttons
  if (prefs.customTokens && prefs.customTokens.length > 0) {
    prefs.customTokens.forEach(ct => {
      buttons.push([{
        text: `➖ Remove 🪙 ${ct.symbol || 'Unknown'} (${ct.address.substring(0, 8)}...)`,
        callback_data: `remove_solana_${ct.address}`
      }]);
    });
  }

  if (buttons.length === 0) {
    await bot.answerCallbackQuery(query.id, {
      text: 'No tokens to remove',
      show_alert: true
    });
    return;
  }

  buttons.push([{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]);

  const keyboard = { inline_keyboard: buttons };

  await bot.editMessageText(
    '➖ *Remove Tokens*\n\nSelect a token to remove:',
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
}

// Handle interval from menu
async function handleIntervalFromMenu(bot, query) {
  const chatId = query.message.chat.id;

  const keyboard = {
    inline_keyboard: [
      ...VALID_INTERVALS.map(interval => [{
        text: `⏰ ${interval} minute${interval > 1 ? 's' : ''}`,
        callback_data: `interval_${interval}`
      }]),
      [{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]
    ]
  };

  await bot.editMessageText(
    '⏰ *Choose Update Interval*\n\nHow often do you want to receive price updates?',
    {
      chat_id: chatId,
      message_id: query.message.message_id,
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    }
  );
}

module.exports = {
  handleCallbackQuery
};

