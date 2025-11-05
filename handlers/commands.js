const { TOKENS, VALID_INTERVALS } = require('../config/tokens');
const { getUserPreferences, updateUserPreferences, loadUsers, saveUsers, getUserCount, getActiveUserCount, setTempFlag, getTempFlag, clearTempFlag } = require('../utils/storage');
const { getSolanaTokenInfo } = require('../utils/api');
const { scheduleUserUpdates } = require('../services/scheduler');
const { notifyAdminNewUser } = require('./admin');

// Start command - Beautiful menu with status and buttons
async function handleStart(bot, msg) {
  const chatId = msg.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const isNew = userInfo.isNew;
  const prefs = { ...userInfo };
  delete prefs.isNew;
  
  await updateUserPreferences(chatId, { subscribed: true });
  scheduleUserUpdates(bot, chatId, prefs);

  // Notify admin if new user
  if (isNew && process.env.ADMIN_CHAT_ID) {
    await notifyAdminNewUser(
      bot,
      chatId,
      msg.from?.username,
      msg.from?.first_name,
      msg.from?.last_name
    );
  }

  // Build status message
  let statusMessage = `👋 <b>Welcome to Crypto Price Bot!</b>\n\n`;
  
  // Show tracked tokens with custom LIVE emojis
  const standardTokens = prefs.tokens || [];
  const customTokens = prefs.customTokens || [];
  
  if (standardTokens.length === 0 && customTokens.length === 0) {
    statusMessage += `📊 <b>Your Tracking Status</b>\n\n`;
    statusMessage += `🔸 <b>No tokens tracked yet</b>\n`;
  } else {
    // Custom emojis for "LIV" - will be added via entities
    // Need 6 placeholder characters (each emoji is 2 UTF-16 code units)
    statusMessage += `Tracking 🟥🟥🟥:\n\n`;
    
    if (standardTokens.length > 0) {
      statusMessage += `<b>Main Tokens:</b>\n`;
      standardTokens.forEach(tokenKey => {
        const tokenInfo = TOKENS[tokenKey];
        if (tokenInfo) {
          statusMessage += `  ${tokenInfo.emoji} ${tokenInfo.name} ($${tokenInfo.symbol.toUpperCase()})\n`;
        }
      });
    }
    
    if (customTokens.length > 0) {
      if (standardTokens.length > 0) statusMessage += `\n`;
      statusMessage += `<b>Solana Tokens:</b>\n`;
      customTokens.forEach(ct => {
        const symbolUpper = (ct.symbol || 'Unknown').toUpperCase();
        statusMessage += `  ${symbolUpper} ($${symbolUpper})\n`;
      });
    }
  }

  statusMessage += `\n⏰ <b>Update Interval:</b> ${prefs.interval || 1} minute${(prefs.interval || 1) > 1 ? 's' : ''}`;
  statusMessage += `\n🔔 <b>Status:</b> ${prefs.subscribed ? '✅ Active' : '❌ Inactive'}`;
  statusMessage += `\n\n🚨 <b>Instant Alerts:</b> Price drops of 20%+ (Solana) or 5%+ (main tokens) are sent immediately!`;

  // Build beautiful keyboard menu
  const keyboard = {
    inline_keyboard: [
      [
        { text: '➕ Add Main Token', callback_data: 'menu_add_main' },
        { text: '➕ Add Solana Token', callback_data: 'menu_add_solana' }
      ],
      [
        { text: '➖ Remove Tokens', callback_data: 'menu_remove' },
        { text: '⏰ Change Interval', callback_data: 'menu_interval' }
      ],
      [
        { text: prefs.subscribed ? '⏸️ Pause Updates' : '▶️ Resume Updates', callback_data: prefs.subscribed ? 'menu_pause' : 'menu_resume' }
      ]
    ]
  };

  // Prepare custom emoji entities for "LIV"
  // Entities use UTF-16 code unit offsets (each emoji is 2 UTF-16 code units)
  let entities = [];
  if (standardTokens.length > 0 || customTokens.length > 0) {
    // Find position of "Tracking 🟥🟥🟥:" in the message
    const trackingText = 'Tracking 🟥🟥🟥:';
    const trackingIndex = statusMessage.indexOf(trackingText);
    
    if (trackingIndex !== -1) {
      // Calculate UTF-16 offset for "Tracking " (9 characters = 9 UTF-16 code units)
      // Then add the emoji positions
      const prefix = 'Tracking ';
      const prefixUtf16Length = prefix.length; // Regular ASCII = 1 UTF-16 code unit per char
      
      // Each red square emoji (🟥) is 2 UTF-16 code units
      // L emoji (replaces first 🟥)
      entities.push({
        type: 'custom_emoji',
        offset: trackingIndex + prefixUtf16Length,
        length: 2,
        custom_emoji_id: '5895702350248547531'
      });
      // I emoji (replaces second 🟥)
      entities.push({
        type: 'custom_emoji',
        offset: trackingIndex + prefixUtf16Length + 2,
        length: 2,
        custom_emoji_id: '5895657545149715556'
      });
      // V emoji (replaces third 🟥)
      entities.push({
        type: 'custom_emoji',
        offset: trackingIndex + prefixUtf16Length + 4,
        length: 2,
        custom_emoji_id: '5895565508295529026'
      });
    }
  }
  
  await bot.sendMessage(chatId, statusMessage, { 
    parse_mode: 'HTML',
    entities: entities.length > 0 ? entities : undefined,
    reply_markup: keyboard
  });
}

// Select tokens command
async function handleSelect(bot, msg) {
  const chatId = msg.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;
  
  // Limit to 1 main token
  const hasMainToken = prefs.tokens.length > 0;
  
  const keyboard = {
    inline_keyboard: Object.keys(TOKENS).map(token => {
      const tokenInfo = TOKENS[token];
      const isSelected = prefs.tokens.includes(token);
      const isDisabled = !isSelected && hasMainToken;
      return [{
        text: `${isSelected ? '✅' : isDisabled ? '🚫' : '⬜'} ${tokenInfo.name} ($${tokenInfo.symbol.toUpperCase()})${isDisabled ? ' (Limit: 1)' : ''}`,
        callback_data: isDisabled ? 'disabled' : `toggle_${token}`
      }];
    })
  };

  await bot.sendMessage(chatId, 'Select *ONE* main token to monitor:\n\n_You can also add 1 Solana token with /addtoken_', {
    reply_markup: keyboard,
    parse_mode: 'Markdown'
  });
}

// Interval command
async function handleInterval(bot, msg) {
  const chatId = msg.chat.id;
  
  const keyboard = {
    inline_keyboard: VALID_INTERVALS.map(interval => [{
      text: `${interval} minute${interval > 1 ? 's' : ''}`,
      callback_data: `interval_${interval}`
    }])
  };

  await bot.sendMessage(chatId, 'Choose update interval:', {
    reply_markup: keyboard
  });
}

// My tokens command
async function handleMyTokens(bot, msg) {
  const chatId = msg.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;
  
  if (prefs.tokens.length === 0 && (!prefs.customTokens || prefs.customTokens.length === 0)) {
    await bot.sendMessage(chatId, '❌ You haven\'t selected any tokens yet.\n\nUse /select to choose standard tokens or /addtoken to add Solana tokens.');
    return;
  }

  let tokenList = '';
  if (prefs.tokens.length > 0) {
    const standardTokens = prefs.tokens.map(t => {
      const tokenInfo = TOKENS[t];
      return `• ${tokenInfo.emoji} ${tokenInfo.name} ($${tokenInfo.symbol.toUpperCase()})`;
    }).join('\n');
    tokenList += `*Standard Tokens:*\n${standardTokens}`;
  }
  
  if (prefs.customTokens && prefs.customTokens.length > 0) {
    const customTokens = prefs.customTokens.map(ct => {
      const symbolUpper = (ct.symbol || 'Unknown').toUpperCase();
      return `• ${symbolUpper} ($${symbolUpper})`;
    }).join('\n');
    if (tokenList) tokenList += '\n\n';
    tokenList += `*Custom Solana Tokens:*\n${customTokens}`;
  }

  const message = `📊 *Your Settings*

${tokenList}

*Interval:* ${prefs.interval} minute${prefs.interval > 1 ? 's' : ''}

*Status:* ${prefs.subscribed ? '✅ Active' : '❌ Inactive'}`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Add token command
async function handleAddToken(bot, msg) {
  const chatId = msg.chat.id;
  const userInfo = await getUserPreferences(chatId);
  const prefs = { ...userInfo };
  delete prefs.isNew;
  
  // Check if user already has a Solana token
  if (prefs.customTokens && prefs.customTokens.length >= 1) {
    await bot.sendMessage(chatId, 
      '❌ *Limit Reached*\n\n' +
      'You can only track *1 Solana token* at a time.\n\n' +
      'Use /mytokens to view your current tokens.\n' +
      'To add a new one, you\'ll need to remove the existing token first.',
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  await bot.sendMessage(chatId, 
    '📝 *Add Custom Solana Token*\n\n' +
    'Please send me the Solana token address.\n\n' +
    '_Example: So11111111111111111111111111111111111111112_\n\n' +
    'Or type /cancel to cancel.',
    { parse_mode: 'Markdown' }
  );
  
    // Store that we're waiting for token address (using temp flag)
    setTempFlag(chatId, 'waitingForTokenAddress', true);
}

// Cancel command
async function handleCancel(bot, msg) {
  const chatId = msg.chat.id;
  const users = await loadUsers();
  if (users[chatId]) {
    delete users[chatId].waitingForTokenAddress;
    await saveUsers(users);
  }
  await bot.sendMessage(chatId, '❌ Cancelled.');
}

// Stop command
async function handleStop(bot, msg) {
  const chatId = msg.chat.id;
  await updateUserPreferences(chatId, { subscribed: false });
  
  const { getScheduledJobs } = require('../services/scheduler');
  const scheduledJobs = getScheduledJobs();
  
  if (scheduledJobs[chatId]) {
    scheduledJobs[chatId].destroy();
    delete scheduledJobs[chatId];
  }

  await bot.sendMessage(chatId, '❌ Updates stopped. Use /start to resume.');
}

// Admin command
async function handleAdmin(bot, msg) {
  const chatId = msg.chat.id;
  const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
  
  // Check if user is admin
  if (chatId.toString() !== ADMIN_CHAT_ID?.toString()) {
    await bot.sendMessage(chatId, '❌ Access denied. Admin only.');
    return;
  }

  const totalUsers = await getUserCount();
  const activeUsers = await getActiveUserCount();
  const users = await loadUsers();
  
  // Get token distribution
  const tokenStats = {};
  Object.values(users).forEach(user => {
    if (user.tokens) {
      user.tokens.forEach(token => {
        tokenStats[token] = (tokenStats[token] || 0) + 1;
      });
    }
  });

  const tokenList = Object.entries(tokenStats)
    .map(([token, count]) => {
      const tokenInfo = TOKENS[token];
      return tokenInfo ? `• ${tokenInfo.emoji} ${tokenInfo.name}: *${count}*` : '';
    })
    .filter(Boolean)
    .join('\n') || 'No tokens selected yet';

  const message = `📊 *Bot Statistics*

👥 *Users:*
• Total Users: *${totalUsers}*
• Active Users: *${activeUsers}*
• Inactive Users: *${totalUsers - activeUsers}*

*Token Distribution:*
${tokenList}

_Updated: ${new Date().toLocaleString()}_`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Handle token address input
async function handleTokenAddress(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  // Skip if no text
  if (!text || text.trim().length === 0) {
    return;
  }
  
  try {
    // Check if user is waiting for token address (using temp flag cache)
    if (!getTempFlag(chatId, 'waitingForTokenAddress')) {
      // Not waiting for token address, ignore
      return;
    }
    
    const users = await loadUsers();
    const userPrefs = users[chatId];
    const tokenAddress = text.trim();
    
    // Validate Solana address format (base58, 32-44 characters)
    if (tokenAddress.length < 32 || tokenAddress.length > 44) {
      clearTempFlag(chatId, 'waitingForTokenAddress');
      await bot.sendMessage(chatId, '❌ Invalid Solana address format. Please send a valid Solana token address (32-44 characters).');
      return;
    }
    
    await bot.sendMessage(chatId, '⏳ Fetching token information...');
    
    // Check if token already exists
    const existingToken = userPrefs?.customTokens?.find(ct => ct.address === tokenAddress);
    if (existingToken) {
      clearTempFlag(chatId, 'waitingForTokenAddress');
      await bot.sendMessage(chatId, `❌ Token ${existingToken.symbol} is already in your list.`);
      return;
    }
    
    // Fetch token info
    const tokenInfo = await getSolanaTokenInfo(tokenAddress);
    if (!tokenInfo) {
      clearTempFlag(chatId, 'waitingForTokenAddress');
      await bot.sendMessage(chatId, '❌ Token not found. Please check the address and try again.');
      return;
    }
    
    // Add token to user's custom tokens (limit to 1)
    if (!userPrefs.customTokens) {
      userPrefs.customTokens = [];
    }
    
    // Remove existing Solana token if adding new one
    if (userPrefs.customTokens.length >= 1) {
      userPrefs.customTokens = [];
    }
    
    userPrefs.customTokens.push({
      address: tokenAddress,
      symbol: tokenInfo.symbol,
      name: tokenInfo.name,
      imageUrl: tokenInfo.imageUrl || null,
      decimals: tokenInfo.decimals || null,
      creator: tokenInfo.creator || null,
      pumpSwapPool: tokenInfo.pumpSwapPool || null,
      marketCap: tokenInfo.marketCap || null,
      holders: tokenInfo.holders || null,
      transactions: tokenInfo.transactions || null,
      metadataFetchedAt: Date.now(), // Track when metadata was last fetched
      addedAt: Date.now()
    });
    
    // Update the users object to ensure changes are reflected
    users[chatId] = userPrefs;
    
    console.log(`Adding token ${tokenInfo.symbol} to user ${chatId}. Custom tokens now:`, userPrefs.customTokens.length);
    console.log(`Token data:`, { symbol: tokenInfo.symbol, address: tokenAddress.substring(0, 8) + '...', marketCap: tokenInfo.marketCap });
    
    clearTempFlag(chatId, 'waitingForTokenAddress');
    
    // Save users to database/JSON
    await saveUsers(users);
    console.log(`✅ Saved token ${tokenInfo.symbol} for user ${chatId}. Verified:`, {
      customTokensCount: users[chatId].customTokens?.length || 0,
      hasMarketCap: !!users[chatId].customTokens?.[0]?.marketCap
    });
    
    // Don't schedule yet - wait for user to choose interval
    // scheduleUserUpdates will be called after interval selection
    
    // Build confirmation message with full address (copyable)
    let confirmMessage = `✅ *Token Added Successfully!*\n\n` +
      `*Name:* ${tokenInfo.name}\n` +
      `*Symbol:* $${(tokenInfo.symbol || '').toUpperCase()}\n` +
      `*Address:*\n\`${tokenAddress}\`\n\n`;
    
    if (tokenInfo.creator) {
      confirmMessage += `👤 *Creator:* [${tokenInfo.creator.substring(0, 4)}...${tokenInfo.creator.substring(tokenInfo.creator.length - 4)}](https://solscan.io/account/${tokenInfo.creator})\n\n`;
    }
    
    if (tokenInfo.holders && tokenInfo.holders.count) {
      confirmMessage += `👥 *Holders:* ${tokenInfo.holders.count.toLocaleString()}\n\n`;
    }
    
    if (tokenInfo.marketCap) {
      confirmMessage += `💰 *Market Cap:* $${tokenInfo.marketCap.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n\n`;
    }
    
    confirmMessage += `Now choose your update interval:`;
    
    // Send image if available, otherwise just text
    if (tokenInfo.imageUrl) {
      try {
        await bot.sendPhoto(chatId, tokenInfo.imageUrl, {
          caption: confirmMessage,
          parse_mode: 'Markdown'
        });
      } catch (error) {
        // If image fails, send text message instead
        console.warn('Failed to send token image:', error.message);
        await bot.sendMessage(chatId, confirmMessage, { parse_mode: 'Markdown', disable_web_page_preview: true });
      }
    } else {
      await bot.sendMessage(chatId, confirmMessage, { parse_mode: 'Markdown', disable_web_page_preview: true });
    }
    
    // Prompt for interval selection
    const keyboard = {
      inline_keyboard: [
        ...VALID_INTERVALS.map(interval => [{
          text: `⏰ ${interval} minute${interval > 1 ? 's' : ''}`,
          callback_data: `set_interval_after_token_${interval}`
        }]),
        [{ text: '🔙 Back to Menu', callback_data: 'menu_back' }]
      ]
    };
    
      await bot.sendMessage(chatId, '⏰ *Choose Update Interval*\n\nHow often do you want to receive price updates for this token?', {
      reply_markup: keyboard,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error('Error handling token address:', error);
    await bot.sendMessage(chatId, '❌ An error occurred while processing the token address. Please try again.');
  }
}

module.exports = {
  handleStart,
  handleSelect,
  handleInterval,
  handleMyTokens,
  handleAddToken,
  handleCancel,
  handleStop,
  handleAdmin,
  handleTokenAddress
};

