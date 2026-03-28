/**
 * TypingIndicatorManager
 * 
 * Manages persistent typing indicators for active tasks.
 * Automatically refreshes typing indicators every 50 seconds to prevent timeout.
 * Ensures users see continuous typing feedback during long-running tasks.
 */

import { SDK } from '@photon-ai/advanced-imessage-kit';

const TYPING_REFRESH_INTERVAL = 50000;

interface TypingState {
  phoneNumber: string;
  taskId: string;
  refreshTimer: NodeJS.Timeout;
  startedAt: number;
  isRefreshing: boolean;
}

export class TypingIndicatorManager {
  private activeTyping = new Map<string, TypingState>();
  private sdk: ReturnType<typeof SDK> | null = null;

  constructor(private imessageSDK: ReturnType<typeof SDK>) {
    this.sdk = imessageSDK;
  }

  async startTyping(phoneNumber: string, taskId: string): Promise<void> {
    if (this.activeTyping.has(phoneNumber)) {
      const state = this.activeTyping.get(phoneNumber)!;
      state.taskId = taskId;
      return;
    }

    try {
      const chatGuid = `any;-;${phoneNumber}`;
      const start = Date.now();
      await this.sdk!.chats.startTyping(chatGuid);
      console.log(`🟢 Typing started: ${phoneNumber} (task: ${taskId}, ${Date.now() - start}ms)`);

      const refreshTimer = setInterval(async () => {
        await this.refreshTyping(phoneNumber);
      }, TYPING_REFRESH_INTERVAL);

      this.activeTyping.set(phoneNumber, {
        phoneNumber,
        taskId,
        refreshTimer,
        startedAt: Date.now(),
        isRefreshing: false,
      });
    } catch (error) {
      console.error(`❌ Failed to start typing for ${phoneNumber}:`, error);
    }
  }

  private async refreshTyping(phoneNumber: string): Promise<void> {
    const state = this.activeTyping.get(phoneNumber);
    if (!state || state.isRefreshing) return;

    state.isRefreshing = true;
    const refreshStart = Date.now();

    try {
      const chatGuid = `any;-;${phoneNumber}`;
      await this.sdk!.chats.stopTyping(chatGuid);
      await this.sdk!.chats.startTyping(chatGuid);
      const elapsed = Date.now() - refreshStart;
      const activeFor = Math.floor((Date.now() - state.startedAt) / 1000);
      console.log(`🔄 Typing refreshed: ${phoneNumber} (active: ${activeFor}s, took: ${elapsed}ms)`);
    } catch (error) {
      console.error(`❌ Typing refresh failed for ${phoneNumber}:`, error);
    } finally {
      if (state) {
        state.isRefreshing = false;
      }
    }
  }

  async stopTyping(phoneNumber: string): Promise<void> {
    const state = this.activeTyping.get(phoneNumber);
    if (!state) return;

    const activeFor = Math.floor((Date.now() - state.startedAt) / 1000);

    try {
      clearInterval(state.refreshTimer);
      const chatGuid = `any;-;${phoneNumber}`;
      const start = Date.now();
      await this.sdk!.chats.stopTyping(chatGuid);
      console.log(`🛑 Typing stopped: ${phoneNumber} (was active: ${activeFor}s, took: ${Date.now() - start}ms)`);
      this.activeTyping.delete(phoneNumber);
    } catch (error) {
      console.error(`❌ Failed to stop typing for ${phoneNumber}:`, error);
      this.activeTyping.delete(phoneNumber);
    }
  }

  isTyping(phoneNumber: string): boolean {
    return this.activeTyping.has(phoneNumber);
  }

  isRefreshing(phoneNumber: string): boolean {
    return this.activeTyping.get(phoneNumber)?.isRefreshing || false;
  }

  getActiveTaskId(phoneNumber: string): string | null {
    return this.activeTyping.get(phoneNumber)?.taskId || null;
  }

  async stopAll(): Promise<void> {
    const promises = Array.from(this.activeTyping.keys()).map(phoneNumber => 
      this.stopTyping(phoneNumber)
    );
    await Promise.all(promises);
    console.log('🛑 Stopped all typing indicators');
  }

  getActiveCount(): number {
    return this.activeTyping.size;
  }
}
