export type Person = {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  color?: string;
  status?: string;
};
// Server history uses protected references; the browser supplies an object URL
// once visible media loads. Drafts/demo still use their original data URLs.
export type Attachment = {
  name: string;
  type: string;
  url: string;
  size: number;
  loading?: boolean;
  error?: string;
};
export type Message = {
  id: string;
  conversationId: string;
  author: Person;
  text: string;
  createdAt: string;
  edited?: boolean;
  parentId?: string;
  reactions: { emoji: string; userIds: string[] }[];
  attachments: Attachment[];
  starred?: boolean;
  deleted?: boolean;
};
export type Conversation = {
  id: string;
  name: string;
  kind: 'dm' | 'group' | 'space';
  members: Person[];
  description?: string;
  lastMessage?: string;
  updatedAt: string;
  unread: number;
  pinned?: boolean;
  muted?: boolean;
  section?: string;
};
export type ChatState = { user: Person; conversations: Conversation[]; messages: Message[] };
export type ChatAction = (
  | {
      type: 'send';
      conversationId: string;
      text: string;
      parentId?: string;
      attachments?: Attachment[];
      clientMessageId?: string;
    }
  | { type: 'edit'; messageId: string; text: string }
  | { type: 'delete'; messageId: string }
  | { type: 'react'; messageId: string; emoji: string; active?: boolean }
  | { type: 'star'; messageId: string; starred?: boolean }
  | { type: 'read'; conversationId: string; unread?: boolean }
  | {
      type: 'create';
      name: string;
      kind: 'dm' | 'group' | 'space';
      emails: string[];
      description?: string;
    }
  | {
      type: 'conversation';
      conversationId: string;
      name?: string;
      description?: string;
      pinned?: boolean;
      muted?: boolean;
      section?: string;
    }
  | { type: 'invite'; conversationId: string; emails: string[] }
  | { type: 'leave'; conversationId: string }
  | { type: 'profile'; name?: string; status?: string }
) & { clientActionId?: string; clientActionCreatedAt?: string };
export type SendDraft = Extract<ChatAction, { type: 'send' }>;
export type SendRecovery = { id: string; confirmed: boolean; durable: boolean };
export type ChatController = {
  state: ChatState | null;
  loading: boolean;
  error: string | null;
  demo: boolean;
  authAvailable: boolean;
  offline: boolean;
  action: (action: ChatAction) => Promise<string | undefined>;
  inspectSend: (draft: SendDraft) => Promise<SendRecovery | null>;
  acknowledgeSend: (draft: SendDraft, id: string) => Promise<void>;
  reconcileSendDrafts: (drafts: SendDraft[], hasPartialRestoredDraft?: boolean) => Promise<void>;
  signIn: () => void;
  signingIn: boolean;
  signOut: () => Promise<void>;
  startDemo: () => void;
  clearError: () => void;
  loadAttachment: (messageId: string, index: number) => void;
  retryAttachment: (messageId: string, index: number) => void;
};
