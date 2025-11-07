const axios = require('axios');
const { KOL_ADDRESSES } = require('../config/kol');
const { loadUsers, loadKOLSignatures, saveKOLSignature, getKOLTokenBalance, updateKOLTokenBalance, hasAlertedOnTransaction, markTransactionAsAlerted, getKOLCountForToken, getKOLsForToken, saveKOLTransaction, getKOLTransactionHistory, calculateHoldTime, calculateRealizedPnL, analyzeTokenPattern, saveTokenPerformance, updateKOLBehaviorPattern, detectKOLDeviation, updateKOLActivityPattern } = require('../utils/storage');

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
    const description = tx.description || '';
    
    // Check transaction description for swap indicators (Helius often includes this)
    const isSwapDescription = description.toLowerCase().includes('swap') || 
                              description.toLowerCase().includes('sell') ||
                              description.toLowerCase().includes('buy');

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
        // For sells, prefer largest SOL received (swap amount) over total received
        // Fees are typically small (< 0.1 SOL), so largest transfer is likely the swap
        // Fallback to total received if largest is suspiciously small
        if (largestSolReceived > 0.1) {
          solAmount = largestSolReceived;
        } else if (solReceived > 0) {
          solAmount = solReceived;
        } else {
          solAmount = solChange;
        }
        console.log(`    💰 Sell SOL detection: largest=${largestSolReceived.toFixed(4)}, total=${solReceived.toFixed(4)}, net=${solChange.toFixed(4)}, using=${solAmount.toFixed(4)}`);
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
        solAmount = largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : Math.abs(solChange));
        console.log(`    ⚠️ Sell detected (both SOL and tokens out): tokens=${amount.toFixed(2)}, SOL largest=${largestSolReceived.toFixed(4)}, SOL received=${solReceived.toFixed(4)}, SOL net=${solChange.toFixed(4)}`);
      }
      // Edge case: SOL comes in but token change is small (might be wrapped SOL or fees)
      // Check if description indicates a sell
      else if (solChange > 0.001 && isSwapDescription && description.toLowerCase().includes('sell')) {
        // Likely a sell but token transfer might be wrapped differently
        // Use the first significant token change (even if small)
        swapType = 'sell';
        tokenMint = tokenChange.mint;
        amount = Math.abs(tokenChange.change);
        solAmount = largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : solChange);
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
        solAmount = largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : Math.abs(solChange));
        console.log(`    ⚠️ Sell detected (large token out): ${amount.toFixed(2)} tokens, SOL largest=${largestSolReceived.toFixed(4)}, SOL received=${solReceived.toFixed(4)}, SOL net=${solChange.toFixed(4)}`);
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
            solAmount = largestSolReceived > 0.1 ? largestSolReceived : (solReceived > 0 ? solReceived : solChange);
            console.log(`    ⚠️ Sell detected via description fallback: token=${mint.substring(0, 8)}...`);
            break;
          }
        }
      }
    }
    
    if (!swapType && Math.abs(solChange) > 0.001) {
      // Log when SOL changes but no token swap detected
      console.log(`    ⚠️ SOL change detected (${solChange.toFixed(4)}) but no significant token change found. Description: "${description.substring(0, 60)}"`);
      // Log token transfers for debugging
      if (tokenTransfers.length > 0) {
        console.log(`    🔍 Token transfers: ${tokenTransfers.length} transfers found`);
        tokenTransfers.slice(0, 3).forEach((transfer, idx) => {
          const from = (transfer.fromUserAccount || transfer.from || '').toLowerCase();
          const to = (transfer.toUserAccount || transfer.to || '').toLowerCase();
          const isKOLInvolved = from === kolAddressLower || to === kolAddressLower;
          console.log(`      Transfer ${idx + 1}: ${isKOLInvolved ? 'KOL INVOLVED' : 'other'}, from=${from.substring(0, 8)}..., to=${to.substring(0, 8)}..., amount=${transfer.tokenAmount || transfer.amount || 0}`);
        });
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

// Group consecutive transactions of the same type within a timeframe
// Groups transactions that are the same type (buy/sell), same token, and within GROUP_TIME_WINDOW_MS
function groupTransactions(parsedTransactions, groupTimeWindowMs = 120000) { // Default: 2 minutes
  if (parsedTransactions.length === 0) return [];
  
  const groups = [];
  let currentGroup = null;
  
  for (const tx of parsedTransactions) {
    if (!tx.swapInfo) continue; // Skip non-swap transactions
    
    const txTime = tx.swapInfo.timestamp ? tx.swapInfo.timestamp.getTime() : Date.now();
    const groupKey = `${tx.swapInfo.type}_${tx.swapInfo.tokenMint}`;
    
    // Start a new group if:
    // 1. No current group exists
    // 2. Different type or token
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
        type: tx.swapInfo.type,
        tokenMint: tx.swapInfo.tokenMint,
        transactions: [tx],
        firstTime: txTime,
        lastTime: txTime,
        totalTokenAmount: tx.swapInfo.tokenAmount,
        totalSolAmount: tx.swapInfo.solAmount,
        signatures: [tx.swapInfo.signature]
      };
    } else {
      // Add to current group
      currentGroup.transactions.push(tx);
      currentGroup.lastTime = Math.max(currentGroup.lastTime, txTime);
      currentGroup.totalTokenAmount += tx.swapInfo.tokenAmount;
      currentGroup.totalSolAmount += tx.swapInfo.solAmount;
      currentGroup.signatures.push(tx.swapInfo.signature);
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
          const swapInfo = parseSwapTransaction(tx, kolAddress);
          
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
          console.log(`  📦 Processing group: ${group.type} ${group.transactions.length} tx(s) for token ${group.tokenMint.substring(0, 8)}...`);
          
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
            
            // Get token price (fetch once per group)
            if (!tokenPrice) {
              try {
                const { getSolanaTokenPrice } = require('../utils/api');
                const priceData = await getSolanaTokenPrice(swapInfo.tokenMint);
                if (priceData && priceData.price) {
                  tokenPrice = parseFloat(priceData.price);
                }
              } catch (error) {
                console.log(`  ⚠️ Could not fetch price for token ${swapInfo.tokenMint}:`, error.message);
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
                txTimestampUnix
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
          
          // Get aggregated swap info from group
          const groupSwapInfo = {
            type: group.type,
            tokenMint: group.tokenMint,
            tokenAmount: group.totalTokenAmount,
            solAmount: group.totalSolAmount,
            signature: group.signatures[0], // Use first signature as primary
            signatures: group.signatures, // All signatures for links
            timestamp: new Date(group.firstTime)
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
          const actionEmoji = groupSwapInfo.type === 'buy' ? buyEmoji : sellEmoji;
          
          let message = '';
          
          // First line: KOL NAME 🟢/🔴 $SYMBOL @ Mcap
          if (marketCap && tokenPrice) {
            message += `<b>${kolName}</b> ${actionEmoji} <b>$${tokenSymbol}</b> @ ${formatMarketCap(marketCap)}\n`;
          } else {
            message += `<b>${kolName}</b> ${actionEmoji} <b>$${tokenSymbol}</b>\n`;
          }
          
          // Show grouped indicator if multiple transactions
          if (isGrouped) {
            message += `📦 <b>${group.transactions.length} transactions grouped</b>\n`;
          }
          
          // Timestamp
          message += `🕐 ${formattedTime}\n`;
          
          // Show other KOLs if multiple KOLs bought this token
          if (kolCount >= 2 && groupSwapInfo.type === 'buy' && otherKOLs.length > 0) {
            message += `\n🔥 <b>${kolCount} KOLs</b> in this token:\n`;
            message += `• ${kolName}\n`;
            otherKOLs.forEach(otherKol => {
              message += `• ${otherKol}\n`;
            });
            message += `\n`;
          }
          
          // Amount tokens (aggregated)
          message += `${formatTokenAmount(groupSwapInfo.tokenAmount)} tokens\n`;
          
          // SOL paid (aggregated)
          message += `${groupSwapInfo.solAmount.toFixed(4)} SOL\n`;
          
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
          
          // Send alerts to all users tracking this KOL or token
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
  }
}

module.exports = {
  checkKOLTransactions
};
