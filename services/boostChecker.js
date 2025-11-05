const { checkDexScreenerBoosts } = require('../utils/api');
const { loadUsers, loadPriceHistory, savePriceHistory } = require('../utils/storage');

// Track which tokens have boosts (to detect new ones)
// Format: { tokenAddress: { hasBoost: boolean, lastChecked: timestamp } }
const boostStatus = {};

// Check for boosts on all Solana tokens and notify users
async function checkBoostsForAllTokens(bot) {
  console.log('🔍 Checking DexScreener boosts for all Solana tokens...');
  
  const users = await loadUsers();
  const allSolanaTokens = new Set(); // Use Set to avoid duplicates
  
  // Collect all unique Solana token addresses
  for (const [chatId, userPrefs] of Object.entries(users)) {
    if (userPrefs.subscribed && userPrefs.customTokens) {
      for (const customToken of userPrefs.customTokens) {
        if (customToken.address) {
          allSolanaTokens.add(customToken.address);
        }
      }
    }
  }
  
  if (allSolanaTokens.size === 0) {
    console.log('No Solana tokens to check for boosts');
    return;
  }
  
  console.log(`Checking ${allSolanaTokens.size} unique Solana tokens for boosts...`);
  
  // Check each token
  for (const tokenAddress of allSolanaTokens) {
    try {
      const boostData = await checkDexScreenerBoosts(tokenAddress);
      
      if (!boostData) {
        continue; // Skip if API call failed
      }
      
      const previousStatus = boostStatus[tokenAddress];
      const currentHasBoost = boostData.hasBoosts;
      const now = Date.now();
      
      // If this is the first time checking or boost status changed
      if (!previousStatus) {
        // First time - just store the status
        boostStatus[tokenAddress] = {
          hasBoost: currentHasBoost,
          lastChecked: now
        };
        
        if (currentHasBoost) {
          console.log(`✅ Token ${tokenAddress.substring(0, 8)}... has boost (first check)`);
        }
      } else {
        // Check if boost was just added (new boost detected)
        if (!previousStatus.hasBoost && currentHasBoost) {
          console.log(`🚀 NEW BOOST DETECTED for ${tokenAddress.substring(0, 8)}...`);
          
          // Find all users tracking this token and notify them
          for (const [chatId, userPrefs] of Object.entries(users)) {
            if (!userPrefs.subscribed || !userPrefs.customTokens) {
              continue;
            }
            
            const tokenInfo = userPrefs.customTokens.find(ct => ct.address === tokenAddress);
            if (tokenInfo) {
              await notifyBoostDetected(bot, chatId, tokenAddress, tokenInfo);
              // Small delay to avoid rate limits
              await new Promise(resolve => setTimeout(resolve, 100));
            }
          }
        }
        
        // Update status
        boostStatus[tokenAddress] = {
          hasBoost: currentHasBoost,
          lastChecked: now
        };
      }
      
      // Small delay between API calls to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 200));
    } catch (error) {
      console.error(`Error processing boost check for ${tokenAddress}:`, error.message);
    }
  }
  
  console.log(`✅ Boost check completed for ${allSolanaTokens.size} tokens`);
}

// Notify user about boost detection
async function notifyBoostDetected(bot, chatId, tokenAddress, tokenInfo) {
  try {
    const now = new Date();
    const athensTime = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Athens',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(now);
    const utcTime = now.toUTCString().split(' ')[4];
    
    const message = `🚀 *BOOST DETECTED!*\n\n` +
      `✨ *$${tokenInfo.symbol || 'Token'}* now has a DexScreener boost!\n\n` +
      `This means the token profile has been promoted or has an active ad/boost.\n\n` +
      `🔗 *Links:*\n` +
      `[DexScreener](https://dexscreener.com/solana/${tokenAddress}) | ` +
      `[GMGN](https://gmgn.ai/sol/token/${tokenAddress}) | ` +
      `[Axiom](https://axiom.trade/meme/${tokenAddress}?chain=sol)\n\n` +
      `_Detected at: Local ${athensTime} (UTC: ${utcTime})_`;
    
    await bot.sendMessage(chatId, message, { 
      parse_mode: 'Markdown', 
      disable_web_page_preview: true 
    });
    
    console.log(`✅ Boost notification sent to user ${chatId} for token ${tokenInfo.symbol}`);
  } catch (error) {
    if (error.response?.statusCode === 403 || error.response?.statusCode === 400) {
      // User blocked bot - remove them
      const { loadUsers, saveUsers } = require('../utils/storage');
      const users = await loadUsers();
      delete users[chatId];
      await saveUsers(users);
    } else {
      console.error(`Error sending boost notification to ${chatId}:`, error.message);
    }
  }
}

module.exports = {
  checkBoostsForAllTokens
};

