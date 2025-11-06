const axios = require('axios');
const { KOL_ADDRESSES } = require('../config/kol');
const { loadUsers } = require('../utils/storage');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '2238f591-e4cf-4e28-919a-6e7164a9d0ad';
const HELIUS_BASE_URL = 'https://api-mainnet.helius-rpc.com';

// Cache to track last checked transaction signature per KOL
const lastTransactionCache = {};

// Get recent transactions for a KOL address
async function getKOLTransactions(kolAddress, limit = 10) {
  try {
    const response = await axios.get(
      `${HELIUS_BASE_URL}/v0/addresses/${kolAddress}/transactions/`,
      {
        params: {
          'api-key': HELIUS_API_KEY,
          limit: limit
        },
        timeout: 10000
      }
    );
    
    return response.data || [];
  } catch (error) {
    console.error(`Error fetching transactions for KOL ${kolAddress}:`, error.message);
    return [];
  }
}

// Parse transaction to extract token swap information
function parseSwapTransaction(tx, kolAddress) {
  try {
    if (!tx || !tx.transaction || !tx.transaction.message) {
      return null;
    }

    const transaction = tx.transaction;
    const meta = tx.meta;
    
    if (!meta || meta.err) {
      return null; // Failed transaction
    }

    // Get the KOL's account index from the transaction
    // The accountKeys can be strings or objects with pubkey property
    const accountKeys = transaction.message?.accountKeys || [];
    
    // Find the KOL's address in the account keys
    let kolAccountIndex = -1;
    for (let i = 0; i < accountKeys.length; i++) {
      const acc = accountKeys[i];
      const accAddress = typeof acc === 'string' ? acc : (acc.pubkey || acc);
      if (accAddress && accAddress.toLowerCase() === kolAddress.toLowerCase()) {
        kolAccountIndex = i;
        break;
      }
    }
    
    // If not found, default to first account (usually the signer/fee payer)
    if (kolAccountIndex === -1) {
      kolAccountIndex = 0;
    }

    // Check for token transfers
    const preTokenBalances = meta.preTokenBalances || [];
    const postTokenBalances = meta.postTokenBalances || [];
    
    // Find token balance changes for the KOL's account
    const tokenChanges = [];
    const balanceMap = new Map();
    
    // Map pre-balances for KOL's account
    preTokenBalances
      .filter(balance => balance.accountIndex === kolAccountIndex)
      .forEach(balance => {
        const key = balance.mint;
        balanceMap.set(key, {
          mint: balance.mint,
          preAmount: parseFloat(balance.uiTokenAmount?.uiAmountString || '0'),
          owner: balance.owner
        });
      });
    
    // Map post-balances and calculate changes
    postTokenBalances
      .filter(balance => balance.accountIndex === kolAccountIndex)
      .forEach(balance => {
        const key = balance.mint;
        const preBalance = balanceMap.get(key);
        const postAmount = parseFloat(balance.uiTokenAmount?.uiAmountString || '0');
        
        if (preBalance) {
          const change = postAmount - preBalance.preAmount;
          if (Math.abs(change) > 0.000001) { // Significant change
            tokenChanges.push({
              mint: balance.mint,
              owner: balance.owner,
              change: change,
              preAmount: preBalance.preAmount,
              postAmount: postAmount
            });
          }
        } else if (postAmount > 0.000001) {
          // New token balance (buy)
          tokenChanges.push({
            mint: balance.mint,
            owner: balance.owner,
            change: postAmount,
            preAmount: 0,
            postAmount: postAmount
          });
        }
      });
    
    // Check for SOL balance changes for KOL's account
    const preBalances = meta.preBalances || [];
    const postBalances = meta.postBalances || [];
    let solChange = 0;
    
    if (preBalances[kolAccountIndex] !== undefined && postBalances[kolAccountIndex] !== undefined) {
      solChange = (postBalances[kolAccountIndex] - preBalances[kolAccountIndex]) / 1e9; // Convert lamports to SOL
    }
    
    // Determine if this is a buy or sell
    // Buy: SOL decreases, token increases
    // Sell: SOL increases, token decreases
    let swapType = null;
    let tokenMint = null;
    let amount = 0;
    let solAmount = 0;
    
    // Filter out SOL and USDC (common stablecoins) from token changes
    const significantTokenChanges = tokenChanges.filter(change => {
      const mint = change.mint.toLowerCase();
      // Exclude SOL, USDC, and other common stablecoins
      return !mint.includes('so11111111111111111111111111111111111111112') && // SOL
             !mint.includes('epjfwda5hvph1akvd2vndkrefmtwqxar3sqn7kl3ng') && // USDC
             !mint.includes('es9vfr6n3fmelq3q9hmkyfv8ycbkmahfsn3qycpc'); // USDT
    });
    
    if (significantTokenChanges.length > 0 && Math.abs(solChange) > 0.001) {
      const tokenChange = significantTokenChanges[0];
      
      // Check if SOL decreased (buy) or increased (sell)
      if (solChange < -0.001 && tokenChange.change > 0.000001) {
        swapType = 'buy';
        tokenMint = tokenChange.mint;
        amount = tokenChange.change;
        solAmount = Math.abs(solChange);
      } else if (solChange > 0.001 && tokenChange.change < -0.000001) {
        swapType = 'sell';
        tokenMint = tokenChange.mint;
        amount = Math.abs(tokenChange.change);
        solAmount = solChange;
      }
    }
    
    if (swapType && tokenMint) {
      return {
        signature: transaction.signatures?.[0] || '',
        timestamp: tx.blockTime ? new Date(tx.blockTime * 1000) : new Date(),
        type: swapType, // 'buy' or 'sell'
        tokenMint: tokenMint,
        tokenAmount: amount,
        solAmount: solAmount,
        owner: tokenChanges[0]?.owner || null
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error parsing transaction:', error.message);
    return null;
  }
}

// Check if a token mint matches any tracked token
function isTrackedToken(tokenMint, userPrefs) {
  if (!userPrefs) return false;
  
  // Check custom Solana tokens
  if (userPrefs.customTokens && Array.isArray(userPrefs.customTokens)) {
    return userPrefs.customTokens.some(token => 
      token.address && token.address.toLowerCase() === tokenMint.toLowerCase()
    );
  }
  
  return false;
}

// Get KOL name from address
function getKOLName(address) {
  for (const [kolAddress, names] of Object.entries(KOL_ADDRESSES)) {
    if (kolAddress.toLowerCase() === address.toLowerCase()) {
      return names[0];
    }
  }
  return null;
}

// Monitor KOL transactions and send alerts
async function checkKOLTransactions(bot) {
  try {
    const users = await loadUsers();
    const kolAddresses = Object.keys(KOL_ADDRESSES);
    
    console.log(`Checking transactions for ${kolAddresses.length} KOLs...`);
    
    for (const kolAddress of kolAddresses) {
      try {
        // Get recent transactions
        const transactions = await getKOLTransactions(kolAddress, 5);
        
        if (!transactions || transactions.length === 0) {
          continue;
        }
        
        // Get last checked signature for this KOL
        const lastSignature = lastTransactionCache[kolAddress];
        
        // Process transactions (newest first)
        for (const tx of transactions) {
          const signature = tx.transaction?.signatures?.[0];
          
          // Skip if we've already processed this transaction
          if (lastSignature && signature === lastSignature) {
            break;
          }
          
          // Parse transaction
          const swapInfo = parseSwapTransaction(tx, kolAddress);
          
          if (swapInfo && swapInfo.tokenMint) {
            // Get token price to calculate market cap
            let tokenPrice = null;
            let marketCap = null;
            try {
              const { getSolanaTokenPrice } = require('../utils/api');
              const priceData = await getSolanaTokenPrice(swapInfo.tokenMint);
              if (priceData && priceData.price) {
                tokenPrice = parseFloat(priceData.price);
                // Calculate market cap (price × 1B supply for Solana tokens)
                marketCap = tokenPrice * 1e9;
              }
            } catch (error) {
              console.log(`Could not fetch price for token ${swapInfo.tokenMint}:`, error.message);
            }
            
            // Format market cap helper
            const formatMarketCap = (value) => {
              if (!value) return 'N/A';
              if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
              if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
              if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}k`;
              return `$${value.toFixed(2)}`;
            };
            
            const kolName = getKOLName(kolAddress) || 'Unknown KOL';
            
            // Check all users to see if they're tracking this KOL or this token
            for (const [chatId, userPrefs] of Object.entries(users)) {
              if (!userPrefs.subscribed) continue;
              
              const trackedKOLs = userPrefs.trackedKOLs || [];
              const isTrackingKOL = trackedKOLs.includes(kolAddress);
              const isTrackingToken = isTrackedToken(swapInfo.tokenMint, userPrefs);
              
              // Send alert if user is tracking this KOL OR this token
              if (isTrackingKOL || isTrackingToken) {
                // Get token info from user's custom tokens
                const tokenInfo = userPrefs.customTokens?.find(t => 
                  t.address?.toLowerCase() === swapInfo.tokenMint.toLowerCase()
                );
                
                const tokenSymbol = tokenInfo?.symbol || swapInfo.tokenMint.substring(0, 8) + '...';
                const action = swapInfo.type === 'buy' ? '🟢 BOUGHT' : '🔴 SOLD';
                
                let message = `🚨 <b>KOL Alert!</b>\n\n` +
                  `${action} <b>$${tokenSymbol.toUpperCase()}</b>\n` +
                  `👤 <b>${kolName}</b>\n` +
                  `💰 Amount: ${swapInfo.tokenAmount.toLocaleString(undefined, { maximumFractionDigits: 4 })} tokens\n` +
                  `💵 SOL: ${swapInfo.solAmount.toFixed(4)} SOL\n`;
                
                // Add market cap if available
                if (marketCap && tokenPrice) {
                  message += `📊 Price: $${tokenPrice.toFixed(8)}\n`;
                  message += `💎 Market Cap: ${formatMarketCap(marketCap)}\n`;
                }
                
                message += `\n🔗 <a href="https://solscan.io/tx/${swapInfo.signature}">View Transaction</a>`;
                
                try {
                  await bot.sendMessage(chatId, message, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                  });
                  console.log(`Sent KOL alert to user ${chatId} for ${kolName}'s ${swapInfo.type} of ${tokenSymbol} at ${formatMarketCap(marketCap)}`);
                } catch (error) {
                  console.error(`Error sending KOL alert to ${chatId}:`, error.message);
                }
              }
            }
          }
          
          // Update last checked signature
          if (!lastSignature || signature !== lastSignature) {
            lastTransactionCache[kolAddress] = signature;
          }
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        console.error(`Error checking transactions for KOL ${kolAddress}:`, error.message);
      }
    }
  } catch (error) {
    console.error('Error in checkKOLTransactions:', error.message);
  }
}

module.exports = {
  checkKOLTransactions
};

