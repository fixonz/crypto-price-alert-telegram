const axios = require('axios');
const { KOL_ADDRESSES } = require('../config/kol');
const { loadUsers, loadKOLSignatures, saveKOLSignature, getKOLTokenBalance, updateKOLTokenBalance, hasAlertedOnTransaction, markTransactionAsAlerted, getKOLCountForToken, getKOLsForToken } = require('../utils/storage');

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
      
      // Enhanced logging for debugging sell detection
      if (Math.abs(solChange) > 0.001 && significantTokenChanges.length > 0) {
        console.log(`    💰 Transaction analysis: SOL change=${solChange.toFixed(4)}, Token change=${tokenChange.change.toFixed(4)}, Type=${swapType || 'UNKNOWN'}`);
      }
    } else if (Math.abs(solChange) > 0.001) {
      // Log when SOL changes but no token swap detected
      console.log(`    ⚠️ SOL change detected (${solChange.toFixed(4)}) but no significant token change found`);
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
        
        // Get recent transactions (increase limit to catch rapid trades)
        const transactions = await getKOLTransactions(kolAddress, 50);
        
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
        
        // Extract signatures and filter to only new transactions
        // Helius returns newest first: [newest, ..., oldest]
        // We need to process only transactions newer than lastSignature, then reverse to process oldest-first
        const newTransactions = [];
        let foundLastSignature = false;
        
        for (const tx of transactions) {
          let sig = tx.signature || tx.transaction?.signatures?.[0] || tx.transaction?.signature || tx.txHash;
          
          if (!sig) continue;
          
          // Track newest signature (first one in the array)
          if (!newestSignature) {
            newestSignature = sig;
          }
          
          // If we hit the last processed signature, we've found all new ones
          if (lastSignature && sig === lastSignature) {
            foundLastSignature = true;
            break; // Stop here, we've collected all new transactions
          }
          
          // This is a new transaction, add it
          newTransactions.push(tx);
        }
        
        // If we didn't find lastSignature, all transactions are new (first run or gap in history)
        if (!foundLastSignature && lastSignature) {
          console.log(`  ⚠️ Last signature not found in current batch, processing all transactions`);
        }
        
        // Reverse to process oldest-first for correct balance tracking
        const transactionsInOrder = newTransactions.reverse();
        
        // Process transactions (oldest first for correct balance tracking)
        for (const tx of transactionsInOrder) {
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
            // Get token price first (needed for PnL calculation and buy price tracking)
            let tokenPrice = null;
            try {
              const { getSolanaTokenPrice } = require('../utils/api');
              const priceData = await getSolanaTokenPrice(swapInfo.tokenMint);
              if (priceData && priceData.price) {
                tokenPrice = parseFloat(priceData.price);
              }
            } catch (error) {
              console.log(`  ⚠️ Could not fetch price for token ${swapInfo.tokenMint}:`, error.message);
            }
            
            // Check if we've already alerted on this transaction
            const alreadyAlerted = await hasAlertedOnTransaction(swapInfo.signature);
            if (alreadyAlerted) {
              console.log(`  ⚠️ Skipping alert: Already alerted on transaction ${swapInfo.signature.substring(0, 16)}...`);
              // Still update balance but don't alert
              const balanceChange = swapInfo.type === 'buy' ? swapInfo.tokenAmount : -swapInfo.tokenAmount;
              await updateKOLTokenBalance(
                kolAddress, 
                swapInfo.tokenMint, 
                balanceChange, 
                swapInfo.signature,
                false, // Don't mark as first buy if we've already alerted
                tokenPrice,
                swapInfo.solAmount
              );
              continue;
            }
            
            // Get current balance BEFORE this transaction
            const currentBalanceRecord = await getKOLTokenBalance(kolAddress, swapInfo.tokenMint);
            const balanceBeforeTx = currentBalanceRecord ? parseFloat(currentBalanceRecord.balance) : 0;
            const costBasis = currentBalanceRecord ? parseFloat(currentBalanceRecord.total_cost_basis || 0) : 0;
            const tokensBought = currentBalanceRecord ? parseFloat(currentBalanceRecord.total_tokens_bought || 0) : 0;
            const isFirstBuy = !currentBalanceRecord || !currentBalanceRecord.first_buy_signature;
            
            // Update token balance AFTER this transaction
            const balanceChange = swapInfo.type === 'buy' ? swapInfo.tokenAmount : -swapInfo.tokenAmount;
            const newBalance = await updateKOLTokenBalance(
              kolAddress, 
              swapInfo.tokenMint, 
              balanceChange, 
              swapInfo.signature,
              isFirstBuy && swapInfo.type === 'buy',
              tokenPrice,
              swapInfo.solAmount
            );
            
            // Check if multiple KOLs have bought this token (for first buys only)
            let kolCount = 0;
            let otherKOLs = [];
            if (swapInfo.type === 'buy' && isFirstBuy) {
              // Get count AFTER updating (includes this KOL now)
              kolCount = await getKOLCountForToken(swapInfo.tokenMint);
              if (kolCount > 1) {
                // Get list of all KOLs who bought this token
                const allKOLs = await getKOLsForToken(swapInfo.tokenMint);
                otherKOLs = allKOLs.filter(addr => addr !== kolAddress).map(addr => getKOLName(addr) || addr.substring(0, 8) + '...');
              }
            }
            
            // Check if this is a complete exit (had tokens before, selling, and balance goes to ~0)
            const isCompleteExit = swapInfo.type === 'sell' && 
                                   balanceBeforeTx > 0.000001 && 
                                   newBalance <= 0.000001; // Consider 0 or very small balance as complete exit
            
            // Enhanced logging for balance tracking
            console.log(`    📊 Balance: ${balanceBeforeTx.toFixed(6)} → ${newBalance.toFixed(6)} | First buy: ${isFirstBuy} | Complete exit: ${isCompleteExit}`);
            
            // Only alert on first-time buys or complete exits
            if (swapInfo.type === 'buy' && !isFirstBuy) {
              console.log(`  ⚠️ Skipping alert: Not a first-time buy (KOL already owns this token, balance before: ${balanceBeforeTx.toFixed(4)})`);
              continue; // Skip repetitive buys
            }
            
            if (swapInfo.type === 'sell' && !isCompleteExit) {
              console.log(`  ⚠️ Skipping alert: Partial sell (KOL had ${balanceBeforeTx.toFixed(4)}, now has ${newBalance.toFixed(4)} tokens)`);
              continue; // Skip partial sells
            }
            
            // Log for debugging
            if (isCompleteExit) {
              console.log(`  ✅ Complete exit detected: Balance went from ${balanceBeforeTx.toFixed(4)} to ${newBalance.toFixed(4)}`);
            }
            
            // Get token info (name, symbol)
            let tokenInfo = null;
            let marketCap = null;
            
            try {
              const { getSolanaTokenInfo } = require('../utils/api');
              
              // Fetch token metadata (name, symbol)
              tokenInfo = await getSolanaTokenInfo(swapInfo.tokenMint);
              
              // Calculate market cap if we have price
              if (tokenPrice) {
                marketCap = tokenPrice * 1e9; // Calculate market cap (price × 1B supply for Solana tokens)
              }
            } catch (error) {
              console.log(`  ⚠️ Could not fetch token info for ${swapInfo.tokenMint}:`, error.message);
            }
            
            // Calculate PnL for sells
            let pnl = null;
            let pnlPercentage = null;
            if (swapInfo.type === 'sell' && tokenPrice && costBasis > 0 && tokensBought > 0) {
              // Calculate average buy price
              const avgBuyPrice = costBasis / tokensBought; // Average cost per token in SOL
              
              // Calculate sell value in SOL
              const sellValueSOL = swapInfo.solAmount;
              
              // Calculate cost basis for sold tokens (proportional)
              const tokensSold = swapInfo.tokenAmount;
              const soldCostBasis = (tokensSold / tokensBought) * costBasis;
              
              // Calculate PnL
              pnl = sellValueSOL - soldCostBasis; // PnL in SOL
              pnlPercentage = soldCostBasis > 0 ? ((pnl / soldCostBasis) * 100) : 0;
            }
            
            // Format market cap helper
            const formatMarketCap = (value) => {
              if (!value) return 'N/A';
              if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
              if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
              if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}k`;
              return `$${value.toFixed(2)}`;
            };
            
            // Format token amount helper (e.g., 1m, 1.5k) - lowercase for display
            const formatTokenAmount = (amount) => {
              if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}b`;
              if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}m`;
              if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}k`;
              return amount.toFixed(4);
            };
            
            const kolName = getKOLName(kolAddress) || 'Unknown KOL';
            const tokenName = tokenInfo?.name || 'Unknown Token';
            const tokenSymbol = (tokenInfo?.symbol || swapInfo.tokenMint.substring(0, 8)).toUpperCase();
            const tokenAddress = swapInfo.tokenMint;
            
            // Determine alert type and message prefix
            let alertPrefix = '';
            if (isFirstBuy && swapInfo.type === 'buy') {
              if (kolCount >= 2) {
                // Multiple KOLs detected - this is more significant
                alertPrefix = `🔥 ${kolCount} KOLs - `;
              } else {
                // First KOL to buy - only alert if user is tracking this specific KOL
                // (We'll filter this in the user loop)
                alertPrefix = '🆕 FIRST BUY - ';
              }
            } else if (isCompleteExit) {
              alertPrefix = '🚪 COMPLETE EXIT - ';
            }
            
            // Format timestamp for display
            const txTimestamp = swapInfo.timestamp || new Date();
            const formattedTime = txTimestamp.toLocaleString('en-US', {
              month: 'short',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit',
              second: '2-digit',
              hour12: false
            });
            
            // For multi-KOL buys, cache the list of KOLs who bought this token (only fetch once, not per user)
            let allKOLsForToken = [];
            const isMultiKOLBuy = kolCount >= 2 && swapInfo.type === 'buy' && isFirstBuy;
            if (isMultiKOLBuy) {
              allKOLsForToken = await getKOLsForToken(swapInfo.tokenMint);
              console.log(`  🔥 Multi-KOL buy detected: ${kolCount} KOLs bought ${tokenSymbol}`);
            }
            
            // Check all users to see if they're tracking this KOL or this token
            let alertSent = false;
            for (const [chatId, userPrefs] of Object.entries(users)) {
              if (!userPrefs.subscribed) continue;
              
              const trackedKOLs = userPrefs.trackedKOLs || [];
              const isTrackingKOL = trackedKOLs.includes(kolAddress);
              const isTrackingToken = isTrackedToken(swapInfo.tokenMint, userPrefs);
              
              // For multi-KOL buys, check if user tracks any of the KOLs who bought this token
              let tracksAnyKOLInToken = false;
              if (isMultiKOLBuy) {
                tracksAnyKOLInToken = allKOLsForToken.some(addr => trackedKOLs.includes(addr));
              }
              
              console.log(`  👤 User ${chatId}: tracking KOL=${isTrackingKOL}, tracking token=${isTrackingToken}, multi-KOL=${isMultiKOLBuy ? kolCount : 0}`);
              
              // Send alert if:
              // 1. User is tracking this specific KOL OR token, OR
              // 2. Multiple KOLs (2+) bought it AND user tracks at least one of those KOLs
              const shouldAlert = isTrackingKOL || isTrackingToken || (isMultiKOLBuy && tracksAnyKOLInToken);
              
              if (shouldAlert) {
                const buyEmoji = '🟢';
                const sellEmoji = '🔴';
                const actionEmoji = swapInfo.type === 'buy' ? buyEmoji : sellEmoji;
                
                // Build message in requested format
                let message = '';
                
                // First line: KOL NAME 🟢/🔴 $SYMBOL @ Mcap
                if (marketCap && tokenPrice) {
                  message += `<b>${kolName}</b> ${actionEmoji} <b>$${tokenSymbol}</b> @ ${formatMarketCap(marketCap)}\n`;
                } else {
                  message += `<b>${kolName}</b> ${actionEmoji} <b>$${tokenSymbol}</b>\n`;
                }
                
                // Show other KOLs if multiple KOLs bought this token
                if (kolCount >= 2 && swapInfo.type === 'buy' && otherKOLs.length > 0) {
                  message += `\n🔥 <b>${kolCount} KOLs</b> in this token:\n`;
                  message += `• ${kolName}\n`;
                  otherKOLs.forEach(otherKol => {
                    message += `• ${otherKol}\n`;
                  });
                  message += `\n`;
                }
                
                // Amount tokens
                message += `${formatTokenAmount(swapInfo.tokenAmount)} tokens\n`;
                
                // SOL paid
                message += `${swapInfo.solAmount.toFixed(4)} SOL\n`;
                
                // HOLDS
                message += `\nHOLDS: `;
                if (newBalance > 0.000001) {
                  message += `${formatTokenAmount(newBalance)} $${tokenSymbol}\n`;
                } else {
                  message += `0 $${tokenSymbol}\n`;
                }
                
                // PnL (only for sells)
                if (swapInfo.type === 'sell' && pnl !== null && pnlPercentage !== null) {
                  const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
                  const pnlSign = pnl >= 0 ? '+' : '';
                  message += `\nPnL: ${pnlEmoji} ${pnlSign}${pnl.toFixed(4)} SOL (${pnlSign}${pnlPercentage.toFixed(2)}%)\n`;
                }
                
                // Contract
                message += `\n<code>${tokenAddress}</code>\n`;
                
                // Links section
                message += `\n`;
                message += `<a href="https://solscan.io/tx/${swapInfo.signature}">Solscan</a> | `;
                message += `<a href="https://gmgn.ai/sol/token/${tokenAddress}">GMGN</a> | `;
                message += `<a href="https://padre.gg/token/${tokenAddress}">PADRE</a> | `;
                message += `<a href="https://axiom.xyz/token/${tokenAddress}">AXIOM</a> | `;
                message += `<a href="https://dexscreener.com/solana/${tokenAddress}">DEX</a>`;
                
                try {
                  await bot.sendMessage(chatId, message, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                  });
                  alertSent = true;
                  
                  // Mark this transaction as alerted
                  await markTransactionAsAlerted(swapInfo.signature, kolAddress, swapInfo.tokenMint);
                  
                  const alertType = isFirstBuy ? 'FIRST BUY' : isCompleteExit ? 'COMPLETE EXIT' : swapInfo.type.toUpperCase();
                  console.log(`  ✅ Sent KOL alert to user ${chatId} for ${kolName}'s ${alertType} of ${tokenName} ($${tokenSymbol})`);
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

