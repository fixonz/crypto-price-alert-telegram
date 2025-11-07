const axios = require('axios');
const { KOL_ADDRESSES } = require('../config/kol');
const { loadUsers, loadKOLSignatures, saveKOLSignature, getKOLTokenBalance, updateKOLTokenBalance, hasAlertedOnTransaction, markTransactionAsAlerted, getKOLCountForToken, getKOLsForToken, saveKOLTransaction, getKOLTransactionHistory, calculateHoldTime, calculateRealizedPnL, analyzeTokenPattern, saveTokenPerformance, updateKOLBehaviorPattern, detectKOLDeviation, updateKOLActivityPattern } = require('../utils/storage');

const HELIUS_API_KEY = process.env.HELIUS_API_KEY || '2238f591-e4cf-4e28-919a-6e7164a9d0ad';
const HELIUS_BASE_URL = 'https://api-mainnet.helius-rpc.com';

// Queue for buy alerts that need to wait 1 minute before sending
// Format: { kolAddress, tokenMint, groupData, timestamp, message, tokenInfo }
const pendingBuyAlerts = new Map();

// Helper function to format token amounts
function formatTokenAmount(amount) {
  if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}b`;
  if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}m`;
  if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}k`;
  return amount.toFixed(2);
}

// Check pending buy alerts and send them if 1 minute has passed
// If a sell happened within that minute, include it in the same alert
async function processPendingBuyAlerts(bot) {
  const now = Date.now();
  const oneMinute = 60 * 1000;
  
  for (const [key, alert] of pendingBuyAlerts.entries()) {
    const timeElapsed = now - alert.timestamp;
    
    // If 1 minute has passed, check for sells and send combined alert
    if (timeElapsed >= oneMinute) {
      try {
        // Check if a sell happened for this KOL/token within the last minute
        const recentSells = await getKOLTransactionHistory(alert.kolAddress, alert.tokenMint, 10);
        const sellsAfterBuy = recentSells.filter(tx => 
          tx.transaction_type === 'sell' && 
          tx.timestamp > alert.timestamp / 1000 && // Sell happened after buy
          tx.timestamp <= (alert.timestamp + oneMinute) / 1000 // Within 1 minute
        );
        
        let finalMessage = alert.message;
        
        // If sells happened, modify the message to include sell info
        if (sellsAfterBuy.length > 0) {
          console.log(`  🔄 Buy + ${sellsAfterBuy.length} sell(s) detected within 1 minute - sending combined alert for ${alert.tokenMint.substring(0, 8)}...`);
          
          // Calculate total sell amounts
          const totalSellTokens = sellsAfterBuy.reduce((sum, tx) => sum + parseFloat(tx.token_amount || 0), 0);
          const totalSellSol = sellsAfterBuy.reduce((sum, tx) => sum + parseFloat(tx.sol_amount || 0), 0);
          
          // Modify message to show it's a mixed buy+sell
          // Change emoji from 🟢 to 🔄
          finalMessage = finalMessage.replace(/🟢/g, '🔄');
          
          // Add sell section before HOLDS
          const holdsIndex = finalMessage.indexOf('HOLDS:');
          if (holdsIndex !== -1) {
            const sellSection = `\n<b>SELLS (within 1 min):</b>\n` +
              `${formatTokenAmount(totalSellTokens)} tokens\n` +
              `${totalSellSol.toFixed(4)} SOL\n`;
            finalMessage = finalMessage.slice(0, holdsIndex) + sellSection + finalMessage.slice(holdsIndex);
          }
        } else {
          console.log(`  ✅ Buy passed 1-minute test (no sell detected) - sending alert for ${alert.tokenMint.substring(0, 8)}...`);
        }
        
        // Send alert to all users
        const users = await loadUsers();
        for (const [chatId, userPrefs] of Object.entries(users)) {
          if (userPrefs.subscribed) {
            // Check if user wants KOL alerts (default to true if not set)
            const wantsKolAlerts = userPrefs.kolAlerts !== false;
            
            if (wantsKolAlerts) {
              try {
                if (alert.tokenInfo && alert.tokenInfo.imageUrl) {
                  await bot.sendPhoto(chatId, alert.tokenInfo.imageUrl, {
                    caption: finalMessage,
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                  });
                } else {
                  await bot.sendMessage(chatId, finalMessage, {
                    parse_mode: 'HTML',
                    disable_web_page_preview: true
                  });
                }
                
                // Mark sell transactions as alerted if any
                if (sellsAfterBuy.length > 0) {
                  for (const sellTx of sellsAfterBuy) {
                    await markTransactionAsAlerted(sellTx.signature, alert.kolAddress, alert.tokenMint);
                  }
                }
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
        
        // Remove from queue
        pendingBuyAlerts.delete(key);
      } catch (error) {
        console.log(`  ⚠️ Error processing pending buy alert:`, error.message);
        // Remove from queue on error to prevent infinite retries
        pendingBuyAlerts.delete(key);
      }
    }
  }
}

// Fetch transaction details from Solscan API to get actual swap amounts
// This is a fallback when Helius doesn't provide accurate SOL amounts
async function fetchTransactionFromSolscan(signature) {
  try {
    const response = await axios.get(
      `https://api.solscan.io/transaction?tx=${signature}`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        timeout: 10000
      }
    );
    
    if (response.data && response.data.success !== false) {
      // Parse Solscan transaction format
      const tx = response.data;
      
      // Look for SOL transfer amounts in the transaction
      // Solscan format might have balanceChanges or transfers
      if (tx.balanceChanges) {
        for (const change of tx.balanceChanges) {
          if (change.change && change.change > 0) {
            const solAmount = Math.abs(parseFloat(change.change)) / 1e9;
            if (solAmount > 0.01) {
              return solAmount;
            }
          }
        }
      }
      
      // Check transfers array
      if (tx.transfers && Array.isArray(tx.transfers)) {
        let totalSolReceived = 0;
        for (const transfer of tx.transfers) {
          if (transfer.symbol === 'SOL' && transfer.dst && transfer.amount) {
            const amount = parseFloat(transfer.amount);
            if (amount > 0.01) {
              totalSolReceived += amount;
            }
          }
        }
        if (totalSolReceived > 0.01) {
          return totalSolReceived;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.log(`    ⚠️ Could not fetch from Solscan for ${signature}:`, error.message);
    return null;
  }
}

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
async function parseSwapTransaction(tx, kolAddress) {
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
    const events = tx.events || []; // Check for events that might contain swap amounts
    const innerInstructions = tx.innerInstructions || tx.transaction?.meta?.innerInstructions || [];
    const timestamp = tx.timestamp ? new Date(tx.timestamp * 1000) : new Date();
    const description = tx.description || '';
    
    // Try to extract SOL amount from description (Helius sometimes includes this)
    let solAmountFromDescription = null;
    if (description) {
      // Look for patterns like "for X SOL" or "X SOL" or "received X SOL" in description
      // Try multiple patterns
      const patterns = [
        /(\d+\.?\d*)\s*SOL/i, // Simple "X SOL"
        /for\s+(\d+\.?\d*)\s*SOL/i, // "for X SOL"
        /received\s+(\d+\.?\d*)\s*SOL/i, // "received X SOL"
        /(\d+\.?\d*)\s*SOL\s+for/i, // "X SOL for"
        /swap.*?(\d+\.?\d*)\s*SOL/i // "swap ... X SOL"
      ];
      
      for (const pattern of patterns) {
        const match = description.match(pattern);
        if (match) {
          const amount = parseFloat(match[1]);
          // Only use if it's a reasonable amount (> 0.01 SOL, not fees)
          if (amount > 0.01) {
            solAmountFromDescription = amount;
            break;
          }
        }
      }
    }
    
    // Check events for Pump.fun swap data
    let solAmountFromEvents = null;
    for (const event of events) {
      // Pump.fun events might have solAmount field
      if (event.solAmount || event.sol_amount) {
        const amount = parseFloat(event.solAmount || event.sol_amount || 0) / 1e9; // Convert lamports to SOL
        if (amount > 0.01 && (!solAmountFromEvents || amount > solAmountFromEvents)) {
          solAmountFromEvents = amount;
        }
      }
      // Check event data/attributes
      if (event.data && typeof event.data === 'object') {
        if (event.data.solAmount) {
          const amount = parseFloat(event.data.solAmount) / 1e9;
          if (amount > 0.01 && (!solAmountFromEvents || amount > solAmountFromEvents)) {
            solAmountFromEvents = amount;
          }
        }
        if (event.data.sol_amount) {
          const amount = parseFloat(event.data.sol_amount) / 1e9;
          if (amount > 0.01 && (!solAmountFromEvents || amount > solAmountFromEvents)) {
            solAmountFromEvents = amount;
          }
        }
      }
    }
    
    // Check inner instructions for swap amounts
    let solAmountFromInnerInstructions = null;
    for (const inner of innerInstructions) {
      if (inner.instructions && Array.isArray(inner.instructions)) {
        for (const instruction of inner.instructions) {
          // Look for transfer instructions with large amounts
          if (instruction.parsed && instruction.parsed.type === 'transfer') {
            const amount = parseFloat(instruction.parsed.info?.lamports || 0) / 1e9;
            const to = (instruction.parsed.info?.destination || '').toLowerCase();
            if (to === kolAddressLower && amount > 0.01 && (!solAmountFromInnerInstructions || amount > solAmountFromInnerInstructions)) {
              solAmountFromInnerInstructions = amount;
            }
          }
        }
      }
    }
    
    // Check transaction description for swap indicators (Helius often includes this)
    const isSwapDescription = description.toLowerCase().includes('swap') || 
                              description.toLowerCase().includes('sell') ||
                              description.toLowerCase().includes('buy') ||
                              description.toLowerCase().includes('axiom') || // Axiom trading platform
                              description.toLowerCase().includes('pump.fun') ||
                              description.toLowerCase().includes('raydium') ||
                              description.toLowerCase().includes('jupiter');

    // If no transfers at all, skip
    if (tokenTransfers.length === 0 && nativeTransfers.length === 0) {
      return null;
    }

    // Normalize KOL address for comparison
    const kolAddressLower = kolAddress.toLowerCase();

    // Process native transfers (SOL) - find transfers involving the KOL
    let solChange = 0;
    let solReceived = 0; // Track total SOL received (for sell PnL calculation)
    let solSent = 0; // Track total SOL sent (for debugging)
    let largestSolReceived = 0; // Track largest single SOL transfer received (likely the swap amount)
    const significantSolReceived = []; // Track all significant SOL transfers received (> 0.01 SOL)
    
    for (const transfer of nativeTransfers) {
      const from = (transfer.fromUserAccount || transfer.from || '').toLowerCase();
      const to = (transfer.toUserAccount || transfer.to || '').toLowerCase();
      const amount = parseFloat(transfer.amount || 0) / 1e9; // Convert lamports to SOL
      
      if (from === kolAddressLower) {
        solChange -= amount; // SOL sent out
        solSent += amount;
      }
      if (to === kolAddressLower) {
        solChange += amount; // SOL received
        solReceived += amount;
        // Track largest SOL transfer received (swap amount is usually much larger than fees)
        if (amount > largestSolReceived) {
          largestSolReceived = amount;
        }
        // Track significant transfers (likely swap proceeds, not fees)
        if (amount > 0.01) {
          significantSolReceived.push(amount);
        }
      }
    }
    
    // For sells, sum up all significant SOL received (swap might be split across multiple transfers)
    const totalSignificantSolReceived = significantSolReceived.reduce((sum, amt) => sum + amt, 0);

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
    
    // Improved detection: Check multiple scenarios
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
        // For sells, prioritize: events > inner instructions > description > totalSignificantSolReceived > largestSolReceived > solReceived > solChange
        // Events and inner instructions are usually most accurate for Pump.fun swaps
        if (solAmountFromEvents && solAmountFromEvents > 0.01) {
          solAmount = solAmountFromEvents;
        } else if (solAmountFromInnerInstructions && solAmountFromInnerInstructions > 0.01) {
          solAmount = solAmountFromInnerInstructions;
        } else if (solAmountFromDescription && solAmountFromDescription > 0.1) {
          solAmount = solAmountFromDescription;
        } else if (totalSignificantSolReceived > 0.1) {
          solAmount = totalSignificantSolReceived;
        } else if (largestSolReceived > 0.1) {
          solAmount = largestSolReceived;
        } else if (solReceived > 0.1) {
          solAmount = solReceived;
        } else {
          solAmount = solChange; // Fallback to net change
        }
        
        // Sanity check: if sell amount seems suspiciously low for the token amount, try Solscan
        // If we're selling a significant amount of tokens (> 1M) but SOL received is < 0.1, something is wrong
        if (amount > 1000000 && solAmount < 0.1 && signature) {
          console.log(`    ⚠️ Suspiciously low SOL amount for sell: ${solAmount.toFixed(4)} SOL for ${amount.toFixed(0)} tokens. Fetching from Solscan...`);
          try {
            const solscanAmount = await fetchTransactionFromSolscan(signature);
            if (solscanAmount && solscanAmount > solAmount) {
              console.log(`    ✅ Solscan found better amount: ${solscanAmount.toFixed(4)} SOL (was ${solAmount.toFixed(4)})`);
              solAmount = solscanAmount;
            }
          } catch (error) {
            console.log(`    ⚠️ Solscan fetch failed:`, error.message);
          }
        }
        
        console.log(`    💰 Sell SOL detection: events=${solAmountFromEvents || 'N/A'}, inner=${solAmountFromInnerInstructions || 'N/A'}, desc=${solAmountFromDescription || 'N/A'}, significant=${totalSignificantSolReceived.toFixed(4)}, largest=${largestSolReceived.toFixed(4)}, total=${solReceived.toFixed(4)}, net=${solChange.toFixed(4)}, using=${solAmount.toFixed(4)}`);
      }
      // Edge case: Both SOL and tokens going out - might be a sell with fees or wrapped SOL
      // If tokens are going out significantly, it's likely a sell (SOL might be wrapped differently)
      else if (solChange < -0.001 && tokenChange.change < -0.000001 && Math.abs(tokenChange.change) > 1000) {
        // Large token amount going out = likely a sell
        // SOL going out might be fees or wrapped SOL conversion
        // Check if there's SOL received (might be wrapped differently or in a different transfer)
        swapType = 'sell';
        tokenMint = tokenChange.mint;
        amount = Math.abs(tokenChange.change);
        // For this edge case, if we have SOL received, use it; otherwise estimate from token amount
        solAmount = totalSignificantSolReceived > 0.1 ? totalSignificantSolReceived : (largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : Math.abs(solChange)));
        console.log(`    ⚠️ Sell detected (both SOL and tokens out): tokens=${amount.toFixed(2)}, SOL significant=${totalSignificantSolReceived.toFixed(4)}, SOL largest=${largestSolReceived.toFixed(4)}, SOL received=${solReceived.toFixed(4)}, SOL net=${solChange.toFixed(4)}`);
      }
      // Edge case: SOL comes in but token change is small (might be wrapped SOL or fees)
      // Check if description indicates a sell
      else if (solChange > 0.001 && isSwapDescription && description.toLowerCase().includes('sell')) {
        // Likely a sell but token transfer might be wrapped differently
        // Use the first significant token change (even if small)
        swapType = 'sell';
        tokenMint = tokenChange.mint;
        amount = Math.abs(tokenChange.change);
        solAmount = totalSignificantSolReceived > 0.1 ? totalSignificantSolReceived : (largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : solChange));
        console.log(`    ⚠️ Sell detected via description: ${description.substring(0, 50)}`);
      }
      
      // Enhanced logging for debugging sell detection
      if (Math.abs(solChange) > 0.001 && significantTokenChanges.length > 0) {
        console.log(`    💰 Transaction analysis: SOL change=${solChange.toFixed(4)}, Token change=${tokenChange.change.toFixed(4)}, Type=${swapType || 'UNKNOWN'}, Desc="${description.substring(0, 40)}"`);
      }
    } 
    // Alternative detection: Large token amount going out (even if SOL also going out)
    // This handles cases where SOL fees are deducted separately
    if (!swapType && significantTokenChanges.length > 0) {
      const tokenChange = significantTokenChanges[0];
      // If large amount of tokens going out, it's likely a sell (SOL might be wrapped or fees)
      if (tokenChange.change < -1000 && Math.abs(solChange) > 0.001) {
        swapType = 'sell';
        tokenMint = tokenChange.mint;
        amount = Math.abs(tokenChange.change);
        // Prefer SOL received over net change for accurate PnL
        solAmount = totalSignificantSolReceived > 0.1 ? totalSignificantSolReceived : (largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : Math.abs(solChange)));
        console.log(`    ⚠️ Sell detected (large token out): ${amount.toFixed(2)} tokens, SOL significant=${totalSignificantSolReceived.toFixed(4)}, SOL largest=${largestSolReceived.toFixed(4)}, SOL received=${solReceived.toFixed(4)}, SOL net=${solChange.toFixed(4)}`);
      }
    }
    
    // Alternative detection: SOL comes in with swap description but no token transfers visible
    // This might happen if tokens are burned or transferred differently
    if (!swapType && solChange > 0.001 && isSwapDescription && description.toLowerCase().includes('sell')) {
      // Try to find ANY token transfer (even if filtered out)
      const allTokenTransfers = tx.tokenTransfers || [];
      for (const transfer of allTokenTransfers) {
        const from = (transfer.fromUserAccount || transfer.from || '').toLowerCase();
        const mint = transfer.mint || transfer.tokenAddress;
        if (from === kolAddressLower && mint) {
          const mintLower = mint.toLowerCase();
          // Skip SOL and stablecoins
          if (!mintLower.includes('so11111111111111111111111111111111111111112') &&
              !mintLower.includes('epjfwda5hvph1akvd2vndkrefmtwqxar3sqn7kl3ng') &&
              !mintLower.includes('es9vfr6n3fmelq3q9hmkyfv8ycbkmahfsn3qycpc')) {
            swapType = 'sell';
            tokenMint = mint;
            amount = parseFloat(transfer.tokenAmount || transfer.amount || 0);
            solAmount = totalSignificantSolReceived > 0.1 ? totalSignificantSolReceived : (largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : solChange));
            console.log(`    ⚠️ Sell detected via description fallback: token=${mint.substring(0, 8)}...`);
            break;
          }
        }
      }
    }
    
    if (!swapType && Math.abs(solChange) > 0.001) {
      // Log when SOL changes but no token swap detected
      console.log(`    ⚠️ SOL change detected (${solChange.toFixed(4)}) but no significant token change found. Description: "${description.substring(0, 60)}"`);
      
      // Enhanced detection: Check if description suggests a swap even without visible token transfers
      // This handles cases where tokens might be burned, wrapped differently, or transfers aren't visible
      if (solChange > 0.001 && isSwapDescription) {
        // SOL received + swap description = likely a sell
        // Try to find ANY token transfer from KOL (even if small or filtered)
        const allTokenTransfers = tx.tokenTransfers || [];
        let foundTokenTransfer = false;
        
        for (const transfer of allTokenTransfers) {
          const from = (transfer.fromUserAccount || transfer.from || '').toLowerCase();
          const mint = transfer.mint || transfer.tokenAddress;
          const amount = parseFloat(transfer.tokenAmount || transfer.amount || 0);
          
          if (from === kolAddressLower && mint && amount > 0) {
            const mintLower = mint.toLowerCase();
            // Skip SOL and stablecoins
            if (!mintLower.includes('so11111111111111111111111111111111111111112') &&
                !mintLower.includes('epjfwda5hvph1akvd2vndkrefmtwqxar3sqn7kl3ng') &&
                !mintLower.includes('es9vfr6n3fmelq3q9hmkyfv8ycbkmahfsn3qycpc')) {
              swapType = 'sell';
              tokenMint = mint;
              // Use amount even if small (might be partial sell or wrapped differently)
              amount = amount;
              solAmount = totalSignificantSolReceived > 0.1 ? totalSignificantSolReceived : (largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : solChange));
              foundTokenTransfer = true;
              console.log(`    ✅ Sell detected via description + token transfer: token=${mint.substring(0, 8)}..., amount=${amount.toFixed(2)}, SOL=${solAmount.toFixed(4)}`);
              break;
            }
          }
        }
        
        // If no token transfer found but description strongly suggests swap, log for investigation
        if (!foundTokenTransfer) {
          console.log(`    🔍 SOL received (${solChange.toFixed(4)}) with swap-like description but no token transfers found. This might be a fee payment or wrapped SOL transfer.`);
        }
      }
      
      // Log token transfers for debugging
      if (tokenTransfers.length > 0) {
        console.log(`    🔍 Token transfers: ${tokenTransfers.length} transfers found`);
        tokenTransfers.slice(0, 3).forEach((transfer, idx) => {
          const from = (transfer.fromUserAccount || transfer.from || '').toLowerCase();
          const to = (transfer.toUserAccount || transfer.to || '').toLowerCase();
          const isKOLInvolved = from === kolAddressLower || to === kolAddressLower;
          console.log(`      Transfer ${idx + 1}: ${isKOLInvolved ? 'KOL INVOLVED' : 'other'}, from=${from.substring(0, 8)}..., to=${to.substring(0, 8)}..., amount=${transfer.tokenAmount || transfer.amount || 0}, mint=${(transfer.mint || transfer.tokenAddress || 'N/A').substring(0, 8)}...`);
        });
      } else {
        console.log(`    🔍 No token transfers found in transaction`);
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
        solReceived: solReceived, // Store SOL received for PnL calculation
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

// Group transactions by token within a timeframe (includes both buys and sells)
// Groups transactions for the same token within GROUP_TIME_WINDOW_MS, regardless of type
function groupTransactions(parsedTransactions, groupTimeWindowMs = 120000) { // Default: 2 minutes
  if (parsedTransactions.length === 0) return [];
  
  const groups = [];
  let currentGroup = null;
  
  for (const tx of parsedTransactions) {
    if (!tx.swapInfo) continue; // Skip non-swap transactions
    
    const txTime = tx.swapInfo.timestamp ? tx.swapInfo.timestamp.getTime() : Date.now();
    const groupKey = tx.swapInfo.tokenMint; // Group by token only, not by type
    
    // Start a new group if:
    // 1. No current group exists
    // 2. Different token
    // 3. Time gap is too large
    if (!currentGroup || 
        currentGroup.key !== groupKey ||
        (txTime - currentGroup.lastTime) > groupTimeWindowMs) {
      
      // Save previous group if it exists
      if (currentGroup) {
        groups.push(currentGroup);
      }
      
      // Start new group
      currentGroup = {
        key: groupKey,
        tokenMint: tx.swapInfo.tokenMint,
        transactions: [tx],
        firstTime: txTime,
        lastTime: txTime,
        buys: [],
        sells: [],
        totalBuyTokenAmount: 0,
        totalSellTokenAmount: 0,
        totalBuySolAmount: 0,
        totalSellSolAmount: 0,
        signatures: [tx.swapInfo.signature]
      };
      
      // Add transaction to appropriate type array
      if (tx.swapInfo.type === 'buy') {
        currentGroup.buys.push(tx);
        currentGroup.totalBuyTokenAmount += tx.swapInfo.tokenAmount;
        currentGroup.totalBuySolAmount += tx.swapInfo.solAmount;
      } else {
        currentGroup.sells.push(tx);
        currentGroup.totalSellTokenAmount += tx.swapInfo.tokenAmount;
        currentGroup.totalSellSolAmount += tx.swapInfo.solAmount;
      }
    } else {
      // Add to current group
      currentGroup.transactions.push(tx);
      currentGroup.lastTime = Math.max(currentGroup.lastTime, txTime);
      currentGroup.signatures.push(tx.swapInfo.signature);
      
      // Add to appropriate type array
      if (tx.swapInfo.type === 'buy') {
        currentGroup.buys.push(tx);
        currentGroup.totalBuyTokenAmount += tx.swapInfo.tokenAmount;
        currentGroup.totalBuySolAmount += tx.swapInfo.solAmount;
      } else {
        currentGroup.sells.push(tx);
        currentGroup.totalSellTokenAmount += tx.swapInfo.tokenAmount;
        currentGroup.totalSellSolAmount += tx.swapInfo.solAmount;
      }
    }
  }
  
  // Don't forget the last group
  if (currentGroup) {
    groups.push(currentGroup);
  }
  
  return groups;
}

// Monitor KOL transactions and send alerts
async function checkKOLTransactions(bot) {
  try {
    // Process pending buy alerts first (check if 1 minute has passed)
    try {
      await processPendingBuyAlerts(bot);
    } catch (error) {
      console.error('Error processing pending buy alerts:', error.message);
      // Don't stop the main flow if pending alerts fail
    }
    
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
        
        // Step 1: Parse all transactions first
        const parsedTransactions = [];
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
            continue;
          }
          
          newTransactionsFound++;
          console.log(`  🔍 Parsing transaction: ${signature.substring(0, 16)}...`);
          
          // Parse transaction
          const swapInfo = await parseSwapTransaction(tx, kolAddress);
          
          if (swapInfo && swapInfo.tokenMint) {
            parsedTransactions.push({ tx, signature, swapInfo });
            console.log(`  ✅ Swap detected: ${swapInfo.type} ${swapInfo.tokenMint.substring(0, 8)}... (${swapInfo.tokenAmount} tokens, ${swapInfo.solAmount} SOL)`);
          } else {
            console.log(`  ⚠️ Transaction ${signature.substring(0, 16)}... is not a swap (no token changes detected)`);
          }
        }
        
        // Step 2: Group transactions by type, token, and timeframe
        const transactionGroups = groupTransactions(parsedTransactions, 120000); // 2 minutes grouping window
        console.log(`  📦 Grouped ${parsedTransactions.length} transactions into ${transactionGroups.length} groups`);
        
        // Step 3: Process each group
        for (const group of transactionGroups) {
          const isGrouped = group.transactions.length > 1;
          const groupHasSells = group.sells.length > 0;
          const groupHasBuys = group.buys.length > 0;
          const groupType = groupHasSells ? 'sell' : 'buy';
          console.log(`  📦 Processing group: ${groupHasBuys ? group.buys.length + ' buy(s)' : ''}${groupHasBuys && groupHasSells ? ' + ' : ''}${groupHasSells ? group.sells.length + ' sell(s)' : ''} for token ${group.tokenMint.substring(0, 8)}...`);
          
          // Process all transactions in the group sequentially (for balance tracking)
          // But collect data for a single aggregated alert
          let balanceBeforeGroup = null;
          let newBalanceAfterGroup = null;
          let costBasis = 0;
          let tokensBought = 0;
          let isFirstBuy = false;
          let tokenPrice = null;
          let tokenInfo = null;
          let marketCap = null;
          let allAlreadyAlerted = true;
          
          // Process each transaction in the group to update balances
          for (const parsedTx of group.transactions) {
            const swapInfo = parsedTx.swapInfo;
            
            // Check if we've already alerted on any transaction in this group
            const alreadyAlerted = await hasAlertedOnTransaction(swapInfo.signature);
            if (!alreadyAlerted) {
              allAlreadyAlerted = false;
            }
            
            // Get balance before first transaction in group
            if (balanceBeforeGroup === null) {
              const currentBalanceRecord = await getKOLTokenBalance(kolAddress, swapInfo.tokenMint);
              balanceBeforeGroup = currentBalanceRecord ? parseFloat(currentBalanceRecord.balance) : 0;
              costBasis = currentBalanceRecord ? parseFloat(currentBalanceRecord.total_cost_basis || 0) : 0;
              tokensBought = currentBalanceRecord ? parseFloat(currentBalanceRecord.total_tokens_bought || 0) : 0;
              isFirstBuy = !currentBalanceRecord || !currentBalanceRecord.first_buy_signature;
            }
            
            // Get token price and market cap (fetch once per group)
            if (!tokenPrice) {
              try {
                const { getSolanaTokenPrice, getSolanaTokenInfo } = require('../utils/api');
                const priceData = await getSolanaTokenPrice(swapInfo.tokenMint);
                if (priceData && priceData.price) {
                  tokenPrice = parseFloat(priceData.price);
                }
                
                // Get token info for market cap
                if (!tokenInfo) {
                  tokenInfo = await getSolanaTokenInfo(swapInfo.tokenMint);
                  if (tokenInfo && tokenInfo.marketCap) {
                    marketCap = parseFloat(tokenInfo.marketCap);
                  } else if (tokenPrice) {
                    // Calculate market cap from price (Solana tokens have 1B supply)
                    marketCap = tokenPrice * 1e9;
                  }
                }
              } catch (error) {
                console.log(`  ⚠️ Could not fetch price/market cap for token ${swapInfo.tokenMint}:`, error.message);
              }
            }
            
            // Save transaction to database for pattern analysis
            const txTimestampUnix = swapInfo.timestamp ? Math.floor(swapInfo.timestamp.getTime() / 1000) : Math.floor(Date.now() / 1000);
            try {
              await saveKOLTransaction(
                swapInfo.signature,
                kolAddress,
                swapInfo.tokenMint,
                swapInfo.type,
                swapInfo.tokenAmount,
                swapInfo.solAmount,
                tokenPrice,
                txTimestampUnix,
                marketCap // Store market cap at buy time
              );
              
              // Track activity pattern (hourly activity)
              await updateKOLActivityPattern(kolAddress, txTimestampUnix);
            } catch (error) {
              console.log(`  ⚠️ Could not save transaction for pattern analysis:`, error.message);
            }
            
            // Update token balance for this transaction
            const balanceChange = swapInfo.type === 'buy' ? swapInfo.tokenAmount : -swapInfo.tokenAmount;
            newBalanceAfterGroup = await updateKOLTokenBalance(
              kolAddress, 
              swapInfo.tokenMint, 
              balanceChange, 
              swapInfo.signature,
              isFirstBuy && swapInfo.type === 'buy' && parsedTx === group.transactions[0], // Only mark first transaction as first buy
              tokenPrice,
              swapInfo.solAmount
            );
            
            // Update cost basis and tokens bought for next iteration
            const currentBalanceRecord = await getKOLTokenBalance(kolAddress, swapInfo.tokenMint);
            costBasis = currentBalanceRecord ? parseFloat(currentBalanceRecord.total_cost_basis || 0) : 0;
            tokensBought = currentBalanceRecord ? parseFloat(currentBalanceRecord.total_tokens_bought || 0) : 0;
          }
          
          // Skip alert if all transactions in group were already alerted
          if (allAlreadyAlerted) {
            console.log(`  ⚠️ Skipping group alert: All transactions already alerted`);
            continue;
          }
          
          // Determine primary action: if there are sells, prioritize sells; otherwise show buys
          const hasSells = group.sells.length > 0;
          const hasBuys = group.buys.length > 0;
          const primaryType = hasSells ? 'sell' : 'buy';
          const isMixed = hasSells && hasBuys;
          
          // Get aggregated swap info from group
          const groupSwapInfo = {
            type: primaryType,
            tokenMint: group.tokenMint,
            tokenAmount: hasSells ? group.totalSellTokenAmount : group.totalBuyTokenAmount,
            solAmount: hasSells ? group.totalSellSolAmount : group.totalBuySolAmount,
            signature: group.signatures[0], // Use first signature as primary
            signatures: group.signatures, // All signatures for links
            timestamp: new Date(group.firstTime),
            isMixed: isMixed,
            buyCount: group.buys.length,
            sellCount: group.sells.length,
            totalBuyTokenAmount: group.totalBuyTokenAmount,
            totalSellTokenAmount: group.totalSellTokenAmount,
            totalBuySolAmount: group.totalBuySolAmount,
            totalSellSolAmount: group.totalSellSolAmount
          };
          
          // Get token info (name, symbol) - fetch once per group
          if (!tokenInfo) {
            try {
              const { getSolanaTokenInfo } = require('../utils/api');
              tokenInfo = await getSolanaTokenInfo(groupSwapInfo.tokenMint);
              
              // Calculate market cap if we have price
              if (tokenPrice) {
                marketCap = tokenPrice * 1e9; // Calculate market cap (price × 1B supply for Solana tokens)
                
                // Save performance snapshot for long-term analysis
                try {
                  await saveTokenPerformance(groupSwapInfo.tokenMint, tokenPrice, marketCap, null);
                } catch (error) {
                  console.log(`  ⚠️ Could not save performance snapshot:`, error.message);
                }
              }
            } catch (error) {
              console.log(`  ⚠️ Could not fetch token info for ${groupSwapInfo.tokenMint}:`, error.message);
            }
          }
          
          // Check if multiple KOLs have bought this token
          let kolCount = 0;
          let otherKOLs = [];
          if (groupSwapInfo.type === 'buy') {
            kolCount = await getKOLCountForToken(groupSwapInfo.tokenMint);
            if (kolCount > 1) {
              const allKOLs = await getKOLsForToken(groupSwapInfo.tokenMint);
              otherKOLs = allKOLs.filter(addr => addr !== kolAddress).map(addr => getKOLName(addr) || addr.substring(0, 8) + '...');
            }
          }
          
          // Check if this is a complete exit
          const isCompleteExit = groupSwapInfo.type === 'sell' && 
                                 balanceBeforeGroup > 0.000001 && 
                                 newBalanceAfterGroup <= 0.000001;
          
          // Calculate hold time for sells
          let holdTime = null;
          if (groupSwapInfo.type === 'sell') {
            holdTime = await calculateHoldTime(kolAddress, groupSwapInfo.tokenMint);
          }
          
          // Analyze market cap at buy time (detect farming behavior - buying at very low market cap)
          let marketCapAnalysis = null;
          if (hasBuys && marketCap) {
            try {
              // Get KOL's historical buy market caps to compare
              const history = await getKOLTransactionHistory(kolAddress, null, 100); // Get all recent transactions
              const buyHistory = history.filter(tx => tx.transaction_type === 'buy' && tx.market_cap);
              
              if (buyHistory.length > 0) {
                const historicalMarketCaps = buyHistory.map(tx => parseFloat(tx.market_cap || 0)).filter(mc => mc > 0);
                
                if (historicalMarketCaps.length > 0) {
                  const avgMarketCap = historicalMarketCaps.reduce((a, b) => a + b, 0) / historicalMarketCaps.length;
                  const medianMarketCap = [...historicalMarketCaps].sort((a, b) => a - b)[Math.floor(historicalMarketCaps.length / 2)];
                  const minMarketCap = Math.min(...historicalMarketCaps);
                  
                  // Check if current buy is at unusually low market cap
                  // Threshold: < 50% of average or < $10k (very early stage)
                  const isLowMarketCap = marketCap < (avgMarketCap * 0.5) || marketCap < 10000;
                  const isVeryLowMarketCap = marketCap < 5000; // Ultra-early, likely farming
                  
                  // Calculate percentile
                  const sortedCaps = [...historicalMarketCaps].sort((a, b) => a - b);
                  const percentile = (sortedCaps.filter(mc => mc <= marketCap).length / sortedCaps.length) * 100;
                  
                  marketCapAnalysis = {
                    currentMarketCap: marketCap,
                    avgMarketCap: avgMarketCap,
                    medianMarketCap: medianMarketCap,
                    minMarketCap: minMarketCap,
                    percentile: percentile,
                    isLowMarketCap: isLowMarketCap,
                    isVeryLowMarketCap: isVeryLowMarketCap,
                    historicalCount: historicalMarketCaps.length
                  };
                } else {
                  // First buy or no historical data - still check if very low
                  marketCapAnalysis = {
                    currentMarketCap: marketCap,
                    isLowMarketCap: marketCap < 10000,
                    isVeryLowMarketCap: marketCap < 5000,
                    historicalCount: 0
                  };
                }
              } else {
                // First buy for this KOL - check if very low
                marketCapAnalysis = {
                  currentMarketCap: marketCap,
                  isLowMarketCap: marketCap < 10000,
                  isVeryLowMarketCap: marketCap < 5000,
                  historicalCount: 0
                };
              }
            } catch (error) {
              console.log(`  ⚠️ Could not analyze market cap:`, error.message);
            }
          }
          
          // Analyze instant flips (buy then sell within 1 minute in same group)
          let instantFlipAnalysis = null;
          if (isMixed && group.buys.length > 0 && group.sells.length > 0) {
            // Sort buys and sells by timestamp
            const sortedBuys = [...group.buys].sort((a, b) => {
              const timeA = a.swapInfo.timestamp ? a.swapInfo.timestamp.getTime() : 0;
              const timeB = b.swapInfo.timestamp ? b.swapInfo.timestamp.getTime() : 0;
              return timeA - timeB;
            });
            const sortedSells = [...group.sells].sort((a, b) => {
              const timeA = a.swapInfo.timestamp ? a.swapInfo.timestamp.getTime() : 0;
              const timeB = b.swapInfo.timestamp ? b.swapInfo.timestamp.getTime() : 0;
              return timeA - timeB;
            });
            
            const instantFlips = [];
            const flipTimes = [];
            
            // Check each sell against buys to find instant flips
            for (const sell of sortedSells) {
              const sellTime = sell.swapInfo.timestamp ? sell.swapInfo.timestamp.getTime() : Date.now();
              
              // Find the most recent buy before this sell
              for (let i = sortedBuys.length - 1; i >= 0; i--) {
                const buy = sortedBuys[i];
                const buyTime = buy.swapInfo.timestamp ? buy.swapInfo.timestamp.getTime() : Date.now();
                const timeDiff = (sellTime - buyTime) / 1000; // seconds
                
                if (timeDiff >= 0 && timeDiff <= 60) { // Within 1 minute
                  instantFlips.push({
                    buyTime: buyTime,
                    sellTime: sellTime,
                    timeDiff: timeDiff,
                    buyAmount: buy.swapInfo.tokenAmount,
                    sellAmount: sell.swapInfo.tokenAmount,
                    buySol: buy.swapInfo.solAmount,
                    sellSol: sell.swapInfo.solAmount
                  });
                  flipTimes.push(timeDiff);
                  break; // Found matching buy, move to next sell
                }
              }
            }
            
            if (instantFlips.length > 0) {
              const avgFlipTime = flipTimes.reduce((a, b) => a + b, 0) / flipTimes.length;
              const fastestFlip = Math.min(...flipTimes);
              const totalFlipPnL = instantFlips.reduce((sum, flip) => {
                return sum + (flip.sellSol - flip.buySol);
              }, 0);
              
              instantFlipAnalysis = {
                count: instantFlips.length,
                avgTime: avgFlipTime,
                fastestTime: fastestFlip,
                totalPnL: totalFlipPnL,
                isInstantFlip: fastestFlip < 60, // True if any flip is under 1 minute
                flips: instantFlips
              };
            }
          }
          
          // Get transaction statistics for this token
          let txStats = null;
          try {
            const history = await getKOLTransactionHistory(kolAddress, groupSwapInfo.tokenMint, 1000);
            const buys = history.filter(tx => tx.transaction_type === 'buy');
            const sells = history.filter(tx => tx.transaction_type === 'sell');
            const totalBuys = buys.length;
            const totalSells = sells.length;
            const totalBuyAmount = buys.reduce((sum, tx) => sum + parseFloat(tx.sol_amount || 0), 0);
            const totalSellAmount = sells.reduce((sum, tx) => sum + parseFloat(tx.sol_amount || 0), 0);
            
            txStats = {
              totalTx: totalBuys + totalSells,
              buys: totalBuys,
              sells: totalSells,
              totalBuyAmount,
              totalSellAmount
            };
          } catch (error) {
            console.log(`  ⚠️ Could not get transaction stats:`, error.message);
          }
          
          // Analyze token pattern
          let tokenPattern = null;
          try {
            tokenPattern = await analyzeTokenPattern(groupSwapInfo.tokenMint);
          } catch (error) {
            console.log(`  ⚠️ Could not analyze token pattern:`, error.message);
          }
          
          // Detect KOL behavior deviations
          let behaviorDeviations = null;
          try {
            behaviorDeviations = await detectKOLDeviation(
              kolAddress,
              groupSwapInfo.type,
              groupSwapInfo.solAmount,
              groupSwapInfo.tokenMint
            );
            
            // Add instant flip deviation if detected
            if (instantFlipAnalysis && instantFlipAnalysis.isInstantFlip) {
              if (!behaviorDeviations) {
                behaviorDeviations = [];
              }
              behaviorDeviations.push({
                type: 'instant_flip',
                message: `⚡ Instant flip detected: ${instantFlipAnalysis.count} flip${instantFlipAnalysis.count > 1 ? 's' : ''} within ${instantFlipAnalysis.fastestTime.toFixed(1)}s - ${instantFlipAnalysis.fastestTime < 10 ? 'ULTRA-FAST (scalping?)' : 'Quick profit-taking'}`,
                severity: instantFlipAnalysis.fastestTime < 10 ? 'high' : 'medium'
              });
            }
            
            // Add low market cap farming deviation if detected
            if (marketCapAnalysis && marketCapAnalysis.isVeryLowMarketCap && hasBuys) {
              if (!behaviorDeviations) {
                behaviorDeviations = [];
              }
              behaviorDeviations.push({
                type: 'low_mcap_farming',
                message: `🚨 Ultra-low market cap buy (${formatMarketCap(marketCapAnalysis.currentMarketCap)}) - Possible farming copy traders!`,
                severity: 'high'
              });
            } else if (marketCapAnalysis && marketCapAnalysis.isLowMarketCap && hasBuys && marketCapAnalysis.historicalCount > 0) {
              if (!behaviorDeviations) {
                behaviorDeviations = [];
              }
              behaviorDeviations.push({
                type: 'low_mcap_buy',
                message: `⚠️ Low market cap buy (${formatMarketCap(marketCapAnalysis.currentMarketCap)}) - ${marketCapAnalysis.percentile.toFixed(0)}th percentile vs historical`,
                severity: 'medium'
              });
            }
            
            // Update behavior pattern after group
            await updateKOLBehaviorPattern(kolAddress);
          } catch (error) {
            console.log(`  ⚠️ Could not detect behavior deviation:`, error.message);
          }
          
          // Calculate PnL for sells using FIFO (more accurate than average cost basis)
          let pnl = null;
          let pnlPercentage = null;
          let cumulativePnL = null;
          let cumulativePnLPercentage = null;
          
          if (groupSwapInfo.type === 'sell') {
            // Calculate cumulative realized PnL using FIFO matching
            try {
              const realizedPnLData = await calculateRealizedPnL(kolAddress, groupSwapInfo.tokenMint);
              cumulativePnL = realizedPnLData.realizedPnL;
              cumulativePnLPercentage = realizedPnLData.realizedPnLPercentage;
              
              // For this specific sell, calculate PnL using FIFO
              // Get transaction history and match this sell against buys
              const history = await getKOLTransactionHistory(kolAddress, groupSwapInfo.tokenMint, 1000);
              const sortedHistory = [...history].sort((a, b) => a.timestamp - b.timestamp);
              
              const buyQueue = [];
              let sellCostBasis = 0;
              let tokensToSell = groupSwapInfo.tokenAmount;
              
              // Build buy queue and process all transactions up to this sell
              for (const tx of sortedHistory) {
                if (tx.signature === groupSwapInfo.signature) break; // Stop at current sell
                
                if (tx.transaction_type === 'buy') {
                  buyQueue.push({
                    tokens: parseFloat(tx.token_amount || 0),
                    costBasis: parseFloat(tx.sol_amount || 0)
                  });
                } else if (tx.transaction_type === 'sell') {
                  // Process previous sells to consume buys (FIFO)
                  let prevTokensToSell = parseFloat(tx.token_amount || 0);
                  while (prevTokensToSell > 0.000001 && buyQueue.length > 0) {
                    const oldestBuy = buyQueue[0];
                    if (oldestBuy.tokens <= prevTokensToSell) {
                      prevTokensToSell -= oldestBuy.tokens;
                      buyQueue.shift();
                    } else {
                      oldestBuy.tokens -= prevTokensToSell;
                      oldestBuy.costBasis -= (oldestBuy.costBasis * (prevTokensToSell / (oldestBuy.tokens + prevTokensToSell)));
                      prevTokensToSell = 0;
                    }
                  }
                }
              }
              
              // Match this sell against remaining buys using FIFO
              while (tokensToSell > 0.000001 && buyQueue.length > 0) {
                const oldestBuy = buyQueue[0];
                
                if (oldestBuy.tokens <= tokensToSell) {
                  sellCostBasis += oldestBuy.costBasis;
                  tokensToSell -= oldestBuy.tokens;
                  buyQueue.shift();
                } else {
                  const proportion = tokensToSell / oldestBuy.tokens;
                  sellCostBasis += oldestBuy.costBasis * proportion;
                  oldestBuy.tokens -= tokensToSell;
                  oldestBuy.costBasis -= oldestBuy.costBasis * proportion;
                  tokensToSell = 0;
                }
              }
              
              // Calculate PnL for this specific sell
              if (sellCostBasis > 0) {
                pnl = groupSwapInfo.solAmount - sellCostBasis;
                pnlPercentage = ((pnl / sellCostBasis) * 100);
              }
            } catch (error) {
              console.log(`  ⚠️ Could not calculate FIFO PnL:`, error.message);
              // Fallback to simple calculation if FIFO fails
              if (tokenPrice && costBasis > 0 && tokensBought > 0) {
                const tokensSold = groupSwapInfo.tokenAmount;
                const soldCostBasis = (tokensSold / tokensBought) * costBasis;
                pnl = groupSwapInfo.solAmount - soldCostBasis;
                pnlPercentage = soldCostBasis > 0 ? ((pnl / soldCostBasis) * 100) : 0;
              }
            }
          }
          
          // Format helpers
          const formatMarketCap = (value) => {
            if (!value) return 'N/A';
            if (value >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
            if (value >= 1e6) return `$${(value / 1e6).toFixed(2)}M`;
            if (value >= 1e3) return `$${(value / 1e3).toFixed(2)}k`;
            return `$${value.toFixed(2)}`;
          };
          
          const formatTokenAmount = (amount) => {
            if (amount >= 1e9) return `${(amount / 1e9).toFixed(2)}b`;
            if (amount >= 1e6) return `${(amount / 1e6).toFixed(2)}m`;
            if (amount >= 1e3) return `${(amount / 1e3).toFixed(2)}k`;
            return amount.toFixed(4);
          };
          
          const kolName = getKOLName(kolAddress) || 'Unknown KOL';
          const tokenName = tokenInfo?.name || 'Unknown Token';
          const tokenSymbol = (tokenInfo?.symbol || groupSwapInfo.tokenMint.substring(0, 8)).toUpperCase();
          const tokenAddress = groupSwapInfo.tokenMint;
          
          // Determine alert prefix
          const isGoodTokenAlert = tokenPattern && tokenPattern.isGoodToken;
          let alertPrefix = '';
          if (isGoodTokenAlert) {
            alertPrefix = '⭐ GOOD TOKEN PATTERN - ';
          } else if (isFirstBuy && groupSwapInfo.type === 'buy') {
            if (kolCount >= 2) {
              alertPrefix = `🔥 ${kolCount} KOLs - `;
            } else {
              alertPrefix = '🆕 FIRST BUY - ';
            }
          } else if (groupSwapInfo.type === 'buy') {
            alertPrefix = '🟢 BUY - ';
          } else if (isCompleteExit) {
            alertPrefix = '🚪 COMPLETE EXIT - ';
          } else if (groupSwapInfo.type === 'sell') {
            alertPrefix = '🔴 SELL - ';
          }
          
          // Format timestamp
          const formattedTime = groupSwapInfo.timestamp.toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
          });
          
          // Build alert message
          const buyEmoji = '🟢';
          const sellEmoji = '🔴';
          // Use mixed emoji if both buys and sells
          const actionEmoji = groupSwapInfo.isMixed ? '🔄' : (groupSwapInfo.type === 'buy' ? buyEmoji : sellEmoji);
          
          let message = '';
          
          // First line: KOL NAME 🟢/🔴/🔄 $SYMBOL @ Mcap
          if (marketCap && tokenPrice) {
            message += `<b>${kolName}</b> ${actionEmoji} <b>$${tokenSymbol}</b> @ ${formatMarketCap(marketCap)}\n`;
          } else {
            message += `<b>${kolName}</b> ${actionEmoji} <b>$${tokenSymbol}</b>\n`;
          }
          
          // Show grouped indicator if multiple transactions
          if (isGrouped || groupSwapInfo.isMixed) {
            const txCount = group.transactions.length;
            const parts = [];
            if (groupSwapInfo.buyCount > 0) parts.push(`${groupSwapInfo.buyCount} buy${groupSwapInfo.buyCount > 1 ? 's' : ''}`);
            if (groupSwapInfo.sellCount > 0) parts.push(`${groupSwapInfo.sellCount} sell${groupSwapInfo.sellCount > 1 ? 's' : ''}`);
            message += `📦 <b>${txCount} transaction${txCount > 1 ? 's' : ''} grouped</b> (${parts.join(' + ')})\n`;
          }
          
          // Timestamp
          message += `🕐 ${formattedTime}\n`;
          
          // Show other KOLs if multiple KOLs bought this token
          if (kolCount >= 2 && hasBuys && otherKOLs.length > 0) {
            message += `\n🔥 <b>${kolCount} KOLs</b> in this token:\n`;
            message += `• ${kolName}\n`;
            otherKOLs.forEach(otherKol => {
              message += `• ${otherKol}\n`;
            });
            message += `\n`;
          }
          
          // Show buys and sells separately if mixed
          if (groupSwapInfo.isMixed) {
            message += `\n<b>BUYS:</b>\n`;
            message += `${formatTokenAmount(groupSwapInfo.totalBuyTokenAmount)} tokens\n`;
            message += `${groupSwapInfo.totalBuySolAmount.toFixed(4)} SOL\n`;
            message += `\n<b>SELLS:</b>\n`;
            message += `${formatTokenAmount(groupSwapInfo.totalSellTokenAmount)} tokens\n`;
            message += `${groupSwapInfo.totalSellSolAmount.toFixed(4)} SOL\n`;
          } else {
            // Single type transaction
            message += `${formatTokenAmount(groupSwapInfo.tokenAmount)} tokens\n`;
            message += `${groupSwapInfo.solAmount.toFixed(4)} SOL\n`;
          }
          
          // HOLDS
          message += `\nHOLDS: `;
          if (newBalanceAfterGroup > 0.000001) {
            message += `${formatTokenAmount(newBalanceAfterGroup)} $${tokenSymbol}\n`;
          } else {
            message += `0 $${tokenSymbol}\n`;
          }
          
          // Show transaction statistics if multiple transactions
          if (txStats && txStats.totalTx > 1) {
            message += `\n📊 <b>Token Stats:</b>\n`;
            message += `• ${txStats.buys} buy(s): ${txStats.totalBuyAmount.toFixed(4)} SOL\n`;
            message += `• ${txStats.sells} sell(s): ${txStats.totalSellAmount.toFixed(4)} SOL\n`;
            if (cumulativePnL !== null) {
              const cumPnLEmoji = cumulativePnL >= 0 ? '🟢' : '🔴';
              const cumPnLSign = cumulativePnL >= 0 ? '+' : '';
              message += `• Total PnL: ${cumPnLEmoji} ${cumPnLSign}${cumulativePnL.toFixed(4)} SOL (${cumPnLSign}${cumulativePnLPercentage.toFixed(2)}%)\n`;
            }
          }
          
          // Hold time (for sells)
          if (groupSwapInfo.type === 'sell' && holdTime !== null) {
            const holdTimeFormatted = holdTime < 60 
              ? `${holdTime.toFixed(1)}s` 
              : holdTime < 3600 
                ? `${(holdTime / 60).toFixed(1)}m` 
                : `${(holdTime / 3600).toFixed(1)}h`;
            message += `\n⏱️ Hold time: ${holdTimeFormatted}\n`;
          }
          
          // Instant flip analysis (buy then sell within 1 minute)
          if (instantFlipAnalysis && instantFlipAnalysis.isInstantFlip) {
            const fastestTimeFormatted = instantFlipAnalysis.fastestTime < 1
              ? `${(instantFlipAnalysis.fastestTime * 1000).toFixed(0)}ms`
              : instantFlipAnalysis.fastestTime < 60
                ? `${instantFlipAnalysis.fastestTime.toFixed(1)}s`
                : `${(instantFlipAnalysis.fastestTime / 60).toFixed(1)}m`;
            const avgTimeFormatted = instantFlipAnalysis.avgTime < 1
              ? `${(instantFlipAnalysis.avgTime * 1000).toFixed(0)}ms`
              : instantFlipAnalysis.avgTime < 60
                ? `${instantFlipAnalysis.avgTime.toFixed(1)}s`
                : `${(instantFlipAnalysis.avgTime / 60).toFixed(1)}m`;
            
            message += `\n⚡ <b>INSTANT FLIP DETECTED!</b>\n`;
            message += `• ${instantFlipAnalysis.count} flip${instantFlipAnalysis.count > 1 ? 's' : ''} within 1 minute\n`;
            message += `• Fastest: ${fastestTimeFormatted}\n`;
            message += `• Avg time: ${avgTimeFormatted}\n`;
            
            if (instantFlipAnalysis.totalPnL !== 0) {
              const flipPnLEmoji = instantFlipAnalysis.totalPnL >= 0 ? '🟢' : '🔴';
              const flipPnLSign = instantFlipAnalysis.totalPnL >= 0 ? '+' : '';
              message += `• Flip PnL: ${flipPnLEmoji} ${flipPnLSign}${instantFlipAnalysis.totalPnL.toFixed(4)} SOL\n`;
            }
            
            // Add warning if instant flip is very fast (< 10 seconds)
            if (instantFlipAnalysis.fastestTime < 10) {
              message += `\n⚠️ <b>ULTRA-FAST FLIP</b> - Possible scalping or low confidence!\n`;
            }
          } else if (instantFlipAnalysis && !instantFlipAnalysis.isInstantFlip) {
            // Show flip analysis even if not instant (for reference)
            const fastestTimeFormatted = instantFlipAnalysis.fastestTime < 60
              ? `${instantFlipAnalysis.fastestTime.toFixed(1)}s`
              : `${(instantFlipAnalysis.fastestTime / 60).toFixed(1)}m`;
            message += `\n📊 <b>Flip Analysis:</b>\n`;
            message += `• ${instantFlipAnalysis.count} buy→sell pair${instantFlipAnalysis.count > 1 ? 's' : ''} detected\n`;
            message += `• Fastest flip: ${fastestTimeFormatted}\n`;
          }
          
          // PnL (only for sells) - show both this transaction and cumulative
          if (groupSwapInfo.type === 'sell' && (pnl !== null || cumulativePnL !== null)) {
            // Only show individual transaction PnL if not showing cumulative in stats section
            if (!txStats || txStats.totalTx <= 1) {
              if (pnl !== null && pnlPercentage !== null) {
                const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
                const pnlSign = pnl >= 0 ? '+' : '';
                message += `\nPnL (this tx): ${pnlEmoji} ${pnlSign}${pnl.toFixed(4)} SOL (${pnlSign}${pnlPercentage.toFixed(2)}%)\n`;
              }
            } else if (pnl !== null && pnlPercentage !== null) {
              // Show individual PnL even if we have stats (for grouped transactions)
              const pnlEmoji = pnl >= 0 ? '🟢' : '🔴';
              const pnlSign = pnl >= 0 ? '+' : '';
              message += `\nPnL (this group): ${pnlEmoji} ${pnlSign}${pnl.toFixed(4)} SOL (${pnlSign}${pnlPercentage.toFixed(2)}%)\n`;
            }
            
            // Show cumulative PnL if available and not already shown in stats
            if (cumulativePnL !== null && cumulativePnLPercentage !== null && (!txStats || txStats.totalTx <= 1)) {
              const cumPnLEmoji = cumulativePnL >= 0 ? '🟢' : '🔴';
              const cumPnLSign = cumulativePnL >= 0 ? '+' : '';
              message += `PnL (cumulative): ${cumPnLEmoji} ${cumPnLSign}${cumulativePnL.toFixed(4)} SOL (${cumPnLSign}${cumulativePnLPercentage.toFixed(2)}%)\n`;
            }
          }
          
          // Pattern analysis
          if (tokenPattern && tokenPattern.isGoodToken) {
            message += `\n⭐ <b>GOOD TOKEN PATTERN:</b>\n`;
            message += `• ${tokenPattern.kolCount} KOLs involved\n`;
            message += `• ${tokenPattern.holdingKOLs} still holding\n`;
            if (tokenPattern.avgHoldTime) {
              const avgHoldFormatted = tokenPattern.avgHoldTime < 60 
                ? `${tokenPattern.avgHoldTime.toFixed(1)}s` 
                : `${(tokenPattern.avgHoldTime / 60).toFixed(1)}m`;
              message += `• Avg hold: ${avgHoldFormatted}\n`;
            }
          }
          
          // Market cap analysis (farming detection) - show before behavior deviations
          if (marketCapAnalysis && hasBuys) {
            const mcapFormatted = formatMarketCap(marketCapAnalysis.currentMarketCap);
            
            if (marketCapAnalysis.isVeryLowMarketCap) {
              message += `\n🚨 <b>ULTRA-LOW MARKET CAP BUY!</b>\n`;
              message += `• Market Cap: ${mcapFormatted}\n`;
              message += `• ⚠️ <b>POSSIBLE FARMING</b> - Buying at very early stage to farm copy traders!\n`;
            } else if (marketCapAnalysis.isLowMarketCap && marketCapAnalysis.historicalCount > 0) {
              message += `\n⚠️ <b>LOW MARKET CAP BUY</b>\n`;
              message += `• Market Cap: ${mcapFormatted}\n`;
              if (marketCapAnalysis.avgMarketCap) {
                message += `• Avg buy mcap: ${formatMarketCap(marketCapAnalysis.avgMarketCap)}\n`;
                message += `• ${marketCapAnalysis.percentile.toFixed(0)}th percentile (lower than usual)\n`;
              }
              message += `• Possible farming behavior\n`;
            } else if (marketCapAnalysis.historicalCount > 0 && marketCapAnalysis.avgMarketCap) {
              // Show market cap context even if not suspicious
              message += `\n📊 Market Cap: ${mcapFormatted}\n`;
              message += `• ${marketCapAnalysis.percentile.toFixed(0)}th percentile vs historical buys\n`;
            }
          } else if (marketCap && hasBuys) {
            // Show market cap if available but no analysis
            message += `\n📊 Market Cap: ${formatMarketCap(marketCap)}\n`;
          }
          
          // Behavior deviations
          if (behaviorDeviations && behaviorDeviations.length > 0) {
            message += `\n🚨 <b>BEHAVIOR DEVIATION:</b>\n`;
            behaviorDeviations.forEach(dev => {
              message += `• ${dev.message}\n`;
            });
          }
          
          // Contract
          message += `\n<code>${tokenAddress}</code>\n`;
          
          // Links section - show first transaction link, or all if grouped
          message += `\n`;
          if (isGrouped) {
            message += `<a href="https://solscan.io/tx/${group.signatures[0]}">Solscan (1st)</a> | `;
            if (group.signatures.length > 1) {
              message += `<a href="https://solscan.io/tx/${group.signatures[group.signatures.length - 1]}">Solscan (last)</a> | `;
            }
          } else {
            message += `<a href="https://solscan.io/tx/${groupSwapInfo.signature}">Solscan</a> | `;
          }
          message += `<a href="https://gmgn.ai/sol/token/${tokenAddress}">GMGN</a> | `;
          message += `<a href="https://padre.gg/token/${tokenAddress}">PADRE</a> | `;
          message += `<a href="https://axiom.xyz/token/${tokenAddress}">AXIOM</a> | `;
          message += `<a href="https://dexscreener.com/solana/${tokenAddress}">DEX</a>`;
          
          // For buys: queue for 1-minute delay (to filter out instant flips)
          // For sells: send immediately
          if (hasBuys && !hasSells) {
            // Pure buy - queue for 1-minute delay
            const alertKey = `${kolAddress}_${groupSwapInfo.tokenMint}_${groupSwapInfo.timestamp.getTime()}`;
            pendingBuyAlerts.set(alertKey, {
              kolAddress,
              tokenMint: groupSwapInfo.tokenMint,
              timestamp: groupSwapInfo.timestamp.getTime(),
              message,
              tokenInfo,
              groupSignatures: group.signatures
            });
            console.log(`  ⏳ Buy alert queued (1-minute delay) for ${tokenName} ($${tokenSymbol})`);
            
            // Mark transactions as alerted (so we don't re-process them)
            for (const sig of group.signatures) {
              await markTransactionAsAlerted(sig, kolAddress, groupSwapInfo.tokenMint);
            }
          } else {
            // Sell or mixed - send immediately
            let alertSent = false;
            for (const [chatId, userPrefs] of Object.entries(users)) {
              if (!userPrefs.subscribed) continue;
              
              const trackedKOLs = userPrefs.trackedKOLs || [];
              const isTrackingKOL = trackedKOLs.includes(kolAddress);
              const isTrackingToken = isTrackedToken(groupSwapInfo.tokenMint, userPrefs);
              
              const shouldAlert = isTrackingKOL || isTrackingToken || (kolCount >= 2 && groupSwapInfo.type === 'buy') || isGoodTokenAlert;
              
              if (shouldAlert) {
                try {
                  // Send message with token image if available
                  if (tokenInfo && tokenInfo.imageUrl) {
                    // Send photo with caption
                    await bot.sendPhoto(chatId, tokenInfo.imageUrl, {
                      caption: message,
                      parse_mode: 'HTML',
                      disable_web_page_preview: true
                    });
                  } else {
                    // Fallback to text-only message if no image
                    await bot.sendMessage(chatId, message, {
                      parse_mode: 'HTML',
                      disable_web_page_preview: true
                    });
                  }
                  alertSent = true;
                  
                  // Mark all transactions in group as alerted
                  for (const sig of group.signatures) {
                    await markTransactionAsAlerted(sig, kolAddress, groupSwapInfo.tokenMint);
                  }
                  
                  const alertType = isGrouped ? `${group.transactions.length} ${groupSwapInfo.type.toUpperCase()}S` : groupSwapInfo.type.toUpperCase();
                  console.log(`  ✅ Sent grouped KOL alert to user ${chatId} for ${kolName}'s ${alertType} of ${tokenName} ($${tokenSymbol})`);
                } catch (error) {
                  console.error(`  ❌ Error sending KOL alert to ${chatId}:`, error.message);
                }
              }
            }
            
            if (!alertSent) {
              console.log(`  ⚠️ Group detected but no users tracking this KOL or token`);
            }
          }
        }
        
        // Update persistent storage with newest signature after processing all groups
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
    console.error('Stack trace:', error.stack);
  }
}

module.exports = {
  checkKOLTransactions
};
