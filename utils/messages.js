// Format price message
function formatPriceMessage(token, priceData) {
  const tokenInfo = token; // token can be either TOKENS[key] or custom token object
  const change24h = parseFloat(priceData.change24h);
  const directionEmoji = change24h >= 0 ? '🟢' : '🔴'; // Green up or Red down
  const arrowEmoji = change24h >= 0 ? '📈' : '📉';
  
  const now = new Date();
  // Athens timezone (UTC+2 or UTC+3 with DST)
  const athensTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Athens',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);
  const utcTime = now.toUTCString().split(' ')[4]; // Extract time from UTC string
  
  return `${directionEmoji} *$${(tokenInfo.symbol || '').toUpperCase()} @ $${priceData.price}*

${arrowEmoji} 24h: ${change24h >= 0 ? '+' : ''}${priceData.change24h}%

_Updated at: Local ${athensTime} (UTC: ${utcTime})_`;
}

// Format alert message for price drops
function formatAlertMessage(token, priceData, dropPercentage, previousPrice) {
  const tokenInfo = token;
  const change24h = parseFloat(priceData.change24h);
  const arrowEmoji = change24h >= 0 ? '📈' : '📉';
  
  const now = new Date();
  // Athens timezone (UTC+2 or UTC+3 with DST)
  const athensTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Athens',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(now);
  const utcTime = now.toUTCString().split(' ')[4]; // Extract time from UTC string
  
  return `🚨 *PRICE ALERT - $${(tokenInfo.symbol || '').toUpperCase()}*

⚠️ *5%+ Drop Detected!*

🔴 *$${(tokenInfo.symbol || '').toUpperCase()} @ $${priceData.price}* (was $${previousPrice})
📉 *Drop: -${dropPercentage.toFixed(2)}%*
${arrowEmoji} 24h: ${change24h >= 0 ? '+' : ''}${priceData.change24h}%

_Alert at: Local ${athensTime} (UTC: ${utcTime})_`;
}

module.exports = {
  formatPriceMessage,
  formatAlertMessage
};

