const axios = require('axios');
const { KOL_ADDRESSES, KOL_NAME_TO_ADDRESS } = require('../config/kol');
const { loadUsers, saveUsers } = require('../utils/storage');

// Kolscan.io API endpoint (if available) or scraping
const KOLSCAN_BASE_URL = 'https://kolscan.io';

// Map of shortened addresses to full addresses (from kolscan.io format)
// We'll build this dynamically by matching against our known KOL addresses
function expandKolscanAddress(shortAddress) {
  // Kolscan uses first 6 chars of address
  // Try to match against known addresses
  for (const [fullAddress, names] of Object.entries(KOL_ADDRESSES)) {
    if (fullAddress.toLowerCase().startsWith(shortAddress.toLowerCase())) {
      return fullAddress;
    }
  }
  return null;
}

// Fetch leaderboard from kolscan.io
// Since they might not have a public API, we'll try to scrape or use their data
async function fetchKolscanLeaderboard(period = 'daily', limit = 100) {
  try {
    // Try to fetch leaderboard data
    // Note: kolscan.io might require scraping or have an API endpoint
    // For now, we'll create a structure that can be adapted
    
    // Option 1: If they have an API endpoint
    let leaderboardData = null;
    
    try {
      // Try API endpoint first (if it exists)
      const apiUrl = `${KOLSCAN_BASE_URL}/api/leaderboard/${period}`;
      const response = await axios.get(apiUrl, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (response.data && Array.isArray(response.data)) {
        leaderboardData = response.data;
      } else if (response.data && response.data.leaderboard) {
        leaderboardData = response.data.leaderboard;
      }
    } catch (apiError) {
      console.log(`⚠️ Kolscan API not available, will try scraping: ${apiError.message}`);
    }
    
    // Option 2: Scrape HTML if API doesn't work
    if (!leaderboardData) {
      try {
        const htmlResponse = await axios.get(`${KOLSCAN_BASE_URL}/leaderboard`, {
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          }
        });
        
        // Parse HTML to extract leaderboard data
        // This is a simplified parser - might need adjustment based on actual HTML structure
        const html = htmlResponse.data;
        
        // Extract JSON data if embedded in page
        const jsonMatch = html.match(/window\.__INITIAL_STATE__\s*=\s*({.+?});/);
        if (jsonMatch) {
          const initialState = JSON.parse(jsonMatch[1]);
          if (initialState.leaderboard) {
            leaderboardData = initialState.leaderboard;
          }
        }
        
        // Alternative: Look for data attributes or script tags with leaderboard data
        // This would need to be customized based on kolscan.io's actual structure
      } catch (scrapeError) {
        console.error(`Error scraping kolscan.io: ${scrapeError.message}`);
      }
    }
    
    // If we still don't have data, return empty array
    if (!leaderboardData || !Array.isArray(leaderboardData)) {
      console.log('⚠️ Could not fetch kolscan leaderboard, returning empty array');
      return [];
    }
    
    // Parse and normalize leaderboard entries
    const leaderboard = leaderboardData.slice(0, limit).map((entry, index) => {
      // Extract data based on kolscan.io format
      // Format from web search: rank, shortened address, PnL SOL, PnL USD, win/loss ratio
      const shortAddress = entry.address || entry.wallet || entry.kolAddress || '';
      const fullAddress = expandKolscanAddress(shortAddress) || shortAddress;
      
      return {
        rank: index + 1,
        shortAddress: shortAddress,
        address: fullAddress,
        pnlSOL: parseFloat(entry.pnl || entry.pnlSOL || entry.sol || 0),
        pnlUSD: parseFloat(entry.pnlUSD || entry.usd || 0),
        winRate: entry.winRate || null,
        wins: entry.wins || entry.winCount || 0,
        losses: entry.losses || entry.lossCount || 0,
        name: entry.name || entry.username || null,
        period: period
      };
    });
    
    return leaderboard;
  } catch (error) {
    console.error('Error fetching kolscan leaderboard:', error.message);
    return [];
  }
}

// Get top KOLs from leaderboard and add them to tracking
async function syncTopKOLsFromLeaderboard(period = 'daily', topN = 50, chatId = null) {
  try {
    console.log(`📊 Fetching top ${topN} KOLs from kolscan.io ${period} leaderboard...`);
    
    const leaderboard = await fetchKolscanLeaderboard(period, topN);
    
    if (leaderboard.length === 0) {
      console.log('⚠️ No leaderboard data available');
      return { added: 0, total: 0, leaderboard: [] };
    }
    
    // Get all users or specific user
    const users = await loadUsers();
    const targetUsers = chatId ? { [chatId]: users[chatId] } : users;
    
    let totalAdded = 0;
    const addedKOLs = [];
    
    for (const [userId, userPrefs] of Object.entries(targetUsers)) {
      if (!userPrefs) continue;
      
      // Ensure trackedKOLs exists
      if (!userPrefs.trackedKOLs) {
        userPrefs.trackedKOLs = [];
      }
      
      // Track which KOLs we're adding
      const beforeCount = userPrefs.trackedKOLs.length;
      
      // Add top KOLs that aren't already tracked
      for (const entry of leaderboard) {
        if (!entry.address || entry.address.length < 32) {
          // Skip invalid addresses
          continue;
        }
        
        // Check if already tracked
        const alreadyTracked = userPrefs.trackedKOLs.some(
          kol => kol.address === entry.address || kol === entry.address
        );
        
        if (!alreadyTracked) {
          // Add as object with metadata or just address
          const kolEntry = {
            address: entry.address,
            name: entry.name || KOL_ADDRESSES[entry.address]?.[0] || 'Unknown',
            addedFrom: 'kolscan_leaderboard',
            addedAt: Date.now(),
            rank: entry.rank,
            pnlSOL: entry.pnlSOL,
            period: period
          };
          
          userPrefs.trackedKOLs.push(kolEntry);
          addedKOLs.push({
            address: entry.address,
            name: kolEntry.name,
            rank: entry.rank,
            pnlSOL: entry.pnlSOL
          });
        }
      }
      
      const afterCount = userPrefs.trackedKOLs.length;
      const added = afterCount - beforeCount;
      totalAdded += added;
      
      if (added > 0) {
        // Save updated user preferences
        users[userId] = userPrefs;
        console.log(`  ✅ Added ${added} KOL(s) to user ${userId}`);
      }
    }
    
    // Save all users
    await saveUsers(users);
    
    console.log(`✅ Synced ${totalAdded} KOL(s) from leaderboard`);
    
    return {
      added: totalAdded,
      total: leaderboard.length,
      leaderboard: leaderboard.slice(0, 10), // Return top 10 for display
      addedKOLs: addedKOLs.slice(0, 10)
    };
  } catch (error) {
    console.error('Error syncing KOLs from leaderboard:', error.message);
    return { added: 0, total: 0, leaderboard: [], error: error.message };
  }
}

// Analyze patterns from top KOLs
async function analyzeTopKOLPatterns(period = 'daily', topN = 20) {
  try {
    const leaderboard = await fetchKolscanLeaderboard(period, topN);
    
    if (leaderboard.length === 0) {
      return null;
    }
    
    // Calculate aggregate statistics
    const stats = {
      totalKOLs: leaderboard.length,
      avgPnL: 0,
      totalPnL: 0,
      avgWinRate: 0,
      topPerformers: [],
      commonPatterns: []
    };
    
    let totalPnL = 0;
    let totalWinRate = 0;
    let winRateCount = 0;
    
    for (const entry of leaderboard) {
      totalPnL += entry.pnlSOL || 0;
      if (entry.winRate !== null) {
        totalWinRate += entry.winRate;
        winRateCount++;
      }
    }
    
    stats.avgPnL = totalPnL / leaderboard.length;
    stats.totalPnL = totalPnL;
    stats.avgWinRate = winRateCount > 0 ? totalWinRate / winRateCount : null;
    stats.topPerformers = leaderboard.slice(0, 10).map(e => ({
      address: e.address,
      name: e.name,
      rank: e.rank,
      pnlSOL: e.pnlSOL
    }));
    
    return stats;
  } catch (error) {
    console.error('Error analyzing top KOL patterns:', error.message);
    return null;
  }
}

module.exports = {
  fetchKolscanLeaderboard,
  syncTopKOLsFromLeaderboard,
  analyzeTopKOLPatterns
};

