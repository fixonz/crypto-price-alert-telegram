const { TOKENS, VALID_INTERVALS } = require('../config/tokens');
const { getUserPreferences, updateUserPreferences, loadUsers, saveUsers, getUserCount, getActiveUserCount } = require('../utils/storage');
const { getSolanaTokenInfo } = require('../utils/api');
const { scheduleUserUpdates } = require('../services/scheduler');
const { notifyAdminNewUser } = require('./admin');

// Start command
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

  const welcomeMessage = `👋 *Welcome to Crypto Price Bot!*

Select which cryptocurrencies you want to track:
• /select - Choose tokens to monitor (BTC, ETH, BNB, SOL)
• /addtoken - Add custom Solana token by address
• /interval - Set update interval
• /mytokens - View your current settings
• /stop - Stop receiving updates

🚨 *Instant Alerts:* You'll automatically receive instant alerts when any selected token drops 5% or more, regardless of your update interval!

_Use /select or /addtoken to get started!_`;

  await bot.sendMessage(chatId, welcomeMessage, { parse_mode: 'Markdown' });
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
        text: `${isSelected ? '✅' : isDisabled ? '🚫' : '⬜'} ${tokenInfo.name} (${tokenInfo.symbol})${isDisabled ? ' (Limit: 1)' : ''}`,
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
      return `• ${tokenInfo.emoji} ${tokenInfo.name} (${tokenInfo.symbol})`;
    }).join('\n');
    tokenList += `*Standard Tokens:*\n${standardTokens}`;
  }
  
  if (prefs.customTokens && prefs.customTokens.length > 0) {
    const customTokens = prefs.customTokens.map(ct => {
      return `• 🪙 ${ct.symbol || 'Unknown'} (${ct.address.substring(0, 8)}...)`;
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
  
  // Store that we're waiting for token address
  const users = await loadUsers();
  if (!users[chatId]) {
    users[chatId] = {
      subscribed: true,
      tokens: [],
      customTokens: [],
      interval: 1,
      createdAt: Date.now()
    };
  }
  users[chatId].waitingForTokenAddress = true;
  await saveUsers(users);
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

🪙 *Token Distribution:*
${tokenList}

_Updated: ${new Date().toLocaleString()}_`;

  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
}

// Handle token address input
async function handleTokenAddress(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text;
  
  const users = await loadUsers();
  const userPrefs = users[chatId];
  
  // Check if user is waiting for token address
  if (userPrefs?.waitingForTokenAddress && text) {
    const tokenAddress = text.trim();
    
    // Validate Solana address format (base58, 32-44 characters)
    if (tokenAddress.length < 32 || tokenAddress.length > 44) {
      await bot.sendMessage(chatId, '❌ Invalid Solana address format. Please send a valid Solana token address (32-44 characters).');
      return;
    }
    
    await bot.sendMessage(chatId, '⏳ Fetching token information...');
    
    // Check if token already exists
    const existingToken = userPrefs.customTokens?.find(ct => ct.address === tokenAddress);
    if (existingToken) {
      delete users[chatId].waitingForTokenAddress;
      await saveUsers(users);
      await bot.sendMessage(chatId, `❌ Token ${existingToken.symbol} is already in your list.`);
      return;
    }
    
    // Fetch token info
    const tokenInfo = await getSolanaTokenInfo(tokenAddress);
    if (!tokenInfo) {
      delete users[chatId].waitingForTokenAddress;
      await saveUsers(users);
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
    
    delete users[chatId].waitingForTokenAddress;
    await saveUsers(users);
    
    // Schedule updates for this user
    scheduleUserUpdates(bot, chatId, userPrefs);
    
    // Build confirmation message
    let confirmMessage = `✅ *Token Added Successfully!*\n\n` +
      `*Name:* ${tokenInfo.name}\n` +
      `*Symbol:* ${tokenInfo.symbol}\n` +
      `*Address:* \`${tokenAddress.substring(0, 8)}...${tokenAddress.substring(tokenAddress.length - 8)}\`\n\n`;
    
    if (tokenInfo.creator) {
      confirmMessage += `👤 *Creator:* [${tokenInfo.creator.substring(0, 4)}...${tokenInfo.creator.substring(tokenInfo.creator.length - 4)}](https://solscan.io/account/${tokenInfo.creator})\n\n`;
    }
    
    if (tokenInfo.holders && tokenInfo.holders.count) {
      confirmMessage += `👥 *Holders:* ${tokenInfo.holders.count.toLocaleString()}\n\n`;
    }
    
    if (tokenInfo.marketCap) {
      confirmMessage += `💰 *Market Cap:* $${tokenInfo.marketCap.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n\n`;
    }
    
    confirmMessage += `You'll receive price updates for this token at your selected interval.\n\n` +
      `Use /mytokens to view all your tokens.`;
    
    await bot.sendMessage(chatId, confirmMessage, { parse_mode: 'Markdown', disable_web_page_preview: true });
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

