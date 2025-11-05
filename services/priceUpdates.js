const { getTokenPrice, getSolanaTokenPrice } = require('../utils/api');
const { formatPriceMessage, formatAlertMessage } = require('../utils/messages');
const { TOKENS } = require('../config/tokens');
const { loadUsers, saveUsers, loadPriceHistory, savePriceHistory } = require('../utils/storage');

// Send price update to user
async function sendPriceUpdate(bot, chatId, token) {
  const priceData = await getTokenPrice(TOKENS[token].id);
  
  if (!priceData) {
    return;
  }

  const message = formatPriceMessage(TOKENS[token], priceData);

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
  
  // Fetch fresh price data
  const priceData = await getSolanaTokenPrice(tokenAddress);
  
  if (!priceData) {
    await bot.sendMessage(chatId, `❌ Could not fetch price for ${tokenInfo.symbol || tokenAddress}. Token may not exist or API is unavailable.`);
    return;
  }
  
  // Use stored token info (metadata fetched once when token was added)
  const currentTokenInfo = tokenInfo;

  // Calculate 5-minute price change for direction emoji
  const priceHistory = await loadPriceHistory();
  const historyKey = `solana_${tokenAddress}`;
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
  
  // Calculate 5m change percentage
  let change5m = 0;
  let directionEmoji = '🟢'; // Default to green if no history
  if (price5mAgo && price5mAgo > 0) {
    change5m = ((currentPrice - price5mAgo) / price5mAgo) * 100;
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
  
  const change24h = parseFloat(priceData.change24h);
  const arrowEmoji = change24h >= 0 ? '📈' : '📉';
  
  const athensTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Athens',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(new Date());
  const utcTime = new Date().toUTCString().split(' ')[4];
  
  // Build message with all available data
  let message = `${directionEmoji} *${currentTokenInfo.symbol} @ $${priceData.price}*\n\n` +
    `${arrowEmoji} 24h: ${change24h >= 0 ? '+' : ''}${priceData.change24h}%\n`;
  
  // Add creator wallet if available
  if (currentTokenInfo.creator) {
    message += `\n👤 *Creator:* [${currentTokenInfo.creator.substring(0, 4)}...${currentTokenInfo.creator.substring(currentTokenInfo.creator.length - 4)}](https://solscan.io/account/${currentTokenInfo.creator})`;
  }
  
  // Add holders count if available
  if (currentTokenInfo.holders && currentTokenInfo.holders.count) {
    message += `\n👥 *Holders:* ${currentTokenInfo.holders.count.toLocaleString()}`;
  }
  
  // Add market cap if available
  if (currentTokenInfo.marketCap) {
    message += `\n💰 *Market Cap:* $${currentTokenInfo.marketCap.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
  }
  
  // Add transaction data if available (from pump.fun market activity)
  if (currentTokenInfo.transactions) {
    const tx = currentTokenInfo.transactions;
    if (tx.m5) {
      const m5Data = tx.m5;
      const m5Change = typeof m5Data.priceChangePercent === 'number' ? m5Data.priceChangePercent.toFixed(2) : null;
      message += `\n📊 *5m:* ${m5Data.buys || 0} buys / ${m5Data.sells || 0} sells`;
      if (m5Change !== null) {
        message += ` (${m5Change >= 0 ? '+' : ''}${m5Change}%)`;
      }
    }
    if (tx.h1) {
      const h1Data = tx.h1;
      const h1Change = typeof h1Data.priceChangePercent === 'number' ? h1Data.priceChangePercent.toFixed(2) : null;
      message += `\n📊 *1h:* ${h1Data.buys || 0} buys / ${h1Data.sells || 0} sells`;
      if (h1Change !== null) {
        message += ` (${h1Change >= 0 ? '+' : ''}${h1Change}%)`;
      }
    }
    if (tx.h6) {
      const h6Data = tx.h6;
      const h6Change = typeof h6Data.priceChangePercent === 'number' ? h6Data.priceChangePercent.toFixed(2) : null;
      message += `\n📊 *6h:* ${h6Data.buys || 0} buys / ${h6Data.sells || 0} sells`;
      if (h6Change !== null) {
        message += ` (${h6Change >= 0 ? '+' : ''}${h6Change}%)`;
      }
    }
  }
  
  // Build links section for Solana tokens
  const linksSection = `\n\n🔗 *Links:*\n` +
    `[GMGN](https://gmgn.ai/sol/token/${tokenAddress}) | ` +
    `[Axiom](https://axiom.trade/meme/${tokenAddress}?chain=sol) | ` +
    `[Padre](https://trade.padre.gg/trade/solana/${tokenAddress}) | ` +
    `[DexScreener](https://dexscreener.com/solana/${tokenAddress})`;
  
  message += linksSection;
  message += `\n\n_Updated: ${athensTime} (UTC: ${utcTime})_`;

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
    return;
  }

  // Send standard token updates
  for (const token of userPrefs.tokens || []) {
    if (TOKENS[token]) {
      await sendPriceUpdate(bot, chatId, token);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  
  // Send custom Solana token updates
  for (const customToken of userPrefs.customTokens || []) {
    if (customToken.address && customToken.symbol) {
      await sendCustomTokenUpdate(bot, chatId, customToken.address, customToken);
      await new Promise(resolve => setTimeout(resolve, 500));
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

