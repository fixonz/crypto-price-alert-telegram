const { getTokenPrice, getSolanaTokenPrice } = require('../utils/api');
const { formatPriceMessage, formatAlertMessage } = require('../utils/messages');
const { TOKENS } = require('../config/tokens');
const { loadUsers, saveUsers, loadPriceHistory, savePriceHistory } = require('../utils/storage');

// Helper function to format market cap with k/M/B suffixes
function formatMarketCap(value) {
  if (value >= 1e9) {
    return `$${(value / 1e9).toFixed(2)}B`;
  } else if (value >= 1e6) {
    return `$${(value / 1e6).toFixed(2)}M`;
  } else if (value >= 1e3) {
    return `$${(value / 1e3).toFixed(2)}k`;
  }
  return `$${value.toFixed(2)}`;
}

// Helper function to calculate market cap from price (1B supply for Solana tokens)
function calculateMarketCapFromPrice(price) {
  const priceNum = parseFloat(price);
  if (isNaN(priceNum) || priceNum <= 0) return null;
  // Solana tokens have 1B supply
  return priceNum * 1e9;
}

// Send price update to user
async function sendPriceUpdate(bot, chatId, token) {
  const priceData = await getTokenPrice(TOKENS[token].id);
  
  if (!priceData) {
    return;
  }

  // Calculate 5-minute price change for direction emoji
  const priceHistory = await loadPriceHistory();
  const historyKey = token; // Use token key (sol, btc, eth, bnb)
  const currentPrice = parseFloat(priceData.price);
  const now = Date.now();
  const fiveMinutesAgo = now - (5 * 60 * 1000);
  
  // Find price from 5 minutes ago (or closest)
  let price5mAgo = null;
  if (priceHistory[historyKey] && priceHistory[historyKey].history) {
    // Find the closest price point to 5 minutes ago
    const history = priceHistory[historyKey].history;
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i].timestamp <= fiveMinutesAgo) {
        price5mAgo = history[i].price;
        break;
      }
    }
  }
  
  // If no 5m history, use last known price (if available)
  if (!price5mAgo && priceHistory[historyKey] && priceHistory[historyKey].price) {
    const lastPrice = priceHistory[historyKey].price;
    const lastTimestamp = priceHistory[historyKey].timestamp || 0;
    // Only use if it's within reasonable time (less than 10 minutes old)
    if (now - lastTimestamp < 10 * 60 * 1000) {
      price5mAgo = lastPrice;
    }
  }
  
  // Calculate 5m change and determine emoji
  let directionEmoji = '🟢'; // Default to green
  if (price5mAgo && price5mAgo > 0) {
    const change5m = ((currentPrice - price5mAgo) / price5mAgo) * 100;
    directionEmoji = change5m >= 0 ? '🟢' : '🔴';
  } else {
    // Fallback to 24h change if no 5m history
    const change24h = parseFloat(priceData.change24h);
    directionEmoji = change24h >= 0 ? '🟢' : '🔴';
  }
  
  // Update price history with current price
  if (!priceHistory[historyKey]) {
    priceHistory[historyKey] = {
      price: currentPrice,
      timestamp: now,
      history: []
    };
  }
  
  // Add to history (keep last 20 entries for efficiency)
  if (!priceHistory[historyKey].history) {
    priceHistory[historyKey].history = [];
  }
  priceHistory[historyKey].history.push({
    price: currentPrice,
    timestamp: now
  });
  
  // Keep only last 20 entries
  if (priceHistory[historyKey].history.length > 20) {
    priceHistory[historyKey].history = priceHistory[historyKey].history.slice(-20);
  }
  
  // Update latest price
  priceHistory[historyKey].price = currentPrice;
  priceHistory[historyKey].timestamp = now;
  await savePriceHistory(priceHistory);

  // Format message with 5m-based emoji
  const change24h = parseFloat(priceData.change24h);
  const arrowEmoji = change24h >= 0 ? '📈' : '📉';
  
  const now_formatted = new Date();
  const athensTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Athens',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now_formatted);
  const utcTime = now_formatted.toUTCString().split(' ')[4];
  
  const message = `${directionEmoji} *$${TOKENS[token].symbol.toUpperCase()} @ $${priceData.price}*

${arrowEmoji} 24h: ${change24h >= 0 ? '+' : ''}${priceData.change24h}%

_Updated at: Local ${athensTime} (UTC: ${utcTime})_`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  } catch (error) {
    // If user blocked bot or chat doesn't exist, remove them
    if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
      const users = await loadUsers();
      delete users[chatId];
      await saveUsers(users);
    }
  }
}

// Send price update for custom Solana token
async function sendCustomTokenUpdate(bot, chatId, tokenAddress, tokenInfo) {
  const { getSolanaTokenPrice } = require('../utils/api');
  
  console.log(`Fetching price for ${tokenInfo.symbol || tokenAddress} (${tokenAddress.substring(0, 8)}...)`);
  
  // Fetch fresh price data
  const priceData = await getSolanaTokenPrice(tokenAddress);
  
  if (!priceData) {
    console.error(`Failed to fetch price for ${tokenInfo.symbol || tokenAddress}`);
    await bot.sendMessage(chatId, `❌ Could not fetch price for ${tokenInfo.symbol || tokenAddress}. Token may not exist or API is unavailable.`);
    return;
  }
  
  console.log(`Price fetched for ${tokenInfo.symbol}: $${priceData.price}`);
  
  // Use stored token info (metadata fetched once when token was added)
  const currentTokenInfo = tokenInfo;
  
  // Debug: log if market cap is missing
  if (!currentTokenInfo.marketCap) {
    console.log(`⚠️ No market cap for ${currentTokenInfo.symbol} (${tokenAddress}) - stored metadata:`, {
      hasMarketCap: !!currentTokenInfo.marketCap,
      hasCreator: !!currentTokenInfo.creator,
      hasPumpSwapPool: !!currentTokenInfo.pumpSwapPool
    });
  }

  // Calculate direction emoji based on 24h change (always fresh and accurate)
  // This is the primary source since priceData.change24h is always up-to-date
  const change24h = parseFloat(priceData.change24h);
  let directionEmoji = change24h >= 0 ? '🟢' : '🔴';
  
  // Try to get fresh 5m data for better short-term direction (optional enhancement)
  let change5m = 0;
  try {
    const { getSolanaTokenInfo } = require('../utils/api');
    const freshTokenInfo = await getSolanaTokenInfo(tokenAddress);
    if (freshTokenInfo && freshTokenInfo.transactions && freshTokenInfo.transactions.m5) {
      const m5Change = freshTokenInfo.transactions.m5.priceChangePercent;
      if (typeof m5Change === 'number' && !isNaN(m5Change)) {
        change5m = m5Change;
        // Use 5m change for emoji if available (more recent indicator)
        directionEmoji = change5m >= 0 ? '🟢' : '🔴';
      }
    }
  } catch (error) {
    // If fetching fresh data fails, stick with 24h change (already set above)
    console.log(`Could not fetch fresh transaction data for ${tokenAddress}, using 24h change for emoji`);
  }
  
  // Update price history with current price (for future calculations)
  const priceHistory = await loadPriceHistory();
  const historyKey = `solana_${tokenAddress}`;
  const currentPrice = parseFloat(priceData.price);
  const now = Date.now();
  
  // Update price history with current price
  if (!priceHistory[historyKey]) {
    priceHistory[historyKey] = {
      price: currentPrice,
      timestamp: now,
      history: []
    };
  }
  
  // Add to history (keep last 20 entries for efficiency)
  if (!priceHistory[historyKey].history) {
    priceHistory[historyKey].history = [];
  }
  priceHistory[historyKey].history.push({
    price: currentPrice,
    timestamp: now
  });
  
  // Keep only last 20 entries
  if (priceHistory[historyKey].history.length > 20) {
    priceHistory[historyKey].history = priceHistory[historyKey].history.slice(-20);
  }
  
  // Update latest price
  priceHistory[historyKey].price = currentPrice;
  priceHistory[historyKey].timestamp = now;
  await savePriceHistory(priceHistory);
  
  // change24h already declared above, reuse it
  const arrowEmoji = change24h >= 0 ? '📈' : '📉';
  
  const athensTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Athens',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
  const utcTime = new Date().toUTCString().split(' ')[4];
  
  // Format market cap for message header (visible in chat list)
  // Calculate from price if market cap not available (Solana tokens have 1B supply)
  let marketCap = currentTokenInfo.marketCap;
  if (!marketCap) {
    marketCap = calculateMarketCapFromPrice(priceData.price);
  }
  const mcapText = marketCap 
    ? formatMarketCap(marketCap)
    : 'N/A';
  
  // Build message with market cap in header (visible in chat list) - no price, just mcap
  let message = `${directionEmoji} *$${(currentTokenInfo.symbol || '').toUpperCase()} @ ${mcapText}*\n\n` +
    `💰 *Price:* $${priceData.price}\n` +
    `${arrowEmoji} 24h: ${change24h >= 0 ? '+' : ''}${priceData.change24h}%\n`;
  
  // Add creator wallet if available
  if (currentTokenInfo.creator) {
    message += `\n👤 *Creator:* [${currentTokenInfo.creator.substring(0, 4)}...${currentTokenInfo.creator.substring(currentTokenInfo.creator.length - 4)}](https://solscan.io/account/${currentTokenInfo.creator})`;
  }
  
  // Add holders count if available
  if (currentTokenInfo.holders && currentTokenInfo.holders.count) {
    message += `\n👥 *Holders:* ${currentTokenInfo.holders.count.toLocaleString()}`;
  }
  
  // Add market cap if available (use calculated one if original not available)
  if (marketCap) {
    message += `\n💰 *Market Cap:* ${formatMarketCap(marketCap)}`;
  }
  
  // Add transaction data if available (from pump.fun market activity)
  // Format as code block for better visibility (only 5m and 6h)
  if (currentTokenInfo.transactions) {
    const tx = currentTokenInfo.transactions;
    
    // Build formatted market activity data
    let activityLines = [];
    
    // 5m data
    if (tx.m5) {
      const m5 = tx.m5;
      const m5Change = typeof m5.priceChangePercent === 'number' ? m5.priceChangePercent.toFixed(2) : '0.00';
      activityLines.push(`5m:  B:${m5.buys || 0} / S:${m5.sells || 0} | $${(m5.volumeUSD || 0).toLocaleString(undefined, {maximumFractionDigits: 0})} vol | ${m5Change >= 0 ? '+' : ''}${m5Change}%`);
    }
    
    // 6h data
    if (tx.h6) {
      const h6 = tx.h6;
      const h6Change = typeof h6.priceChangePercent === 'number' ? h6.priceChangePercent.toFixed(2) : '0.00';
      activityLines.push(`6h:  B:${h6.buys || 0} / S:${h6.sells || 0} | $${(h6.volumeUSD || 0).toLocaleString(undefined, {maximumFractionDigits: 0})} vol | ${h6Change >= 0 ? '+' : ''}${h6Change}%`);
    }
    
    if (activityLines.length > 0) {
      message += `\n\n📊 *Market Activity:*\n\`\`\`\n${activityLines.join('\n')}\n\`\`\``;
    }
  }
  
  // Build links section for Solana tokens
  const linksSection = `\n\n🔗 *Links:*\n` +
    `[GMGN](https://gmgn.ai/sol/token/${tokenAddress}) | ` +
    `[Axiom](https://axiom.trade/meme/${tokenAddress}?chain=sol) | ` +
    `[Padre](https://trade.padre.gg/trade/solana/${tokenAddress}) | ` +
    `[DexScreener](https://dexscreener.com/solana/${tokenAddress})`;
  
  message += linksSection;
  message += `\n\n_Updated at: Local ${athensTime} (UTC: ${utcTime})_`;

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', disable_web_page_preview: true });
  } catch (error) {
    if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
      const users = await loadUsers();
      delete users[chatId];
      await saveUsers(users);
    }
  }
}

// Send updates for all user's subscribed tokens
async function sendUserUpdates(bot, chatId, userPrefs) {
  if (!userPrefs.subscribed) {
    console.log(`User ${chatId} is not subscribed, skipping updates`);
    return;
  }

  console.log(`Sending updates for user ${chatId}:`, {
    hasStandardTokens: (userPrefs.tokens || []).length > 0,
    hasCustomTokens: (userPrefs.customTokens || []).length > 0,
    tokens: userPrefs.tokens || [],
    customTokens: (userPrefs.customTokens || []).map(ct => ({ symbol: ct.symbol, address: ct.address?.substring(0, 8) + '...' }))
  });

  // Send standard token updates
  for (const token of userPrefs.tokens || []) {
    if (TOKENS[token]) {
      try {
        await sendPriceUpdate(bot, chatId, token);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error sending price update for ${token}:`, error.message);
      }
    }
  }
  
  // Send custom Solana token updates
  for (const customToken of userPrefs.customTokens || []) {
    if (customToken.address && customToken.symbol) {
      try {
        console.log(`Sending update for custom token ${customToken.symbol} (${customToken.address.substring(0, 8)}...)`);
        await sendCustomTokenUpdate(bot, chatId, customToken.address, customToken);
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error sending custom token update for ${customToken.symbol}:`, error.message, error.stack);
      }
    } else {
      console.warn(`Custom token missing address or symbol:`, customToken);
    }
  }
}

// Send instant alert to user for price drop
async function sendPriceDropAlert(bot, chatId, token, priceData, dropPercentage, previousPrice) {
  const tokenInfo = TOKENS[token];
  const message = formatAlertMessage(tokenInfo, priceData, dropPercentage, previousPrice);

  try {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    console.log(`Alert sent to user ${chatId} for ${tokenInfo.name} (${dropPercentage.toFixed(2)}% drop)`);
  } catch (error) {
    // If user blocked bot or chat doesn't exist, remove them
    if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
      const users = await loadUsers();
      delete users[chatId];
      await saveUsers(users);
    }
  }
}

module.exports = {
  sendPriceUpdate,
  sendCustomTokenUpdate,
  sendUserUpdates,
  sendPriceDropAlert
};

