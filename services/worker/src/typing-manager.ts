/**
 * TypingIndicatorManager
 * 
 * Manages persistent typing indicators for active tasks.
 * Automatically refreshes typing indicators every 50 seconds to prevent timeout.
 * Ensures users see continuous typing feedback during long-running tasks.
 */

import { SDK } from '@photon-ai/advanced-imessage-kit';

// Refresh interval: 50 seconds (safe buffer before typical 60s timeout)
const TYPING_REFRESH_INTERVAL = 50000;

interface TypingState {
  phoneNumber: string;
  taskId: string;
  refreshTimer: NodeJS.Timeout;
  startedAt: number;
}

export class TypingIndicatorManager {
  private activeTyping = new Map<string, TypingState>();
  private sdk: ReturnType<typeof SDK> | null = null;

  constructor(private imessageSDK: ReturnType<typeof SDK>) {
    this.sdk = imessageSDK;
  }

  /**
   * Start typing indicator for a phone number
   * Automatically refreshes every 50 seconds until stopped
   */
  async startTyping(phoneNumber: string, taskId: string): Promise<void> {
    const callTimestamp = new Date().toISOString();
    console.log(`\n⏱️  [${callTimestamp}] startTyping() called for ${phoneNumber} (task: ${taskId})`);
    
    // If already typing for this phone number, update the task ID
    if (this.activeTyping.has(phoneNumber)) {
      const state = this.activeTyping.get(phoneNumber)!;
      state.taskId = taskId;
      console.log(`🔄 [${callTimestamp}] Typing indicator already active - updated task ID for ${phoneNumber} to ${taskId}`);
      return;
    }

    try {
      const chatGuid = `any;-;${phoneNumber}`;
      const startCallTime = Date.now();
      console.log(`📞 [${callTimestamp}] Calling sdk.chats.startTyping(${chatGuid})...`);
      
      await this.sdk!.chats.startTyping(chatGuid);
      
      const startCallDuration = Date.now() - startCallTime;
      console.log(`🟢 [${new Date().toISOString()}] Started typing indicator for ${phoneNumber} (task: ${taskId}) - API call took ${startCallDuration}ms`);

      // Set up auto-refresh
      console.log(`⏰ [${new Date().toISOString()}] Setting up refresh timer with ${TYPING_REFRESH_INTERVAL}ms interval (${TYPING_REFRESH_INTERVAL / 1000}s)`);
      const refreshTimer = setInterval(async () => {
        await this.refreshTyping(phoneNumber);
      }, TYPING_REFRESH_INTERVAL);

      this.activeTyping.set(phoneNumber, {
        phoneNumber,
        taskId,
        refreshTimer,
        startedAt: Date.now(),
      });
      
      console.log(`✅ [${new Date().toISOString()}] Typing state saved for ${phoneNumber} - next refresh in ${TYPING_REFRESH_INTERVAL / 1000}s\n`);
    } catch (error) {
      console.error(`❌ [${new Date().toISOString()}] Failed to start typing indicator for ${phoneNumber}:`, error);
      // Non-critical - continue anyway
    }
  }

  /**
   * Refresh typing indicator to prevent timeout
   * Called automatically every 50 seconds
   */
  private async refreshTyping(phoneNumber: string): Promise<void> {
    const refreshStartTime = Date.now();
    const refreshTimestamp = new Date().toISOString();
    
    console.log(`\n🔄 [${refreshTimestamp}] ======== REFRESH CYCLE START ========`);
    console.log(`📱 Phone: ${phoneNumber}`);
    
    const state = this.activeTyping.get(phoneNumber);
    if (!state) {
      console.log(`⚠️  [${refreshTimestamp}] No active typing state found for ${phoneNumber} - skipping refresh\n`);
      return;
    }

    const durationSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
    console.log(`⏱️  [${refreshTimestamp}] Typing indicator has been active for ${durationSeconds}s (task: ${state.taskId})`);

    try {
      const chatGuid = `any;-;${phoneNumber}`;
      
      // Stop typing
      const stopStartTime = Date.now();
      console.log(`⏸️  [${new Date().toISOString()}] Calling sdk.chats.stopTyping(${chatGuid})...`);
      await this.sdk!.chats.stopTyping(chatGuid);
      const stopDuration = Date.now() - stopStartTime;
      console.log(`⏹️  [${new Date().toISOString()}] Stopped typing indicator - API call took ${stopDuration}ms`);
      
      // Wait 2 seconds
      console.log(`⏳ [${new Date().toISOString()}] Waiting 2000ms before restarting...`);
      const waitStartTime = Date.now();
      await new Promise(resolve => setTimeout(resolve, 2000));
      const actualWaitTime = Date.now() - waitStartTime;
      console.log(`✓  [${new Date().toISOString()}] Wait completed - actual wait time: ${actualWaitTime}ms`);
      
      // Restart typing
      const restartStartTime = Date.now();
      console.log(`▶️  [${new Date().toISOString()}] Calling sdk.chats.startTyping(${chatGuid})...`);
      await this.sdk!.chats.startTyping(chatGuid);
      const restartDuration = Date.now() - restartStartTime;
      console.log(`🟢 [${new Date().toISOString()}] Restarted typing indicator - API call took ${restartDuration}ms`);
      
      const totalRefreshTime = Date.now() - refreshStartTime;
      console.log(`✅ [${new Date().toISOString()}] REFRESH COMPLETE - Total time: ${totalRefreshTime}ms (${(totalRefreshTime / 1000).toFixed(2)}s)`);
      console.log(`📊 Breakdown: stop=${stopDuration}ms, wait=${actualWaitTime}ms, restart=${restartDuration}ms`);
      console.log(`⏰ Next refresh in ${TYPING_REFRESH_INTERVAL / 1000}s`);
      console.log(`======== REFRESH CYCLE END ========\n`);
    } catch (error) {
      const totalFailTime = Date.now() - refreshStartTime;
      console.error(`❌ [${new Date().toISOString()}] Failed to refresh typing indicator for ${phoneNumber} after ${totalFailTime}ms:`, error);
      console.log(`🔄 Will retry on next interval (${TYPING_REFRESH_INTERVAL / 1000}s)\n`);
      // Try to continue anyway - will retry on next interval
    }
  }

  /**
   * Stop typing indicator for a phone number
   */
  async stopTyping(phoneNumber: string): Promise<void> {
    const stopTimestamp = new Date().toISOString();
    console.log(`\n🛑 [${stopTimestamp}] stopTyping() called for ${phoneNumber}`);
    
    const state = this.activeTyping.get(phoneNumber);
    if (!state) {
      console.log(`ℹ️  [${stopTimestamp}] No active typing state found for ${phoneNumber} - nothing to stop\n`);
      return; // Not currently typing
    }

    const durationSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
    console.log(`📊 [${stopTimestamp}] Typing indicator was active for ${durationSeconds}s (task: ${state.taskId})`);

    try {
      // Clear the refresh timer
      console.log(`⏰ [${stopTimestamp}] Clearing refresh timer for ${phoneNumber}...`);
      clearInterval(state.refreshTimer);
      console.log(`✓  [${new Date().toISOString()}] Refresh timer cleared`);

      // Stop typing indicator
      const chatGuid = `any;-;${phoneNumber}`;
      const apiCallStart = Date.now();
      console.log(`📞 [${new Date().toISOString()}] Calling sdk.chats.stopTyping(${chatGuid})...`);
      await this.sdk!.chats.stopTyping(chatGuid);
      const apiCallDuration = Date.now() - apiCallStart;
      
      console.log(`⏹️  [${new Date().toISOString()}] Stopped typing indicator for ${phoneNumber} - API call took ${apiCallDuration}ms`);
      console.log(`✅ Total active duration: ${durationSeconds}s (task: ${state.taskId})`);

      this.activeTyping.delete(phoneNumber);
      console.log(`🗑️  [${new Date().toISOString()}] Removed typing state for ${phoneNumber}\n`);
    } catch (error) {
      console.error(`❌ [${new Date().toISOString()}] Failed to stop typing indicator for ${phoneNumber}:`, error);
      // Clean up state anyway
      this.activeTyping.delete(phoneNumber);
      console.log(`🗑️  [${new Date().toISOString()}] Removed typing state anyway despite error\n`);
    }
  }

  /**
   * Check if currently showing typing indicator for a phone number
   */
  isTyping(phoneNumber: string): boolean {
    return this.activeTyping.has(phoneNumber);
  }

  /**
   * Get current task ID for a phone number's active typing indicator
   */
  getActiveTaskId(phoneNumber: string): string | null {
    return this.activeTyping.get(phoneNumber)?.taskId || null;
  }

  /**
   * Stop all active typing indicators (for shutdown)
   */
  async stopAll(): Promise<void> {
    const promises = Array.from(this.activeTyping.keys()).map(phoneNumber => 
      this.stopTyping(phoneNumber)
    );
    await Promise.all(promises);
    console.log('🛑 Stopped all typing indicators');
  }

  /**
   * Get count of active typing indicators
   */
  getActiveCount(): number {
    return this.activeTyping.size;
  }
}
