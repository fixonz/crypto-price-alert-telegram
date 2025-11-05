const fs = require('fs').promises;
const path = require('path');

// User preferences file
const USERS_FILE = path.join(__dirname, '..', 'users.json');

// Price history file (stores last known prices for drop detection)
const PRICES_FILE = path.join(__dirname, '..', 'prices.json');

// Load user preferences
async function loadUsers() {
  try {
    const data = await fs.readFile(USERS_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Save user preferences
async function saveUsers(users) {
  await fs.writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

// Load price history
async function loadPriceHistory() {
  try {
    const data = await fs.readFile(PRICES_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    return {};
  }
}

// Save price history
async function savePriceHistory(history) {
  await fs.writeFile(PRICES_FILE, JSON.stringify(history, null, 2));
}

// Get user count
async function getUserCount() {
  const users = await loadUsers();
  return Object.keys(users).length;
}

// Get active user count
async function getActiveUserCount() {
  const users = await loadUsers();
  return Object.values(users).filter(u => u.subscribed).length;
}

// Check if user is new (first time starting)
async function isNewUser(chatId) {
  const users = await loadUsers();
  return !users[chatId];
}

// Get user preferences or create default
async function getUserPreferences(chatId) {
  const users = await loadUsers();
  const isNew = !users[chatId];
  if (!users[chatId]) {
    users[chatId] = {
      subscribed: true,
      tokens: [],
      customTokens: [], // Custom Solana tokens with addresses
      interval: 1, // default 1 minute
      createdAt: Date.now()
    };
    await saveUsers(users);
  }
  // Ensure customTokens exists for existing users
  if (!users[chatId].customTokens) {
    users[chatId].customTokens = [];
    await saveUsers(users);
  }
  return { ...users[chatId], isNew };
}

// Update user preferences
async function updateUserPreferences(chatId, updates) {
  const users = await loadUsers();
  if (!users[chatId]) {
    users[chatId] = {
      subscribed: true,
      tokens: [],
      customTokens: [],
      interval: 1,
      createdAt: Date.now()
    };
  }
  // Ensure customTokens exists
  if (!users[chatId].customTokens) {
    users[chatId].customTokens = [];
  }
  Object.assign(users[chatId], updates);
  await saveUsers(users);
  return users[chatId];
}

module.exports = {
  loadUsers,
  saveUsers,
  loadPriceHistory,
  savePriceHistory,
  getUserCount,
  getActiveUserCount,
  isNewUser,
  getUserPreferences,
  updateUserPreferences
};

