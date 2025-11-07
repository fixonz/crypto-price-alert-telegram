const { TOKENS, VALID_INTERVALS } = require('../config/tokens');
const { getUserPreferences, updateUserPreferences, loadUsers, saveUsers, getUserCount, getActiveUserCount, setTempFlag, getTempFlag, clearTempFlag, getWinningTokens } = require('../utils/storage');
const { getSolanaTokenInfo, getTokenPrice } = require('../utils/api');
const { scheduleUserUpdates } = require('../services/scheduler');
const { notifyAdminNewUser } = require('./admin');
const { KOL_ADDRESSES, KOL_NAME_TO_ADDRESS } = require('../config/kol');

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
  let statusMessage = ``;
  
  // Show tracked tokens
  const standardTokens = prefs.tokens || [];
  const customTokens = prefs.customTokens || [];
  const trackedKOLs = prefs.trackedKOLs || [];
  
  if (standardTokens.length === 0 && customTokens.length === 0 && trackedKOLs.length === 0) {
    statusMessage += `📊 <b>Your Tracking Status</b>\n\n`;
    statusMessage += `🔸 <b>No tokens or KOLs tracked yet</b>\n`;
  } else {
    statusMessage += `Tracking:\n\n`;
    
    // Build token list for code/quote view
    let tokenList = [];
    
    if (standardTokens.length > 0) {
      standardTokens.forEach(tokenKey => {
        const tokenInfo = TOKENS[tokenKey];
        if (tokenInfo) {
          const emojiDisplay = tokenInfo.emoji ? `${tokenInfo.emoji} ` : '';
          tokenList.push(`${emojiDisplay}${tokenInfo.name} ($${tokenInfo.symbol.toUpperCase()})`);
        }
      });
    }
    
    if (customTokens.length > 0) {
      customTokens.forEach(ct => {
        const symbolUpper = (ct.symbol || 'Unknown').toUpperCase();
        tokenList.push(`${symbolUpper} ($${symbolUpper})`);
      });
    }
    
    // Display tokens in code block format
    if (tokenList.length > 0) {
      statusMessage += `<b>Tokens:</b>\n<code>${tokenList.join('\n')}</code>\n\n`;
    }
    
    // Show tracked KOLs
    if (trackedKOLs.length > 0) {
      const kolNames = [];
      trackedKOLs.forEach(address => {
        const names = KOL_ADDRESSES[address];
        if (names && names.length > 0) {
          kolNames.push(names[0]);
        }
      });
      if (kolNames.length > 0) {
        statusMessage += `<b>KOLs:</b>\n<code>${kolNames.join('\n')}</code>\n\n`;
      }
    }
  }

  statusMessage += `⏰ <b>Update Interval:</b> ${prefs.interval || 1} minute${(prefs.interval || 1) > 1 ? 's' : ''}`;
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
        { text: '👥 Browse KOLs', callback_data: 'menu_kols' },
        { text: '➖ Remove Tokens', callback_data: 'menu_remove' }
      ],
      [
        { text: '⏰ Change Interval', callback_data: 'menu_interval' }
      ],
      [
        { text: prefs.subscribed ? '⏸️ Pause Updates' : '▶️ Resume Updates', callback_data: prefs.subscribed ? 'menu_pause' : 'menu_resume' }
      ]
    ]
  };

  await bot.sendMessage(chatId, statusMessage, { 
    parse_mode: 'HTML',
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

// Handle live price queries for individual tokens
async function handleTokenPrice(bot, msg, tokenKey) {
  const chatId = msg.chat.id;
  const tokenInfo = TOKENS[tokenKey];
  
  if (!tokenInfo) {
    await bot.sendMessage(chatId, '❌ Invalid token.');
    return;
  }
  
  try {
    // Show loading message
    const loadingMsg = await bot.sendMessage(chatId, '⏳ Fetching live price...');
    
    // Fetch price
    const priceData = await getTokenPrice(tokenInfo.id);
    
    if (!priceData) {
      await bot.editMessageText('❌ Could not fetch price. Please try again later.', {
        chat_id: chatId,
        message_id: loadingMsg.message_id
      });
      return;
    }
    
    // Calculate direction emoji based on 24h change
    const change24h = parseFloat(priceData.change24h);
    const directionEmoji = change24h >= 0 ? '🟢' : '🔴';
    const arrowEmoji = change24h >= 0 ? '📈' : '📉';
    
    // Format time
    const now_formatted = new Date();
    const athensTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Athens',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now_formatted);
    const utcTime = now_formatted.toUTCString().split(' ')[4];
    
    const emojiDisplay = tokenInfo.emoji ? `${tokenInfo.emoji} ` : '';
    const message = `${directionEmoji} *${emojiDisplay}${tokenInfo.name} ($${tokenInfo.symbol.toUpperCase()}) @ $${priceData.price}*\n\n` +
      `${arrowEmoji} 24h: ${change24h >= 0 ? '+' : ''}${priceData.change24h}%\n\n` +
      `_Updated at: Local ${athensTime} (UTC: ${utcTime})_`;
    
    await bot.editMessageText(message, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown'
    });
  } catch (error) {
    console.error(`Error fetching price for ${tokenKey}:`, error);
    await bot.sendMessage(chatId, '❌ An error occurred while fetching the price. Please try again.');
  }
}

// Individual token handlers
async function handleBTC(bot, msg) {
  await handleTokenPrice(bot, msg, 'bitcoin');
}

async function handleETH(bot, msg) {
  await handleTokenPrice(bot, msg, 'ethereum');
}

async function handleBNB(bot, msg) {
  await handleTokenPrice(bot, msg, 'binancecoin');
}

async function handleSOL(bot, msg) {
  await handleTokenPrice(bot, msg, 'solana');
}

// Handle KOL command - list KOLs or show address for specific KOL
async function handleKOL(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();
  
  try {
    if (!args) {
      // List all KOLs with pagination (page 1 by default)
      await sendKOLListPage(bot, chatId, 1);
    } else {
      // Search for specific KOL
      const searchName = args.toLowerCase();
      let foundAddress = null;
      let foundName = null;
      
      // Try exact match first
      if (KOL_NAME_TO_ADDRESS[searchName]) {
        foundAddress = KOL_NAME_TO_ADDRESS[searchName];
        // Find the original name
        for (const [address, names] of Object.entries(KOL_ADDRESSES)) {
          if (address === foundAddress) {
            foundName = names[0];
            break;
          }
        }
      } else {
        // Try partial match (case-insensitive, ignoring special chars)
        const normalizedSearch = searchName.replace(/[^\w\s]/g, '').trim();
        for (const [address, names] of Object.entries(KOL_ADDRESSES)) {
          for (const name of names) {
            const normalizedName = name.toLowerCase().replace(/[^\w\s]/g, '').trim();
            if (normalizedName.includes(normalizedSearch) || normalizedSearch.includes(normalizedName)) {
              foundAddress = address;
              foundName = name;
              break;
            }
          }
          if (foundAddress) break;
        }
      }
      
      if (foundAddress && foundName) {
        // Get profile image from kolscan.io CDN
        const profileImageUrl = `https://cdn.kolscan.io/profiles/${foundAddress}.png`;
        
        // Check if user is already tracking this KOL
        const userPrefs = await getUserPreferences(chatId);
        const trackedKOLs = userPrefs.trackedKOLs || [];
        const isTracking = trackedKOLs.includes(foundAddress);
        
        const message = `👤 <b>${foundName}</b>\n\n<code>${foundAddress}</code>\n\n🔗 <a href="https://kolscan.io/account/${foundAddress}">View on Kolscan</a> | <a href="https://solscan.io/account/${foundAddress}">Solscan</a>`;
        
        // Create inline keyboard with Track/Untrack button
        const keyboard = {
          inline_keyboard: [[
            {
              text: isTracking ? '✅ Tracking' : '➕ Track KOL',
              callback_data: isTracking ? `kol_untrack_${foundAddress}` : `kol_track_${foundAddress}`
            }
          ]]
        };
        
        try {
          // Try to send with photo first
          await bot.sendPhoto(chatId, profileImageUrl, {
            caption: message,
            parse_mode: 'HTML',
            reply_markup: keyboard
          });
        } catch (photoError) {
          // If photo fails (404 or other error), send text only
          console.log(`Could not load profile image for ${foundName}:`, photoError.message);
          await bot.sendMessage(chatId, message, {
            parse_mode: 'HTML',
            disable_web_page_preview: true,
            reply_markup: keyboard
          });
        }
      } else {
        await bot.sendMessage(chatId, `❌ KOL "${args}" not found. Use /kol to see all available KOLs.`, {
          parse_mode: 'HTML'
        });
      }
    }
  } catch (error) {
    console.error('Error handling KOL command:', error);
    await bot.sendMessage(chatId, '❌ An error occurred while processing the KOL command.');
  }
}

// Helper function to send KOL list page with pagination and track buttons
async function sendKOLListPage(bot, chatId, page = 1) {
  const userPrefs = await getUserPreferences(chatId);
  const trackedKOLs = userPrefs.trackedKOLs || [];
  
  const kolList = [];
  for (const [address, names] of Object.entries(KOL_ADDRESSES)) {
    const primaryName = names[0];
    kolList.push({ name: primaryName, address });
  }
  
  // Sort alphabetically by name
  kolList.sort((a, b) => a.name.localeCompare(b.name));
  
  // Split into pages (20 KOLs per page to fit buttons)
  const itemsPerPage = 20;
  const totalPages = Math.ceil(kolList.length / itemsPerPage);
  const currentPage = Math.max(1, Math.min(page, totalPages)); // Clamp between 1 and totalPages
  
  const startIdx = (currentPage - 1) * itemsPerPage;
  const endIdx = startIdx + itemsPerPage;
  const pageItems = kolList.slice(startIdx, endIdx);
  
  const message = `👥 <b>KOL List</b> (${startIdx + 1}-${Math.min(endIdx, kolList.length)} of ${kolList.length})\n\n💡 Click a KOL to track/untrack them\n\n📄 Page ${currentPage} of ${totalPages}`;
  
  // Create keyboard with KOL buttons (2 columns)
  const keyboard = {
    inline_keyboard: []
  };
  
  // Add KOL buttons in rows of 2
  for (let i = 0; i < pageItems.length; i += 2) {
    const row = [];
    for (let j = 0; j < 2 && i + j < pageItems.length; j++) {
      const item = pageItems[i + j];
      const isTracking = trackedKOLs.includes(item.address);
      const buttonText = isTracking ? `✅ ${item.name}` : item.name;
      row.push({
        text: buttonText,
        callback_data: isTracking ? `kol_untrack_${item.address}` : `kol_track_${item.address}`
      });
    }
    keyboard.inline_keyboard.push(row);
  }
  
  // Add pagination buttons
  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push({
      text: '◀️ Previous',
      callback_data: `kol_page_${currentPage - 1}`
    });
  }
  if (currentPage < totalPages) {
    navButtons.push({
      text: 'Next ▶️',
      callback_data: `kol_page_${currentPage + 1}`
    });
  }
  
  if (navButtons.length > 0) {
    keyboard.inline_keyboard.push(navButtons);
  }
  
  // Add page indicator button
  keyboard.inline_keyboard.push([{
    text: `Page ${currentPage} of ${totalPages}`,
    callback_data: 'kol_page_info'
  }]);
  
  // Add back button
  keyboard.inline_keyboard.push([{
    text: '🔙 Back to Menu',
    callback_data: 'menu_back'
  }]);
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'HTML',
    reply_markup: keyboard
  });
}

// Handle track KOL command
async function handleTrackKOL(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();
  
  if (!args) {
    await bot.sendMessage(chatId, '❌ Please specify a KOL name. Use /trackkol [name]\n\n💡 Use /kol to see all available KOLs.');
    return;
  }
  
  try {
    const userPrefs = await getUserPreferences(chatId);
    const searchName = args.toLowerCase();
    
    // Find KOL by name
    let foundAddress = null;
    let foundName = null;
    
    // Try exact match first
    if (KOL_NAME_TO_ADDRESS[searchName]) {
      foundAddress = KOL_NAME_TO_ADDRESS[searchName];
      for (const [address, names] of Object.entries(KOL_ADDRESSES)) {
        if (address === foundAddress) {
          foundName = names[0];
          break;
        }
      }
    } else {
      // Try partial match
      const normalizedSearch = searchName.replace(/[^\w\s]/g, '').trim();
      for (const [address, names] of Object.entries(KOL_ADDRESSES)) {
        for (const name of names) {
          const normalizedName = name.toLowerCase().replace(/[^\w\s]/g, '').trim();
          if (normalizedName.includes(normalizedSearch) || normalizedSearch.includes(normalizedName)) {
            foundAddress = address;
            foundName = name;
            break;
          }
        }
        if (foundAddress) break;
      }
    }
    
    if (!foundAddress || !foundName) {
      await bot.sendMessage(chatId, `❌ KOL "${args}" not found. Use /kol to see all available KOLs.`);
      return;
    }
    
    // Check if already tracking
    const trackedKOLs = userPrefs.trackedKOLs || [];
    if (trackedKOLs.includes(foundAddress)) {
      await bot.sendMessage(chatId, `✅ You're already tracking <b>${foundName}</b>!`, {
        parse_mode: 'HTML'
      });
      return;
    }
    
    // Check if user has reached the limit of 2 KOLs
    if (trackedKOLs.length >= 2) {
      await bot.sendMessage(chatId, `❌ Maximum limit reached! You can only track 2 KOLs at a time. Please use /untrackkol to remove one first.`, {
        parse_mode: 'HTML'
      });
      return;
    }
    
    // Add to tracked KOLs
    trackedKOLs.push(foundAddress);
    await updateUserPreferences(chatId, { trackedKOLs });
    
    await bot.sendMessage(chatId, `✅ Now tracking <b>${foundName}</b>!\n\nYou'll receive alerts when they buy or sell tokens.`, {
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Error tracking KOL:', error);
    await bot.sendMessage(chatId, '❌ An error occurred while tracking the KOL.');
  }
}

// Handle untrack KOL command
async function handleUntrackKOL(bot, msg) {
  const chatId = msg.chat.id;
  const text = msg.text || '';
  const args = text.split(' ').slice(1).join(' ').trim();
  
  try {
    const userPrefs = await getUserPreferences(chatId);
    const trackedKOLs = userPrefs.trackedKOLs || [];
    
    if (trackedKOLs.length === 0) {
      await bot.sendMessage(chatId, '❌ You\'re not tracking any KOLs. Use /trackkol [name] to start tracking.');
      return;
    }
    
    if (!args) {
      // List tracked KOLs
      const kolList = trackedKOLs.map(address => {
        const names = KOL_ADDRESSES[address];
        return names ? names[0] : address.substring(0, 8) + '...';
      }).join('\n');
      
      await bot.sendMessage(chatId, `📋 <b>Tracked KOLs:</b>\n\n${kolList}\n\n💡 Use /untrackkol [name] to stop tracking a KOL.`, {
        parse_mode: 'HTML'
      });
      return;
    }
    
    // Find KOL to untrack
    const searchName = args.toLowerCase();
    let foundAddress = null;
    let foundName = null;
    
    // Try exact match first
    if (KOL_NAME_TO_ADDRESS[searchName]) {
      foundAddress = KOL_NAME_TO_ADDRESS[searchName];
      for (const [address, names] of Object.entries(KOL_ADDRESSES)) {
        if (address === foundAddress) {
          foundName = names[0];
          break;
        }
      }
    } else {
      // Try partial match
      const normalizedSearch = searchName.replace(/[^\w\s]/g, '').trim();
      for (const [address, names] of Object.entries(KOL_ADDRESSES)) {
        for (const name of names) {
          const normalizedName = name.toLowerCase().replace(/[^\w\s]/g, '').trim();
          if (normalizedName.includes(normalizedSearch) || normalizedSearch.includes(normalizedName)) {
            foundAddress = address;
            foundName = name;
            break;
          }
        }
        if (foundAddress) break;
      }
    }
    
    if (!foundAddress || !foundName) {
      await bot.sendMessage(chatId, `❌ KOL "${args}" not found.`);
      return;
    }
    
    // Remove from tracked KOLs
    const updatedKOLs = trackedKOLs.filter(addr => addr !== foundAddress);
    await updateUserPreferences(chatId, { trackedKOLs: updatedKOLs });
    
    await bot.sendMessage(chatId, `✅ Stopped tracking <b>${foundName}</b>.`, {
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Error untracking KOL:', error);
    await bot.sendMessage(chatId, '❌ An error occurred while untracking the KOL.');
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
  handleTokenAddress,
  handleBTC,
  handleETH,
  handleBNB,
  handleSOL,
  handleKOL,
  handleTrackKOL,
  handleUntrackKOL,
  sendKOLListPage
};

