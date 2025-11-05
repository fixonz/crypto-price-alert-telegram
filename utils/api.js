const axios = require('axios');
const { TOKENS } = require('../config/tokens');

// Price cache - query once per minute, cache for 1 minute
const priceCache = {};
const CACHE_TTL = 60 * 1000; // 1 minute cache (exactly as requested)
let isFetching = false; // Lock to prevent multiple simultaneous API calls
let fetchPromise = null; // Store the ongoing fetch promise

// Solana token cache (1-5 minutes)
const solanaPriceCache = {};
const SOLANA_CACHE_TTL = 3 * 60 * 1000; // 3 minutes cache for Solana tokens

// Solana token metadata cache (5 minutes)
const solanaMetadataCache = {};
const METADATA_CACHE_TTL = 5 * 60 * 1000; // 5 minutes for metadata

// Fetch Solana token price from GeckoTerminal (with caching)
async function getSolanaTokenPrice(tokenAddress) {
  // Check cache first
  const cached = solanaPriceCache[tokenAddress];
  if (cached && Date.now() - cached.timestamp < SOLANA_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    const response = await axios.get(
      `https://api.geckoterminal.com/api/v2/simple/networks/solana/token_price/${tokenAddress}`,
      {
        headers: {
          'Accept': 'application/json;version=20230203'
        },
        timeout: 10000
      }
    );
    
    const data = response.data?.data?.attributes;
    if (!data || !data.token_prices || !data.token_prices[tokenAddress]) {
      return null;
    }
    
    const price = parseFloat(data.token_prices[tokenAddress]);
    const change24h = data.h24_price_change_percentage?.[tokenAddress] || 0;
    
    const result = {
      price: price.toFixed(price < 0.01 ? 8 : price < 1 ? 6 : 2),
      change24h: change24h.toFixed(2),
      emoji: change24h >= 0 ? '📈' : '📉'
    };
    
    // Cache the result
    solanaPriceCache[tokenAddress] = {
      data: result,
      timestamp: Date.now()
    };
    
    return result;
  } catch (error) {
    console.error(`Error fetching Solana token ${tokenAddress} price:`, error.message);
    // Return cached data if available even if expired
    if (cached) {
      console.log(`Using expired cache for ${tokenAddress}`);
      return cached.data;
    }
    return null;
  }
}

// Get Solana token info (name, symbol, metadata, holders, transactions)
async function getSolanaTokenInfo(tokenAddress) {
  // Check metadata cache first
  const cached = solanaMetadataCache[tokenAddress];
  if (cached && Date.now() - cached.timestamp < METADATA_CACHE_TTL) {
    return cached.data;
  }
  
  try {
    // Try pump.fun API first (for pump.fun tokens)
    let result = null;
    let isPumpFun = false;
    
    try {
      const pumpFunResponse = await axios.get(
        `https://frontend-api-v3.pump.fun/coins/${tokenAddress}`,
        {
          timeout: 10000
        }
      );
      
      const pumpData = pumpFunResponse.data;
      if (pumpData && pumpData.mint) {
        isPumpFun = true;
        result = {
          name: pumpData.name || 'Unknown Token',
          symbol: pumpData.symbol || 'UNKNOWN',
          address: tokenAddress,
          imageUrl: pumpData.image_uri || null,
          decimals: null, // pump.fun doesn't provide decimals directly
          creator: pumpData.creator || null,
          pumpSwapPool: pumpData.pump_swap_pool || null,
          marketCap: pumpData.usd_market_cap || null,
          holders: null, // pump.fun doesn't provide holders
          transactions: null // Will fetch separately
        };
        
        // Fetch market activity data if we have a pool
        if (result.pumpSwapPool) {
          try {
            const marketActivityResponse = await axios.get(
              `https://swap-api.pump.fun/v1/pools/${result.pumpSwapPool}/market-activity`,
              {
                timeout: 10000
              }
            );
            
            const activity = marketActivityResponse.data;
            if (activity) {
              result.transactions = {
                m5: activity['5m'] ? {
                  buys: activity['5m'].numBuys || 0,
                  sells: activity['5m'].numSells || 0,
                  buyVolumeUSD: activity['5m'].buyVolumeUSD || 0,
                  sellVolumeUSD: activity['5m'].sellVolumeUSD || 0,
                  priceChangePercent: activity['5m'].priceChangePercent || 0
                } : null,
                m15: null, // pump.fun doesn't provide 15m
                h1: activity['1h'] ? {
                  buys: activity['1h'].numBuys || 0,
                  sells: activity['1h'].numSells || 0,
                  buyVolumeUSD: activity['1h'].buyVolumeUSD || 0,
                  sellVolumeUSD: activity['1h'].sellVolumeUSD || 0,
                  priceChangePercent: activity['1h'].priceChangePercent || 0
                } : null,
                h6: activity['6h'] ? {
                  buys: activity['6h'].numBuys || 0,
                  sells: activity['6h'].numSells || 0,
                  buyVolumeUSD: activity['6h'].buyVolumeUSD || 0,
                  sellVolumeUSD: activity['6h'].sellVolumeUSD || 0,
                  priceChangePercent: activity['6h'].priceChangePercent || 0
                } : null,
                h24: activity['24h'] ? {
                  buys: activity['24h'].numBuys || 0,
                  sells: activity['24h'].numSells || 0,
                  buyVolumeUSD: activity['24h'].buyVolumeUSD || 0,
                  sellVolumeUSD: activity['24h'].sellVolumeUSD || 0,
                  priceChangePercent: activity['24h'].priceChangePercent || 0
                } : null
              };
            }
          } catch (activityError) {
            console.warn(`Could not fetch market activity for ${tokenAddress}:`, activityError.message);
          }
        }
      }
    } catch (pumpFunError) {
      // Not a pump.fun token, continue with GeckoTerminal
      console.log(`Token ${tokenAddress} not found on pump.fun, trying GeckoTerminal...`);
    }
    
    // Fallback to GeckoTerminal if not pump.fun token
    if (!isPumpFun) {
      const tokenResponse = await axios.get(
        `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenAddress}`,
        {
          headers: {
            'Accept': 'application/json;version=20230203'
          },
          timeout: 10000
        }
      );
      
      const attributes = tokenResponse.data?.data?.attributes;
      if (!attributes) return null;
      
      result = {
        name: attributes.name || 'Unknown Token',
        symbol: attributes.symbol || 'UNKNOWN',
        address: tokenAddress,
        imageUrl: attributes.image_url || null,
        decimals: attributes.decimals || null,
        creator: null,
        pumpSwapPool: null,
        marketCap: null,
        holders: null,
        transactions: null
      };
      
      // Try to get token info with holders and pool data
      try {
        const infoResponse = await axios.get(
          `https://api.geckoterminal.com/api/v2/networks/solana/tokens/${tokenAddress}/info`,
          {
            headers: {
              'Accept': 'application/json;version=20230203'
            },
            timeout: 10000
          }
        );
        
        const infoAttributes = infoResponse.data?.data?.attributes;
        if (infoAttributes) {
          // Get holders count if available
          if (infoAttributes.holders) {
            result.holders = {
              count: infoAttributes.holders.count || null,
              distribution: infoAttributes.holders.distribution_percentage || null
            };
          }
        }
        
        // Try to get top pools for transaction data
        const poolsData = tokenResponse.data?.data?.relationships?.top_pools?.data;
        if (poolsData && poolsData.length > 0) {
          const topPoolId = poolsData[0].id;
          // Pool ID format: "solana_pooladdress" - extract just the address part
          const poolAddress = topPoolId.includes('_') ? topPoolId.split('_')[1] : topPoolId;
          try {
            const poolResponse = await axios.get(
              `https://api.geckoterminal.com/api/v2/networks/solana/pools/${poolAddress}`,
              {
                headers: {
                  'Accept': 'application/json;version=20230203'
                },
                timeout: 10000
              }
            );
            
            const poolAttributes = poolResponse.data?.data?.attributes;
            if (poolAttributes && poolAttributes.transactions) {
              result.transactions = {
                m5: poolAttributes.transactions.m5 || null,
                m15: poolAttributes.transactions.m15 || null,
                h1: poolAttributes.transactions.h1 || null
              };
            }
          } catch (poolError) {
            // If pool fetch fails, continue without transaction data
            console.warn(`Could not fetch pool data for ${tokenAddress}:`, poolError.message);
          }
        }
      } catch (infoError) {
        // If info endpoint fails, continue with basic info
        console.warn(`Could not fetch extended info for ${tokenAddress}:`, infoError.message);
      }
    }
    
    if (!result) return null;
    
    // Cache the result
    solanaMetadataCache[tokenAddress] = {
      data: result,
      timestamp: Date.now()
    };
    
    return result;
  } catch (error) {
    console.error(`Error fetching Solana token info ${tokenAddress}:`, error.message);
    // Return cached data if available even if expired
    if (cached) {
      console.log(`Using expired metadata cache for ${tokenAddress}`);
      return cached.data;
    }
    return null;
  }
}

// Fetch prices from FreeCryptoAPI (once per minute)
async function fetchFromFreeCryptoAPI() {
  const apiKey = process.env.FREECRYPTOAPI_KEY;
  if (!apiKey) {
    console.error('❌ FREECRYPTOAPI_KEY not set in environment variables');
    return null;
  }

  try {
    // Map our token IDs to FreeCryptoAPI symbols
    const tokenSymbols = {
      'bitcoin': 'BTC',
      'ethereum': 'ETH',
      'binancecoin': 'BNB',
      'solana': 'SOL'
    };

    const result = {};
    
    // Fetch all tokens in parallel (or sequentially if API requires it)
    const symbols = Object.values(TOKENS).map(t => tokenSymbols[t.id]).filter(Boolean);
    
    for (const symbol of symbols) {
      try {
        const response = await axios.get(`https://api.freecryptoapi.com/v1/getData`, {
          params: {
            symbol: symbol
          },
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Accept': 'application/json'
          },
          timeout: 10000
        });

        if (response.data && response.data.price !== undefined) {
          // Find the token ID for this symbol
          const tokenId = Object.keys(tokenSymbols).find(id => tokenSymbols[id] === symbol);
          if (tokenId && TOKENS[tokenId]) {
            result[tokenId] = {
              usd: parseFloat(response.data.price),
              usd_24h_change: parseFloat(response.data.change24h || response.data.change_24h || 0)
            };
          }
        }
        
        // Small delay between requests
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.warn(`FreeCryptoAPI: Failed to fetch ${symbol}:`, error.message);
      }
    }
    
    // Return result only if we got at least one price
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    console.error('FreeCryptoAPI error:', error.message);
    return null;
  }
}

// Fetch prices for all tokens - queries once per minute, uses cache for all requests
async function getAllTokenPrices() {
  const cacheKey = 'all_prices';
  const cached = priceCache[cacheKey];
  const now = Date.now();
  
  // Return cached data if still valid (within 1 minute)
  if (cached && (now - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }
  
  // If already fetching, wait for that promise instead of starting a new request
  if (isFetching && fetchPromise) {
    try {
      const result = await fetchPromise;
      return result;
    } catch (error) {
      // If fetch failed, try to use cached data
      if (cached) {
        console.warn('⚠️ API fetch failed, using cached data');
        return cached.data;
      }
      return null;
    }
  }
  
  // Start fetching (lock to prevent multiple simultaneous calls)
  isFetching = true;
  fetchPromise = (async () => {
    try {
      console.log('📡 Fetching prices from FreeCryptoAPI (once per minute)...');
      const data = await fetchFromFreeCryptoAPI();
      
      if (data) {
        // Cache the results
        priceCache[cacheKey] = {
          data: data,
          timestamp: Date.now(),
          source: 'freecryptoapi'
        };
        console.log('✅ Prices fetched and cached');
        return data;
      } else {
        // If API failed, use cached data if available
        if (cached) {
          console.warn('⚠️ API fetch returned no data, using cached data');
          return cached.data;
        }
        return null;
      }
    } catch (error) {
      console.error('❌ Error fetching prices:', error.message);
      // Use cached data if available
      if (cached) {
        console.warn('⚠️ Using cached data due to error');
        return cached.data;
      }
      return null;
    } finally {
      // Release lock after a short delay to ensure cache is fresh
      setTimeout(() => {
        isFetching = false;
        fetchPromise = null;
      }, 1000);
    }
  })();
  
  return await fetchPromise;
}

// Fetch price for a specific token
async function getTokenPrice(tokenId) {
  // Try to get from cache first
  const allPrices = await getAllTokenPrices();
  if (!allPrices || !allPrices[tokenId]) {
    return null;
  }
  
  const data = allPrices[tokenId];
  const price = data.usd;
  const change24h = data.usd_24h_change;
  
  return {
    price: price.toFixed(2),
    change24h: change24h ? change24h.toFixed(2) : '0.00',
    emoji: change24h >= 0 ? '📈' : '📉'
  };
}

module.exports = {
  getSolanaTokenPrice,
  getSolanaTokenInfo,
  getAllTokenPrices,
  getTokenPrice
};

