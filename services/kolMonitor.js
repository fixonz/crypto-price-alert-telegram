const axios = require('axios');
const { KOL_ADDRESSES } = require('../config/kol');
const { loadUsers, loadKOLSignatures, saveKOLSignature } = require('../utils/storage');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '2238f591-e4cf-4e28-919a-6e7164a9d0ad';
const HELIUS_BASE_URL = 'https://api-mainnet.helius-rpc.com';

// Get recent transactions for a KOL address using Helius API
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
    
    // Helius API returns transactions in response.data
    let transactions = response.data;
    if (Array.isArray(transactions)) {
      return transactions;
    } else if (transactions && Array.isArray(transactions.transactions)) {
      return transactions.transactions;
    } else if (transactions && Array.isArray(transactions.data)) {
      return transactions.data;
    }
    
    console.log(`⚠️ Unexpected transaction format from Helius for ${kolAddress}:`, typeof transactions, transactions ? Object.keys(transactions) : 'null');
    if (transactions && typeof transactions === 'object') {
      console.log(`  Sample transaction structure:`, JSON.stringify(Object.keys(transactions)).substring(0, 200));
    }
    return [];
  } catch (error) {
    console.error(`Error fetching transactions for KOL ${kolAddress}:`, error.message);
    if (error.response) {
      console.error(`  API Response status: ${error.response.status}`);
      console.error(`  API Response data:`, JSON.stringify(error.response.data).substring(0, 200));
    }
    return [];
  }
}

// Parse transaction to extract token swap information
// Handles Helius API format with tokenTransfers and nativeTransfers
function parseSwapTransaction(tx, kolAddress) {
  try {
    if (!tx) {
      return null;
    }

    // Extract signature (already done in main loop, but keep for safety)
    const signature = tx.signature || tx.transaction?.signatures?.[0] || tx.txHash;
    
    // Check if transaction failed (if error field exists)
    if (tx.type === 'FAILED' || tx.error) {
      return null;
    }

    // Helius Enhanced Transactions API format uses tokenTransfers and nativeTransfers
    const tokenTransfers = tx.tokenTransfers || [];
    const nativeTransfers = tx.nativeTransfers || [];
    const timestamp = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();

    // If no transfers at all, skip
    if (tokenTransfers.length === 0 && nativeTransfers.length === 0) {
      return null;
    }

    // Normalize KOL address for comparison
    const kolAddressLower = kolAddress.toLowerCase();

    // Process native transfers (SOL) - find transfers involving the KOL
    let solChange = 0;
    for (const transfer of nativeTransfers) {
      const from = (transfer.fromUserAccount || transfer.from || '').toLowerCase();
      const to = (transfer.toUserAccount || transfer.to || '').toLowerCase();
      const amount = parseFloat(transfer.amount || 0) / 1e9; // Convert lamports to SOL
      
      if (from === kolAddressLower) {
        solChange -= amount; // SOL sent out
      }
      if (to === kolAddressLower) {
        solChange += amount; // SOL received
      }
    }

    // Process token transfers - find transfers involving the KOL
    const tokenChanges = [];
    for (const transfer of tokenTransfers) {
      const from = (transfer.fromUserAccount || transfer.from || '').toLowerCase();
      const to = (transfer.toUserAccount || transfer.to || '').toLowerCase();
      const mint = transfer.mint || transfer.tokenAddress;
      const amount = parseFloat(transfer.tokenAmount || transfer.amount || 0);
      
      if (!mint) continue;

      // Filter out SOL and stablecoins
      const mintLower = mint.toLowerCase();
      if (mintLower.includes('so11111111111111111111111111111111111111112') || // SOL
          mintLower.includes('epjfwda5hvph1akvd2vndkrefmtwqxar3sqn7kl3ng') || // USDC
          mintLower.includes('es9vfr6n3fmelq3q9hmkyfv8ycbkmahfsn3qycpc')) { // USDT
        continue;
      }

      // Check if KOL is involved in this transfer
      if (from === kolAddressLower || to === kolAddressLower) {
        const change = from === kolAddressLower ? -amount : amount; // Negative if sending, positive if receiving
        
        // Find existing token change or create new one
        let tokenChange = tokenChanges.find(tc => tc.mint.toLowerCase() === mintLower);
        if (!tokenChange) {
          tokenChange = { mint, change: 0 };
          tokenChanges.push(tokenChange);
        }
        tokenChange.change += change;
      }
    }

    // Determine if this is a buy or sell
    // Buy: SOL decreases (negative), token increases (positive)
    // Sell: SOL increases (positive), token decreases (negative)
    let swapType = null;
    let tokenMint = null;
    let amount = 0;
    let solAmount = 0;

    // Find significant token changes (non-stablecoin tokens)
    const significantTokenChanges = tokenChanges.filter(change => Math.abs(change.change) > 0.000001);
    
    if (significantTokenChanges.length > 0 && Math.abs(solChange) > 0.001) {
      const tokenChange = significantTokenChanges[0];
      
      // Buy: SOL goes out (negative), tokens come in (positive)
      if (solChange < -0.001 && tokenChange.change > 0.000001) {
        swapType = 'buy';
        tokenMint = tokenChange.mint;
        amount = tokenChange.change;
        solAmount = Math.abs(solChange);
      } 
      // Sell: SOL comes in (positive), tokens go out (negative)
      else if (solChange > 0.001 && tokenChange.change < -0.000001) {
        swapType = 'sell';
        tokenMint = tokenChange.mint;
        amount = Math.abs(tokenChange.change);
        solAmount = solChange;
      }
    }
    
    if (swapType && tokenMint) {
      return {
        signature: signature || '',
        timestamp: timestamp,
        type: swapType, // 'buy' or 'sell'
        tokenMint: tokenMint,
        tokenAmount: amount,
        solAmount: solAmount,
        owner: null
      };
    }
    
    return null;
  } catch (error) {
    console.error('Error parsing transaction:', error.message);
    console.error('Transaction keys:', tx ? Object.keys(tx).join(', ') : 'null');
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
    
    // Load last processed signatures from persistent storage
    const lastSignatures = await loadKOLSignatures();
    
    // Get all tracked KOL addresses from all users
    const trackedKOLAddresses = new Set();
    for (const [chatId, userPrefs] of Object.entries(users)) {
      if (userPrefs.subscribed && userPrefs.trackedKOLs) {
        userPrefs.trackedKOLs.forEach(address => trackedKOLAddresses.add(address));
      }
    }
    
    // ONLY check explicitly tracked KOLs - don't fetch for all KOLs
    const kolAddresses = Array.from(trackedKOLAddresses);
    
    if (kolAddresses.length === 0) {
      console.log(`🔍 No KOLs being tracked, skipping transaction check...`);
      return;
    }
    
    console.log(`🔍 Checking transactions for ${kolAddresses.length} tracked KOL(s)...`);
    
    for (const kolAddress of kolAddresses) {
      try {
        const kolName = getKOLName(kolAddress) || kolAddress.substring(0, 8) + '...';
        
        // Get recent transactions (increase limit to catch more)
        const transactions = await getKOLTransactions(kolAddress, 10);
        
        if (!transactions || transactions.length === 0) {
          console.log(`  ⚠️ No transactions found for ${kolName}`);
          continue;
        }
        
        console.log(`  📊 Found ${transactions.length} transactions for ${kolName}`);
        
        // Log first transaction structure for debugging
        if (transactions.length > 0) {
          const firstTx = transactions[0];
          console.log(`  🔍 Sample transaction structure:`, {
            hasSignature: !!firstTx.signature,
            hasTxHash: !!firstTx.txHash,
            hasTransaction: !!firstTx.transaction,
            hasTransactionSignatures: !!(firstTx.transaction?.signatures?.[0]),
            hasTokenTransfers: Array.isArray(firstTx.tokenTransfers),
            hasNativeTransfers: Array.isArray(firstTx.nativeTransfers),
            keys: Object.keys(firstTx).slice(0, 10)
          });
        }
        
        // Get last checked signature for this KOL from persistent storage
        const lastSignature = lastSignatures[kolAddress] || null;
        console.log(`  🔑 Last processed signature: ${lastSignature ? lastSignature.substring(0, 16) + '...' : 'None (first check - will process all)'}`);
        
        let newTransactionsFound = 0;
        let newestSignature = null;
        
        // Process transactions (newest first)
        for (const tx of transactions) {
          // Try multiple possible signature locations (Helius format variations)
          let signature = null;
          
          // Try direct signature first
          if (tx.signature) {
            signature = tx.signature;
          } 
          // Try transaction.signatures array
          else if (tx.transaction?.signatures && Array.isArray(tx.transaction.signatures) && tx.transaction.signatures.length > 0) {
            signature = tx.transaction.signatures[0];
          }
          // Try transaction.signature (singular)
          else if (tx.transaction?.signature) {
            signature = tx.transaction.signature;
          }
          // Try txHash (Solscan format)
          else if (tx.txHash) {
            signature = tx.txHash;
          }
          
          if (!signature) {
            console.log(`  ⚠️ Transaction missing signature. Keys:`, Object.keys(tx).join(', '));
            if (tx.transaction) {
              console.log(`    Transaction keys:`, Object.keys(tx.transaction).join(', '));
            }
            continue;
          }
          
          // Track newest signature
          if (!newestSignature) {
            newestSignature = signature;
          }
          
          // Skip if we've already processed this transaction
          if (lastSignature && signature === lastSignature) {
            console.log(`  ✅ Reached last processed transaction, stopping`);
            break;
          }
          
          newTransactionsFound++;
          console.log(`  🔍 Processing new transaction: ${signature.substring(0, 16)}...`);
          
          // Parse transaction
          const swapInfo = parseSwapTransaction(tx, kolAddress);
          
          if (!swapInfo) {
            console.log(`  ⚠️ Transaction ${signature.substring(0, 16)}... is not a swap (no token changes detected)`);
          } else {
            console.log(`  ✅ Swap detected: ${swapInfo.type} ${swapInfo.tokenMint.substring(0, 8)}... (${swapInfo.tokenAmount} tokens, ${swapInfo.solAmount} SOL)`);
          }
          
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
              console.log(`  ⚠️ Could not fetch price for token ${swapInfo.tokenMint}:`, error.message);
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
            let alertSent = false;
            for (const [chatId, userPrefs] of Object.entries(users)) {
              if (!userPrefs.subscribed) continue;
              
              const trackedKOLs = userPrefs.trackedKOLs || [];
              const isTrackingKOL = trackedKOLs.includes(kolAddress);
              const isTrackingToken = isTrackedToken(swapInfo.tokenMint, userPrefs);
              
              console.log(`  👤 User ${chatId}: tracking KOL=${isTrackingKOL}, tracking token=${isTrackingToken}`);
              
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
                  alertSent = true;
                  console.log(`  ✅ Sent KOL alert to user ${chatId} for ${kolName}'s ${swapInfo.type} of ${tokenSymbol} at ${formatMarketCap(marketCap)}`);
                } catch (error) {
                  console.error(`  ❌ Error sending KOL alert to ${chatId}:`, error.message);
                }
              }
            }
            
            if (!alertSent) {
              console.log(`  ⚠️ Swap detected but no users tracking this KOL or token`);
            }
          }
        }
        
        // Update persistent storage with newest signature after processing all new transactions
        if (newestSignature && (!lastSignature || newestSignature !== lastSignature)) {
          await saveKOLSignature(kolAddress, newestSignature);
          console.log(`  💾 Updated last signature for ${kolName}: ${newestSignature.substring(0, 16)}...`);
        }
        
        if (newTransactionsFound > 0) {
          console.log(`  📈 Processed ${newTransactionsFound} new transactions for ${kolName}`);
        } else if (lastSignature) {
          console.log(`  ℹ️ No new transactions for ${kolName} since last check`);
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

