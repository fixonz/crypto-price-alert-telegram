const { getAllTokenPrices, getSolanaTokenPrice } = require('../utils/api');
const { loadPriceHistory, savePriceHistory, loadUsers } = require('../utils/storage');
const { TOKENS } = require('../config/tokens');
const { sendPriceDropAlert, sendCustomTokenUpdate } = require('./priceUpdates');

// Check for price drops and send instant alerts
async function checkPriceDrops(bot) {
  const priceHistory = await loadPriceHistory();
  const users = await loadUsers();
  
  // Fetch all standard token prices at once (more efficient)
  const allPrices = await getAllTokenPrices();
  if (!allPrices) {
    console.warn('⚠️ Could not fetch standard token prices, skipping drop check');
  } else {
    // Check each standard token
    for (const [tokenKey, tokenInfo] of Object.entries(TOKENS)) {
      if (!allPrices[tokenInfo.id]) continue;
      
      const data = allPrices[tokenInfo.id];
      const currentPrice = parseFloat(data.usd);
      const change24h = data.usd_24h_change;
      const lastPrice = priceHistory[tokenKey]?.price;
      
      // Update price history
      priceHistory[tokenKey] = {
        price: currentPrice,
        timestamp: Date.now()
      };
      await savePriceHistory(priceHistory);
      
      // If we have a previous price, check for drop
      if (lastPrice && lastPrice > 0) {
        const dropPercentage = ((lastPrice - currentPrice) / lastPrice) * 100;
        
        // If price dropped more than 5%, send alerts to all users who have this token
        if (dropPercentage >= 5) {
          console.log(`🚨 Alert: ${tokenInfo.name} dropped ${dropPercentage.toFixed(2)}% (${lastPrice} -> ${currentPrice})`);
          
          const currentPriceData = {
            price: currentPrice.toFixed(2),
            change24h: change24h ? change24h.toFixed(2) : '0.00',
            emoji: change24h >= 0 ? '📈' : '📉'
          };
          
          // Find all users who have this token and are subscribed
          for (const [chatId, userPrefs] of Object.entries(users)) {
            if (userPrefs.subscribed && userPrefs.tokens.includes(tokenKey)) {
              await sendPriceDropAlert(bot, chatId, tokenKey, currentPriceData, dropPercentage, lastPrice.toFixed(2));
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        }
      }
    }
  }
  
  // Check custom Solana tokens for price drops
  for (const [chatId, userPrefs] of Object.entries(users)) {
    if (!userPrefs.subscribed || !userPrefs.customTokens || userPrefs.customTokens.length === 0) {
      continue;
    }
    
    for (const customToken of userPrefs.customTokens) {
      if (!customToken.address) continue;
      
      const priceData = await getSolanaTokenPrice(customToken.address);
      if (!priceData) continue;
      
      // Use stored token info (metadata fetched once when token was added)
      const alertTokenInfo = customToken;
      
      const currentPrice = parseFloat(priceData.price);
      const historyKey = `solana_${customToken.address}`;
      const lastPrice = priceHistory[historyKey]?.price;
      
      // Update price history
      priceHistory[historyKey] = {
        price: currentPrice,
        timestamp: Date.now()
      };
      await savePriceHistory(priceHistory);
      
      // Check for 20% drop (Solana tokens are volatile)
      if (lastPrice && lastPrice > 0) {
        const dropPercentage = ((lastPrice - currentPrice) / lastPrice) * 100;
        
        if (dropPercentage >= 20) {
          console.log(`🚨 Alert: ${alertTokenInfo.symbol} (${customToken.address}) dropped ${dropPercentage.toFixed(2)}%`);
          
          const change24h = parseFloat(priceData.change24h);
          const now = new Date();
          const athensTime = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Europe/Athens',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          }).format(now);
          const utcTime = now.toUTCString().split(' ')[4];
          const arrowEmoji = change24h >= 0 ? '📈' : '📉';
          
          // Format market cap for message preview
          const mcapText = alertTokenInfo.marketCap 
            ? `$${alertTokenInfo.marketCap.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
            : 'N/A';
          
          // Build alert message - start with format visible in message list
          let alertMessage = `🚨 *ALERT - $${(alertTokenInfo.symbol || '').toUpperCase()} @ ${mcapText}*\n\n` +
            `⚠️ *20%+ Drop Detected!*\n\n` +
            `🔴 *$${(alertTokenInfo.symbol || '').toUpperCase()} @ $${priceData.price}* (was $${lastPrice.toFixed(priceData.price.includes('.') ? priceData.price.split('.')[1].length : 2)})\n` +
            `📉 *Drop: -${dropPercentage.toFixed(2)}%*\n` +
            `${arrowEmoji} 24h: ${change24h >= 0 ? '+' : ''}${priceData.change24h}%\n\n`;
          
          // Add creator wallet if available
          if (alertTokenInfo.creator) {
            alertMessage += `👤 *Creator:* [${alertTokenInfo.creator.substring(0, 4)}...${alertTokenInfo.creator.substring(alertTokenInfo.creator.length - 4)}](https://solscan.io/account/${alertTokenInfo.creator})\n`;
          }
          
          // Add holders count if available
          if (alertTokenInfo.holders && alertTokenInfo.holders.count) {
            alertMessage += `👥 *Holders:* ${alertTokenInfo.holders.count.toLocaleString()}\n`;
          }
          
          // Add market cap if available
          if (alertTokenInfo.marketCap) {
            alertMessage += `💰 *Market Cap:* $${alertTokenInfo.marketCap.toLocaleString(undefined, { maximumFractionDigits: 2 })}\n`;
          }
          
          // Add transaction data if available (from pump.fun market activity)
          // Format as code block for better visibility (only 5m and 6h for Solana tokens)
          if (alertTokenInfo.transactions) {
            const tx = alertTokenInfo.transactions;
            
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
              alertMessage += `\n📊 *Market Activity:*\n\`\`\`\n${activityLines.join('\n')}\n\`\`\``;
            }
          }
          
          // Add links section for Solana tokens
          const linksSection = `\n🔗 *Links:*\n` +
            `[GMGN](https://gmgn.ai/sol/token/${customToken.address}) | ` +
            `[Axiom](https://axiom.trade/meme/${customToken.address}?chain=sol) | ` +
            `[Padre](https://trade.padre.gg/trade/solana/${customToken.address}) | ` +
            `[DexScreener](https://dexscreener.com/solana/${customToken.address})`;
          
          alertMessage += linksSection;
          alertMessage += `\n\n_Alert at: Local ${athensTime} (UTC: ${utcTime})_`;
          
          try {
            await bot.sendMessage(chatId, alertMessage, { parse_mode: 'Markdown', disable_web_page_preview: true });
            await new Promise(resolve => setTimeout(resolve, 100));
          } catch (error) {
            if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
              const { loadUsers, saveUsers } = require('../utils/storage');
              const users = await loadUsers();
              delete users[chatId];
              await saveUsers(users);
            }
          }
        }
      }
    }
  }
}

module.exports = {
  checkPriceDrops
};

