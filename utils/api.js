const axios = require('axios');
const { TOKENS } = require('../config/tokens');

// Price cache to reduce API calls
const priceCache = {};
const CACHE_TTL = 30 * 1000; // 30 seconds cache for standard tokens

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

// Fetch prices from CoinCap (fallback API)
async function fetchFromCoinCap() {
  try {
    const result = {};
    
    // CoinCap doesn't support batch requests, so fetch individually
    // But we'll use their rates endpoint which is more efficient
    const coinCapIds = ['bitcoin', 'ethereum', 'binancecoin', 'solana'];
    
    for (const coinCapId of coinCapIds) {
      try {
        const response = await axios.get(`https://api.coincap.io/v2/assets/${coinCapId}`, {
          timeout: 5000
        });
        
        const coin = response.data.data;
        
        // Map CoinCap ID to our token ID
        let tokenKey = null;
        if (coinCapId === 'bitcoin') tokenKey = 'bitcoin';
        else if (coinCapId === 'ethereum') tokenKey = 'ethereum';
        else if (coinCapId === 'binancecoin') tokenKey = 'binancecoin';
        else if (coinCapId === 'solana') tokenKey = 'solana';
        
        if (tokenKey && TOKENS[tokenKey]) {
          result[TOKENS[tokenKey].id] = {
            usd: parseFloat(coin.priceUsd),
            usd_24h_change: parseFloat(coin.changePercent24Hr) || 0
          };
        }
        
        // Small delay between requests to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 200));
      } catch (error) {
        console.warn(`Failed to fetch ${coinCapId} from CoinCap:`, error.message);
      }
    }
    
    // Return result only if we got at least one price
    return Object.keys(result).length > 0 ? result : null;
  } catch (error) {
    console.error('CoinCap fallback error:', error.message);
    return null;
  }
}

// Fetch prices for all tokens at once (more efficient)
async function getAllTokenPrices() {
  const cacheKey = 'all_prices';
  const cached = priceCache[cacheKey];
  
  // Return cached data if still valid
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  // Try CoinGecko first (primary API)
  try {
    // Fetch all tokens in one API call
    const tokenIds = Object.values(TOKENS).map(t => t.id).join(',');
    const response = await axios.get(
      `https://api.coingecko.com/api/v3/simple/price?ids=${tokenIds}&vs_currencies=usd&include_24hr_change=true`,
      {
        timeout: 10000,
        headers: {
          'Accept': 'application/json'
        }
      }
    );
    
    // Cache the results
    priceCache[cacheKey] = {
      data: response.data,
      timestamp: Date.now(),
      source: 'coingecko'
    };
    
    return response.data;
  } catch (error) {
    if (error.response?.status === 429) {
      console.warn('⚠️ CoinGecko rate limit hit. Trying fallback API...');
    } else {
      console.warn(`⚠️ CoinGecko error: ${error.message}. Trying fallback API...`);
    }
    
    // Try fallback API (CoinCap)
    const fallbackData = await fetchFromCoinCap();
    if (fallbackData) {
      console.log('✅ Using CoinCap as fallback');
      // Cache the fallback results
      priceCache[cacheKey] = {
        data: fallbackData,
        timestamp: Date.now(),
        source: 'coincap'
      };
      return fallbackData;
    }
    
    // If both fail, use cached data if available
    if (cached) {
      console.warn('⚠️ Both APIs failed. Using cached data.');
      return cached.data;
    }
    
    console.error('❌ All price APIs failed and no cache available');
    return null;
  }
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

