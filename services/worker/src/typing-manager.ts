/**
 * TypingIndicatorManager
 * 
 * Manages persistent typing indicators for active tasks.
 * Automatically refreshes typing indicators every 25 seconds to prevent timeout.
 * Ensures users see continuous typing feedback during long-running tasks.
 */

import { SDK } from '@photon-ai/advanced-imessage-kit';

// Refresh interval: 25 seconds (safe buffer before typical 30s timeout)
const TYPING_REFRESH_INTERVAL = 25000;

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
   * Automatically refreshes every 25 seconds until stopped
   */
  async startTyping(phoneNumber: string, taskId: string): Promise<void> {
    // If already typing for this phone number, update the task ID
    if (this.activeTyping.has(phoneNumber)) {
      const state = this.activeTyping.get(phoneNumber)!;
      state.taskId = taskId;
      console.log(`🔄 Updated typing indicator task ID for ${phoneNumber} to ${taskId}`);
      return;
    }

    try {
      const chatGuid = `any;-;${phoneNumber}`;
      await this.sdk!.chats.startTyping(chatGuid);
      console.log(`🟢 Started typing indicator for ${phoneNumber} (task: ${taskId})`);

      // Set up auto-refresh
      const refreshTimer = setInterval(async () => {
        await this.refreshTyping(phoneNumber);
      }, TYPING_REFRESH_INTERVAL);

      this.activeTyping.set(phoneNumber, {
        phoneNumber,
        taskId,
        refreshTimer,
        startedAt: Date.now(),
      });
    } catch (error) {
      console.error(`Failed to start typing indicator for ${phoneNumber}:`, error);
      // Non-critical - continue anyway
    }
  }

  /**
   * Refresh typing indicator to prevent timeout
   * Called automatically every 25 seconds
   */
  private async refreshTyping(phoneNumber: string): Promise<void> {
    const state = this.activeTyping.get(phoneNumber);
    if (!state) return;

    try {
      const chatGuid = `any;-;${phoneNumber}`;
      
      // Stop and immediately restart typing to refresh the indicator
      await this.sdk!.chats.stopTyping(chatGuid);
      await new Promise(resolve => setTimeout(resolve, 100)); // Small delay
      await this.sdk!.chats.startTyping(chatGuid);
      
      const durationSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
      console.log(`🔄 Refreshed typing indicator for ${phoneNumber} (active for ${durationSeconds}s)`);
    } catch (error) {
      console.error(`Failed to refresh typing indicator for ${phoneNumber}:`, error);
      // Try to continue anyway - will retry on next interval
    }
  }

  /**
   * Stop typing indicator for a phone number
   */
  async stopTyping(phoneNumber: string): Promise<void> {
    const state = this.activeTyping.get(phoneNumber);
    if (!state) {
      return; // Not currently typing
    }

    try {
      // Clear the refresh timer
      clearInterval(state.refreshTimer);

      // Stop typing indicator
      const chatGuid = `any;-;${phoneNumber}`;
      await this.sdk!.chats.stopTyping(chatGuid);
      
      const durationSeconds = Math.floor((Date.now() - state.startedAt) / 1000);
      console.log(`⏹️  Stopped typing indicator for ${phoneNumber} (was active for ${durationSeconds}s, task: ${state.taskId})`);

      this.activeTyping.delete(phoneNumber);
    } catch (error) {
      console.error(`Failed to stop typing indicator for ${phoneNumber}:`, error);
      // Clean up state anyway
      this.activeTyping.delete(phoneNumber);
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
