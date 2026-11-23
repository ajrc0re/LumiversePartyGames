import type { ConditionalChatMetadataDTO } from "lumiverse-spindle-types";
import { mulberry32 } from "../src/engine/rng";
import type { TimelineMessage } from "../src/engine/session";
import { CONDITIONAL_METADATA_CAPABILITY, type ChatRecord, type HostPort } from "../src/backend/service";

/** In-memory Lumiverse stand-in for service tests and the browser harness. */
export interface FakeChat {
  metadata: Record<string, unknown>;
  messages: TimelineMessage[];
}

export class FakeHost implements HostPort {
  chats = new Map<string, FakeChat>();
  permissions = new Set(["chats", "chat_mutation", "interceptor"]);
  capabilities = new Set([CONDITIONAL_METADATA_CAPABILITY]);
  /** userStorage stand-in, by path. */
  storage = new Map<string, unknown>();
  /** What {{user}} resolves to. */
  macroText = "Sam";
  warnings: string[] = [];
  userIds: Array<string | undefined> = [];
  casCalls = 0;
  replaceCalls = 0;
  /** Simulate another writer touching the chat between read and write this many times. */
  conflicts = 0;
  private counter = 0;

  addChat(id: string, messages: TimelineMessage[] = [{ id: "greeting", swipeId: 0 }]): FakeChat {
    const chat = { metadata: { unrelated: "keep me" }, messages };
    this.chats.set(id, chat);
    return chat;
  }

  hasPermission(permission: string): boolean { return this.permissions.has(permission); }
  hasCapability(capability: string): boolean { return this.capabilities.has(capability); }

  async getChat(chatId: string, userId?: string): Promise<ChatRecord | null> {
    this.userIds.push(userId);
    const chat = this.chats.get(chatId);
    return chat ? { id: chatId, metadata: structuredClone(chat.metadata) } : null;
  }

  async getTimeline(chatId: string): Promise<TimelineMessage[]> {
    return [...(this.chats.get(chatId)?.messages ?? [])];
  }

  async compareAndSetMetadata(chatId: string, input: ConditionalChatMetadataDTO, userId?: string): Promise<ChatRecord | null> {
    this.casCalls += 1;
    this.userIds.push(userId);
    const chat = this.chats.get(chatId);
    if (!chat) return null;
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      chat.metadata = { ...chat.metadata, touched: this.casCalls };
      return null;
    }
    const last = chat.messages.at(-1)?.id ?? null;
    if (JSON.stringify(chat.metadata) !== JSON.stringify(input.expected_metadata)) return null;
    if (input.expected_last_message_id !== undefined && input.expected_last_message_id !== last) return null;
    chat.metadata = structuredClone(input.metadata);
    return { id: chatId, metadata: chat.metadata };
  }

  async replaceMetadata(chatId: string, metadata: Record<string, unknown>, userId?: string): Promise<void> {
    this.replaceCalls += 1;
    this.userIds.push(userId);
    const chat = this.chats.get(chatId);
    if (chat) chat.metadata = structuredClone(metadata);
  }

  async resolveMacros(): Promise<string> { return this.macroText; }
  async readJson(path: string): Promise<unknown> { return this.storage.has(path) ? structuredClone(this.storage.get(path)) : null; }
  async writeJson(path: string, value: unknown): Promise<void> { this.storage.set(path, structuredClone(value)); }
  newId(prefix: string): string { return prefix + String(++this.counter); }
  seed(): number { return ++this.counter; }
  rng() { return mulberry32(1234); }
  now(): number { return 1000 + this.counter; }
  warn(message: string): void { this.warnings.push(message); }
}
