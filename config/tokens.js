// Supported tokens configuration
const TOKENS = {
  bitcoin: { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', emoji: '₿' },
  ethereum: { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', emoji: 'Ξ' },
  binancecoin: { id: 'binancecoin', symbol: 'BNB', name: 'BNB', emoji: '🟡' },
  solana: { id: 'solana', symbol: 'SOL', name: 'Solana', emoji: '◎' }
};

// Valid intervals (in minutes)
const VALID_INTERVALS = [1, 2, 5, 10, 15, 30, 60];

module.exports = {
  TOKENS,
  VALID_INTERVALS
};

