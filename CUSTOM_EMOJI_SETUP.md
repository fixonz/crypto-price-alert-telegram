# Custom Emoji Setup Guide

## How to Give Your Bot Access to Custom Emojis

To use custom emojis in your Telegram bot, you need to ensure the bot has access to the emoji set. Here's how:

### Method 1: Add Emoji Set to Bot's Account (Recommended)

1. **Find the Custom Emoji Set**:
   - The emoji IDs you have are: `5895702350248547531`, `5895657545149715556`, `5895565508295529026`
   - These are from a custom emoji set (likely from a channel or bot)

2. **Add to Bot's Account**:
   - Unfortunately, bots **cannot directly add emoji sets** themselves
   - You need to add the emoji set to the **Telegram account** associated with your bot
   - If your bot is linked to a user account, add the emoji set to that account
   - If not, you may need to create a new account for the bot

3. **Get the Emoji Set**:
   - Find the channel/bot that has these emojis
   - Send a message with these emojis to your bot account
   - Or use a bot like `@custom_emoji_bot` or `@EmojiTitleBot` to manage emoji sets

### Method 2: Use Entities (Current Implementation)

The current code uses the **entities** parameter which should work if:
- The emoji IDs are valid and accessible
- The bot can reference them (even if not owned by the bot)

**How it works:**
- The code places placeholder emojis (🟥🟥🟥) in the message
- Then uses entities to replace them with custom emojis
- Each custom emoji is 2 UTF-16 code units

### Method 3: Test Without Access

If the emojis don't work, it might mean:
1. The emoji IDs are from a private/restricted set
2. The bot doesn't have permission to use them
3. The emoji set needs to be added to the bot's account first

### Troubleshooting

**If emojis don't appear:**
1. Check if the emoji IDs are correct
2. Verify the bot can see these emojis (send a test message with them to the bot)
3. Try using a different emoji set that's publicly available
4. Consider using regular Unicode emojis as fallback (e.g., 🔴🔴🔴 for LIVE)

### Alternative: Use Regular Emojis

If custom emojis don't work, you can use:
- 🔴🔴🔴 (red circles)
- ⚡⚡⚡ (lightning)
- ⭐⭐⭐ (stars)
- Or any other combination that spells "LIVE"

### Current Code Status

The code is configured to:
- Use placeholder emojis (🟥🟥🟥) that will be replaced
- Send entities with custom emoji IDs
- Fall back gracefully if entities don't work

**To test:** After deployment, check if the custom emojis appear. If not, the emoji set needs to be added to the bot's account.

