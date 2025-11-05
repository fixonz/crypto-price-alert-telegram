const { getUserCount, getActiveUserCount } = require('../utils/storage');

// Send admin notification about new user
async function notifyAdminNewUser(bot, userId, username, firstName, lastName) {
  const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
  if (!ADMIN_CHAT_ID) return;
  
  const totalUsers = await getUserCount();
  const activeUsers = await getActiveUserCount();
  
  const userInfo = [
    username ? `@${username}` : 'No username',
    firstName ? firstName : '',
    lastName ? lastName : ''
  ].filter(Boolean).join(' ') || 'Unknown';
  
  const message = `🆕 *New User Started Bot*

👤 *User Info:*
• ID: \`${userId}\`
• Name: ${userInfo}

📊 *Statistics:*
• Total Users: *${totalUsers}*
• Active Users: *${activeUsers}*

_Time: ${new Date().toLocaleString()}_`;

  try {
    await bot.sendMessage(ADMIN_CHAT_ID, message, { parse_mode: 'Markdown' });
  } catch (error) {
    console.error('Error sending admin notification:', error.message);
  }
}

module.exports = {
  notifyAdminNewUser
};

