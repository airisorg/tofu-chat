'use client';

import dynamic from 'next/dynamic';
import { useMessageToolbarPosition } from './useMessageToolbarPosition';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  ArrowDownToLine,
  ArrowLeft,
  ArrowUpRight,
  Bell,
  BellOff,
  Check,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Copy,
  Ellipsis,
  File,
  Hash,
  Home,
  Info,
  Link,
  LogOut,
  LoaderCircle,
  Menu,
  Mic,
  MessageCircle,
  MessageSquare,
  Pencil,
  Paperclip,
  Pin,
  PictureInPicture2,
  Maximize2,
  History,
  Plus,
  Search,
  SendHorizontal,
  Settings,
  Smile,
  Star,
  Trash2,
  Users,
  Video,
  X,
  AtSign,
  Folder,
  Palette,
  PanelRight,
  Smartphone,
} from 'lucide-react';
import { useChat } from '@/lib/use-chat';
import { indexReplies } from '@/lib/message-index';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from '@/lib/media-limits';
import { restoreDraftMap, type DraftMap } from '@/lib/draft-storage';
import {
  draftSavingKey,
  readDraftSaving,
  savedDraftsKey,
  writeDraftSaving,
} from '@/lib/draft-preference';
import VoiceRecorder from './VoiceRecorder';
import AudioPreview from './AudioPreview';
import avatarAvailability from './AvatarAvailability.module.css';
import splitStyles from './ChatAppSplit.module.css';
import sidebarMotion from './SidebarMotion.module.css';
import HomeControls, { type HomeKind } from './HomeControls';
import InstallHelp from './InstallHelp';
import ProfileForm, { type ProfileValues } from './ProfileForm';
import ContextPopover from './ContextPopover';
import LandingDetails from './LandingDetails';
import LandingChatPreview from './LandingChatPreview';
import { MaterialHelp, MaterialSettings, MaterialNewChat } from './MaterialIcons';
import MediaAttachment from './MediaAttachment';
import MiniConversation, { type MiniDraft } from './MiniConversation';
import SearchFilters from './SearchFilters';
import {
  DEFAULT_SEARCH_FILTERS,
  hasSearchFilters,
  mentionsUser,
  searchLoadedMessages,
  type SearchFilters as SearchValues,
} from '@/lib/search';
import NewConversationForm, { type NewConversation } from './NewConversationForm';
import { isCompactViewport, installPlatform } from './platform';
import type { Attachment, ChatAction, Conversation, Message, Person } from '@/lib/types';

type View = 'home' | 'direct' | 'spaces' | 'mentions' | 'starred' | 'sections' | 'search';
type Modal =
  | { type: 'new'; kind: Conversation['kind'] }
  | {
      type: 'settings' | 'profile' | 'install' | 'more' | 'voice' | 'status' | 'support' | 'guide';
    }
  | {
      type: 'conversation' | 'invite' | 'about' | 'leave';
      conversation: Conversation;
    }
  | { type: 'message' | 'edit' | 'delete' | 'emoji'; message: Message }
  | { type: 'attachment'; attachment: Attachment }
  | { type: 'insertEmoji' }
  | null;
const EmojiPicker = dynamic(() => import('./EmojiPicker'), { ssr: false });
const names: Record<View, string> = {
  home: 'Home',
  direct: 'Direct messages',
  spaces: 'Spaces',
  mentions: 'Mentions',
  starred: 'Starred',
  sections: 'Sections',
  search: 'Search results',
};
function initials(name: string) {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((x) => x[0])
    .join('')
    .toUpperCase();
}
function time(date: string) {
  return new Date(date).toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  });
}
function dateLabel(date: string) {
  const d = new Date(date);
  return d.toDateString() === new Date().toDateString()
    ? 'Today'
    : d.toLocaleDateString([], { month: 'long', day: 'numeric' });
}
function AvatarPhoto({ person }: { person: Person }) {
  const [failed, setFailed] = useState(false);
  return failed ? (
    initials(person.name)
  ) : (
    <img src={person.avatar} alt="" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
  );
}
function Avatar({
  person,
  size = '',
  showAvailability = false,
}: {
  person: Person;
  size?: string;
  showAvailability?: boolean;
}) {
  // A saved manual status describes availability, not a live connection.
  const savedStatus = person.status?.trim().toLowerCase();
  const availability =
    savedStatus === 'available' || savedStatus === 'active'
      ? { kind: 'active', label: savedStatus === 'available' ? 'Available' : 'Active' }
      : savedStatus === 'away'
        ? { kind: 'away', label: 'Away' }
        : savedStatus === 'do not disturb'
          ? { kind: 'dnd', label: 'Do not disturb' }
          : null;
  const hex = (person.color || '#c2e7ff').replace('#', '');
  const dark =
    hex.length === 6 &&
    parseInt(hex.slice(0, 2), 16) * 0.299 +
      parseInt(hex.slice(2, 4), 16) * 0.587 +
      parseInt(hex.slice(4, 6), 16) * 0.114 <
      150;
  return (
    <span
      className={`avatar ${size}`}
      style={{
        background: person.color || '#c2e7ff',
        color: dark ? '#fff' : '#183650',
      }}
    >
      {person.avatar ? (
        <AvatarPhoto key={`${person.id}:${person.avatar}`} person={person} />
      ) : (
        initials(person.name)
      )}
      {showAvailability && availability && (
        <span
          className={`${avatarAvailability.indicator} ${avatarAvailability[availability.kind]}`}
          role="img"
          aria-label={`Saved availability: ${availability.label}`}
          title={`Saved availability: ${availability.label}`}
          data-saved-availability={availability.kind}
        />
      )}
    </span>
  );
}
function ConversationAvatar({
  conversation,
  small = false,
  userId,
}: {
  conversation: Conversation;
  small?: boolean;
  userId?: string;
}) {
  return conversation.kind === 'dm' ? (
    <Avatar
      person={
        conversation.members.find((p) => p.id !== userId) || {
          id: '',
          name: conversation.name,
          email: '',
        }
      }
      size={small ? 'small' : ''}
      showAvailability
    />
  ) : (
    <span
      className={`space-avatar ${small ? 'small' : ''}`}
      style={{
        background: conversation.kind === 'space' ? '#d3e3fd' : '#c4eed0',
      }}
    >
      {conversation.kind === 'space' ? (
        <Hash size={small ? 17 : 22} />
      ) : (
        <Users size={small ? 17 : 22} />
      )}
    </span>
  );
}
function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <span className={`brand ${compact ? 'compact' : ''}`}>
      <span className="brand-mark">
        <MessageSquare size={compact ? 23 : 28} strokeWidth={2.6} />
        <span />
      </span>
      {!compact && <span>Chat</span>}
    </span>
  );
}
function IconButton({
  label,
  children,
  className = '',
  onClick,
  disabled = false,
  expanded,
  controls,
}: {
  label: string;
  children: ReactNode;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  expanded?: boolean;
  controls?: string;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${className}`}
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      aria-expanded={expanded}
      aria-controls={controls}
    >
      {children}
    </button>
  );
}
function Dialog({
  title,
  children,
  onClose,
  wide = false,
  contextual = false,
  anchor,
  formPopover = false,
  emojiPopover = false,
  messagePopover = false,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  contextual?: boolean;
  anchor?: HTMLElement | null;
  formPopover?: boolean;
  emojiPopover?: boolean;
  messagePopover?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (contextual) return;
    const previous = document.activeElement as HTMLElement;
    const dialog = ref.current;
    const nodes = () =>
      Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
        ) || [],
      );
    const first = nodes().find((x) => x.tagName === 'INPUT') || nodes()[0];
    first?.focus();
    function key(event: globalThis.KeyboardEvent) {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') {
        const elements = nodes();
        if (!elements.length) return;
        const current = elements.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey
          ? current <= 0
            ? elements.length - 1
            : current - 1
          : (current + 1) % elements.length;
        event.preventDefault();
        elements[next].focus();
      }
    }
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, [onClose, title, contextual]);
  if (contextual)
    return (
      <ContextPopover
        title={title}
        anchor={anchor}
        onClose={onClose}
        variant={
          formPopover ? 'form' : emojiPopover ? 'emoji' : messagePopover ? 'message' : 'menu'
        }
        hideHeader={
          formPopover ||
          emojiPopover ||
          (messagePopover && !window.matchMedia('(max-width: 767px), (pointer: coarse)').matches)
        }
      >
        {children}
      </ContextPopover>
    );
  return (
    <div
      className="dialog-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        className={`dialog ${wide ? 'wide' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="dialog-title"
      >
        <div className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <IconButton label="Close dialog" onClick={onClose}>
            <X size={22} />
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}

export default function ChatApp() {
  const chat = useChat();
  const demoAvailable =
    process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_ENABLE_DEMO === 'true';
  const [view, setView] = useState<View>('home');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [homePreview, setHomePreview] = useState(false);
  const [splitEnabled, setSplitEnabled] = useState(true);
  const [splitDesktop, setSplitDesktop] = useState(false);
  const homeRowTrigger = useRef<HTMLButtonElement | null>(null);
  const splitToggleRef = useRef<HTMLButtonElement>(null);
  const homeResizeFocus = useRef<{
    owner: string;
    generation: number;
    conversationId: string;
    source: HTMLElement;
    home: HTMLElement;
  } | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [threadsOnly, setThreadsOnly] = useState(false);
  const [homeKind, setHomeKind] = useState<HomeKind>('all');
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [shortcutsExpanded, setShortcutsExpanded] = useState(true);
  const [directExpanded, setDirectExpanded] = useState(true);
  const [spacesExpanded, setSpacesExpanded] = useState(true);
  const [compactViewport, setCompactViewport] = useState(false);
  const [searchScope, setSearchScope] = useState<string | null>(null);
  const [searchFilters, setSearchFilters] = useState<SearchValues>(DEFAULT_SEARCH_FILTERS);
  const [jumpTarget, setJumpTarget] = useState<string | null>(null);
  const atBottom = useRef(true);
  const threadAtBottom = useRef(true);
  const [modal, setModal] = useState<Modal>(null);
  const [draft, setDraft] = useState('');
  const [threadDraft, setThreadDraft] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [miniId, setMiniId] = useState<string | null>(null);
  const [miniMinimized, setMiniMinimized] = useState(false);
  const [miniDesktop, setMiniDesktop] = useState(false);
  const [miniDraft, setMiniDraft] = useState<MiniDraft>({ text: '', attachments: [] });
  const miniIdRef = useRef<string | null>(null);
  const miniOwner = useRef<string | null>(null);
  const miniReturnFocus = useRef<{
    owner: string;
    generation: number;
    trigger: HTMLElement | null;
  } | null>(null);
  const miniGeneration = useRef(0);
  const miniDraftMap = useRef<Record<string, MiniDraft>>({});
  const miniPending = useRef(new Set<string>());
  const [miniPendingIds, setMiniPendingIds] = useState<string[]>([]);
  const expandedMiniDraft = useRef<Record<string, MiniDraft>>({});
  const mainDraftNow = useRef({ selectedId, text: draft, attachments });
  mainDraftNow.current = { selectedId, text: draft, attachments };
  const threadDraftNow = useRef({ selectedId, threadId, text: threadDraft });
  threadDraftNow.current = { selectedId, threadId, text: threadDraft };
  const homeLayoutNow = useRef({ view, homePreview, splitEnabled, splitDesktop, threadId });
  homeLayoutNow.current = { view, homePreview, splitEnabled, splitDesktop, threadId };
  const [sending, setSending] = useState(false);
  const [sendFeedback, setSendFeedback] = useState<
    Record<
      string,
      {
        stage: 'sending' | 'unconfirmed';
        text: string;
        attachments: Attachment[];
        durable?: boolean;
      }
    >
  >({});
  const [draftStorageIssue, setDraftStorageIssue] = useState<'attachments' | 'all' | null>(null);
  const [saveDrafts, setSaveDrafts] = useState(true);
  const draftRetention = useRef<{ owner: string | null; enabled: boolean }>({
    owner: null,
    enabled: true,
  });
  const dialogInFlight = useRef(new Set<NonNullable<Modal>>());
  const [pendingDialogs, setPendingDialogs] = useState(new Set<NonNullable<Modal>>());
  const busy = !!modal && pendingDialogs.has(modal);
  const [toast, setToast] = useState('');
  const [theme, setTheme] = useState('system');
  const [themeReady, setThemeReady] = useState(false);
  const [requestedInvitation, setRequestedInvitation] = useState('');
  const [landingDeviceLabel, setLandingDeviceLabel] = useState('Works in your browser');
  const [installPrompt, setInstallPrompt] = useState<
    (Event & { prompt: () => Promise<void> }) | null
  >(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const fileReadQueue = useRef<Promise<void>>(Promise.resolve());
  const fileReaders = useRef(new Set<FileReader>());
  const fileSelection = useRef({ owner: '', conversationId: '', revision: 0 });
  const searchRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const threadComposerRef = useRef<HTMLTextAreaElement>(null);
  const previousUser = useRef<string | null>(null);
  const closeModal = useCallback(() => setModal(null), []);
  const menuAnchor = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const update = () => setCompactViewport(isCompactViewport());
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  useEffect(() => {
    const touch = window.matchMedia('(pointer: coarse)');
    const update = () => setMiniDesktop(!isCompactViewport() && !touch.matches);
    update();
    window.addEventListener('resize', update);
    touch.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      touch.removeEventListener('change', update);
    };
  }, []);
  useEffect(() => {
    // A split view needs two usable panes; compact/touch layouts stay full-screen.
    const media = window.matchMedia(
      '(min-width: 1200px) and (min-height: 501px) and (pointer: fine)',
    );
    const update = () => {
      homeResizeFocus.current = null;
      const layout = homeLayoutNow.current;
      const source = document.activeElement;
      const home = source instanceof HTMLElement ? source.closest<HTMLElement>('.home-view') : null;
      const owner = currentUserNow.current;
      const conversationId = mainDraftNow.current.selectedId;
      // A populated preview removes Home entirely when it becomes full-screen.
      // Capture actual owned focus before that branch and its menu disappear.
      if (
        !media.matches &&
        layout.splitDesktop &&
        layout.homePreview &&
        layout.splitEnabled &&
        layout.view === 'home' &&
        !layout.threadId &&
        owner &&
        owner === draftOwner.current &&
        conversationId &&
        source instanceof HTMLElement &&
        source !== document.body &&
        home
      ) {
        homeResizeFocus.current = {
          owner,
          generation: miniGeneration.current,
          conversationId,
          source,
          home,
        };
      }
      setSplitDesktop(media.matches);
    };
    const cancelForPointer = () => {
      homeResizeFocus.current = null;
    };
    const cancelForOutsideFocus = (event: globalThis.FocusEvent) => {
      const pending = homeResizeFocus.current;
      if (pending && event.target instanceof Node && !pending.home.contains(event.target))
        homeResizeFocus.current = null;
    };
    update();
    media.addEventListener('change', update);
    document.addEventListener('pointerdown', cancelForPointer, true);
    document.addEventListener('focusin', cancelForOutsideFocus, true);
    return () => {
      media.removeEventListener('change', update);
      document.removeEventListener('pointerdown', cancelForPointer, true);
      document.removeEventListener('focusin', cancelForOutsideFocus, true);
    };
  }, []);
  async function installApp() {
    if (!installPrompt) return;
    try {
      await installPrompt.prompt();
    } catch {
      setToast('Installation did not complete. You can use your browser menu to try again.');
    } finally {
      setInstallPrompt(null);
    }
  }
  const draftMap = useRef<DraftMap>({});
  const recoveredDrafts = useRef<DraftMap>({});
  const recoveredReceiptOwner = useRef<string | null>(null);
  const threadDraftMap = useRef<Record<string, string>>({});
  const threadDraftRevision = useRef<Record<string, number>>({});
  const draftOwner = useRef<string | null>(null);
  const [renderedDraftOwner, setRenderedDraftOwner] = useState<string | null>(null);
  const state = chat.state;
  const modalContext = useRef({ owner: state?.user.id, modal });
  modalContext.current = { owner: state?.user.id, modal };
  const profileInFlight = useRef(new Set<string>());
  const [profilePendingOwners, setProfilePendingOwners] = useState(new Set<string>());
  const currentUserNow = useRef<string | null>(null);
  currentUserNow.current = state?.user.id || null;
  const fileOwner = state?.user.id || '';
  const fileConversation = selectedId || '';
  if (
    fileSelection.current.owner !== fileOwner ||
    fileSelection.current.conversationId !== fileConversation
  ) {
    fileSelection.current = {
      owner: fileOwner,
      conversationId: fileConversation,
      revision: fileSelection.current.revision + 1,
    };
  }
  useEffect(() => {
    const readers = fileReaders.current;
    return () => {
      for (const reader of readers) reader.abort();
      readers.clear();
    };
  }, [fileOwner, fileConversation]);
  const selected = state?.conversations.find((c) => c.id === selectedId);
  const miniConversation = state?.conversations.find((c) => c.id === miniId);
  const replyIndex = useMemo(() => indexReplies(state?.messages || []), [state?.messages]);
  const messages =
    state?.messages.filter((m) => m.conversationId === selectedId && !m.parentId) || [];
  const thread = state?.messages.find((m) => m.id === threadId);
  const previewActive = !!selected && homePreview && splitEnabled && splitDesktop && !thread;
  const emptyPreview = !selected && view === 'home' && splitEnabled && splitDesktop;
  const replies = state?.messages.filter((m) => m.parentId === threadId) || [];
  const sectionNames = [
    ...new Set(state?.conversations.map((c) => c.section).filter(Boolean) || []),
  ];
  useEffect(() => {
    const platform = installPlatform();
    setLandingDeviceLabel(
      platform === 'android'
        ? 'Made for Android'
        : platform === 'ios-safari' || platform === 'ios-other'
          ? 'Made for iPhone and iPad'
          : 'Works in your browser',
    );
    try {
      const saved = localStorage.getItem('relay-theme');
      if (saved && ['system', 'light', 'dark'].includes(saved)) setTheme(saved);
    } catch {
      /* Storage can be blocked by browser privacy settings. */
    }
    setThemeReady(true);
    try {
      const invitation = new URLSearchParams(window.location.search).get('join');
      if (invitation) sessionStorage.setItem('chat-pending-invitation', invitation.slice(0, 120));
      setRequestedInvitation(sessionStorage.getItem('chat-pending-invitation') || '');
    } catch {}
    const listener = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as Event & { prompt: () => Promise<void> });
    };
    window.addEventListener('beforeinstallprompt', listener);
    return () => window.removeEventListener('beforeinstallprompt', listener);
  }, []);
  useEffect(() => {
    const dark = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () =>
      (document.documentElement.dataset.theme =
        theme === 'system' ? (dark.matches ? 'dark' : 'light') : theme);
    apply();
    dark.addEventListener('change', apply);
    if (themeReady) {
      try {
        localStorage.setItem('relay-theme', theme);
      } catch {
        /* Appearance still works for this visit. */
      }
    }
    return () => dark.removeEventListener('change', apply);
  }, [theme, themeReady]);
  useEffect(() => {
    const userId = state?.user.id || null;
    if (previousUser.current === userId) return;
    if (previousUser.current) {
      try {
        localStorage.removeItem(`relay-drafts:${previousUser.current}`);
      } catch {}
    }
    previousUser.current = userId;
    setHomePreview(false);
    setUnreadOnly(false);
    setPinnedOnly(false);
    setThreadsOnly(false);
    setHomeKind('all');
    let split = true;
    if (userId) {
      try {
        split = localStorage.getItem(`relay-home-split:${userId}`) !== 'off';
      } catch {}
    }
    setSplitEnabled(split);
    draftOwner.current = userId;
    let enabled = true;
    if (userId) {
      try {
        enabled = readDraftSaving(userId, localStorage);
      } catch {}
    }
    draftRetention.current = { owner: userId, enabled };
    setSaveDrafts(enabled);
    setRenderedDraftOwner(userId);
    draftMap.current = {};
    recoveredDrafts.current = {};
    recoveredReceiptOwner.current = null;
    threadDraftMap.current = {};
    threadDraftRevision.current = {};
    miniDraftMap.current = {};
    miniGeneration.current += 1;
    miniPending.current.clear();
    setMiniPendingIds([]);
    expandedMiniDraft.current = {};
    miniOwner.current = null;
    miniReturnFocus.current = null;
    miniIdRef.current = null;
    setMiniId(null);
    setMiniMinimized(false);
    setMiniDraft({ text: '', attachments: [] });
    setDraft('');
    setAttachments([]);
    setSending(false);
    setSendFeedback({});
    setDraftStorageIssue(null);
    setThreadDraft('');
    setThreadId(null);
    setSelectedId(null);
    setQuery('');
    setSearchScope(null);
    setJumpTarget(null);
    setSearchFilters(DEFAULT_SEARCH_FILTERS);
    setModal(null);
    if (userId && state) {
      try {
        if (enabled)
          draftMap.current = restoreDraftMap(
            localStorage.getItem(savedDraftsKey(userId)),
            state.conversations,
          );
        else localStorage.removeItem(savedDraftsKey(userId));
      } catch {}
      recoveredDrafts.current = { ...draftMap.current };
      let invitation = '';
      try {
        invitation = sessionStorage.getItem('chat-pending-invitation') || '';
      } catch {}
      const invitedConversation = state.conversations.find((c) => c.id === invitation);
      if (invitedConversation || (chat.demo && !isCompactViewport())) {
        const initial =
          invitedConversation ||
          (chat.demo ? state.conversations.find((c) => /design/i.test(c.name)) : undefined) ||
          state.conversations[0];
        if (initial) {
          setSelectedId(initial.id);
          setDraft(draftMap.current[initial.id]?.text || '');
          setAttachments(draftMap.current[initial.id]?.attachments || []);
        }
      }
      if (invitedConversation) {
        try {
          sessionStorage.removeItem('chat-pending-invitation');
        } catch {}
        setRequestedInvitation('');
      } else if (invitation && !chat.demo) {
        setToast('Ask your friend to add your Google email to this conversation, then refresh.');
      }
    }
  }, [state, chat.demo]);
  function persistDrafts(owner: string): boolean {
    if (draftOwner.current !== owner || draftRetention.current.owner !== owner) return false;
    if (!draftRetention.current.enabled) {
      try {
        return localStorage.getItem(savedDraftsKey(owner)) === null;
      } catch {
        return false;
      }
    }
    try {
      // Another tab can opt this account out before its storage event arrives.
      if (!readDraftSaving(owner, localStorage)) {
        draftRetention.current.enabled = false;
        setSaveDrafts(false);
        setDraftStorageIssue(null);
        return localStorage.getItem(savedDraftsKey(owner)) === null;
      }
      const raw = JSON.stringify(draftMap.current);
      localStorage.setItem(savedDraftsKey(owner), raw);
      if (localStorage.getItem(savedDraftsKey(owner)) !== raw)
        throw new Error('Draft storage did not retain this change.');
      setDraftStorageIssue(null);
      return true;
    } catch {
      try {
        const raw = JSON.stringify(
          Object.fromEntries(
            Object.entries(draftMap.current).map(([id, d]) => [
              id,
              {
                text: d.text,
                attachments: [],
                ...(d.attachments.length || d.omittedAttachments
                  ? { omittedAttachments: true }
                  : {}),
              },
            ]),
          ),
        );
        localStorage.setItem(savedDraftsKey(owner), raw);
        if (localStorage.getItem(savedDraftsKey(owner)) !== raw)
          throw new Error('Draft storage did not retain this change.');
        setDraftStorageIssue('attachments');
        return true;
      } catch {
        setDraftStorageIssue('all');
        return false;
      }
    }
  }
  function changeDraftSaving(enabled: boolean) {
    const owner = state?.user.id;
    if (!owner || currentUserNow.current !== owner || draftOwner.current !== owner) return;
    draftRetention.current = { owner, enabled };
    setSaveDrafts(enabled);
    setDraftStorageIssue(null);
    let result = { preferenceSaved: false, savedDraftsRemoved: false };
    try {
      result = writeDraftSaving(owner, enabled, localStorage);
    } catch {}
    if (enabled && !result.preferenceSaved) {
      draftRetention.current.enabled = false;
      setSaveDrafts(false);
      setToast(
        'Draft saving could not be enabled. Your current drafts remain available for this visit.',
      );
      return;
    }
    if (enabled) persistDrafts(owner);
    if (!result.preferenceSaved || (!enabled && !result.savedDraftsRemoved)) {
      setToast(
        !enabled && !result.savedDraftsRemoved
          ? 'Draft saving is off for this visit, but saved copies could not be cleared. Check this site’s browser data.'
          : 'Your choice applies to this visit, but could not be saved for future visits.',
      );
    } else if (!enabled)
      setToast('Draft saving is off. Current drafts stay available for this visit.');
  }
  useEffect(() => {
    const owner = state?.user.id;
    if (!owner) return;
    const changed = (event: StorageEvent) => {
      if (
        event.key !== draftSavingKey(owner) ||
        currentUserNow.current !== owner ||
        draftOwner.current !== owner
      )
        return;
      try {
        if (event.storageArea !== localStorage) return;
        const enabled = readDraftSaving(owner, localStorage);
        draftRetention.current = { owner, enabled };
        setSaveDrafts(enabled);
        setDraftStorageIssue(null);
        if (enabled) persistDrafts(owner);
        else localStorage.removeItem(savedDraftsKey(owner));
      } catch {
        /* Active drafts remain available if storage is inaccessible. */
      }
    };
    window.addEventListener('storage', changed);
    return () => window.removeEventListener('storage', changed);
  }, [state?.user.id]);
  useEffect(() => {
    if (
      !selectedId ||
      !fileOwner ||
      draftOwner.current !== fileOwner ||
      renderedDraftOwner !== fileOwner
    )
      return;
    // Keep an unchanged draft's identity across navigation. A new object
    // records an edit, even if the user later restores the original text.
    const stored = draftMap.current[selectedId];
    if (stored?.text !== draft || stored.attachments !== attachments)
      draftMap.current[selectedId] = { text: draft, attachments };
    persistDrafts(fileOwner);
  }, [draft, attachments, selectedId, fileOwner, renderedDraftOwner]);
  const { inspectSend, acknowledgeSend, reconcileSendDrafts } = chat;
  useEffect(() => {
    const owner = state?.user.id;
    if (!owner || renderedDraftOwner !== owner || draftOwner.current !== owner) return;
    const generation = miniGeneration.current;
    let cancelled = false;
    const stillOwned = () =>
      !cancelled &&
      currentUserNow.current === owner &&
      draftOwner.current === owner &&
      miniGeneration.current === generation;
    const recovered = Object.entries(recoveredDrafts.current);
    void (async () => {
      // The complete restored snapshot must be known before pruning receipts:
      // a confirmed UUID may still protect a durable draft from an earlier exit.
      if (recoveredReceiptOwner.current !== owner) {
        await reconcileSendDrafts(
          recovered.map(([conversationId, value]) => ({
            type: 'send',
            conversationId,
            text: value.text.trim(),
            attachments: value.attachments,
          })),
          recovered.some(([, value]) => value.omittedAttachments === true),
        );
        if (!stillOwned()) return;
        recoveredReceiptOwner.current = owner;
      }
      for (const [conversationId, value] of recovered) {
        if (!stillOwned()) return;
        if (draftMap.current[conversationId] !== value) {
          delete recoveredDrafts.current[conversationId];
          continue;
        }
        const action: Extract<ChatAction, { type: 'send' }> = {
          type: 'send',
          conversationId,
          text: value.text.trim(),
          attachments: value.attachments,
        };
        const receipt = await inspectSend(action);
        if (!stillOwned()) return;
        if (draftMap.current[conversationId] !== value) continue;
        if (!receipt) {
          delete recoveredDrafts.current[conversationId];
          continue;
        }
        const key = `${conversationId}:main`;
        if (receipt.confirmed) {
          draftMap.current[conversationId] = { text: '', attachments: [] };
          const current = mainDraftNow.current;
          if (
            current.selectedId === conversationId &&
            current.text === value.text &&
            current.attachments === value.attachments
          ) {
            setDraft('');
            setAttachments([]);
          }
          setSendFeedback((previous) => {
            const next = { ...previous };
            delete next[key];
            return next;
          });
          // Keep the confirmed receipt if the old durable draft could not be
          // removed. A later reload can then recover by the same UUID safely.
          if (persistDrafts(owner)) await acknowledgeSend(action, receipt.id);
          delete recoveredDrafts.current[conversationId];
        } else {
          setSendFeedback((previous) => ({
            ...previous,
            [key]: {
              stage: 'unconfirmed',
              text: value.text,
              attachments: value.attachments,
              durable: receipt.durable,
            },
          }));
        }
      }
    })().catch(() => {
      /* Account transitions preserve drafts; a future sync can retry recovery. */
    });
    return () => {
      cancelled = true;
    };
  }, [state, renderedDraftOwner, inspectSend, acknowledgeSend, reconcileSendDrafts]);
  useEffect(() => {
    const pending = homeResizeFocus.current;
    if (!pending || splitDesktop) return;
    homeResizeFocus.current = null;
    // This runs after the removal commits; a surviving or deliberately changed
    // focus, account, dialog or conversation must never be replaced.
    if (
      currentUserNow.current !== pending.owner ||
      draftOwner.current !== pending.owner ||
      miniGeneration.current !== pending.generation ||
      selected?.id !== pending.conversationId ||
      mainDraftNow.current.selectedId !== pending.conversationId ||
      view !== 'home' ||
      threadId ||
      modalContext.current.modal ||
      pending.source.isConnected ||
      document.activeElement !== document.body
    )
      return;
    const input = composerRef.current;
    if (input?.isConnected && input.getClientRects().length) input.focus({ preventScroll: true });
  }, [splitDesktop, selected?.id, view, threadId]);
  useEffect(() => {
    if (threadId) setThreadDraft(threadDraftMap.current[threadId] || '');
    else setThreadDraft('');
  }, [threadId]);
  useEffect(() => {
    const input = composerRef.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, isCompactViewport() ? 110 : 140)}px`;
    }
  }, [draft, selectedId, previewActive, compactViewport]);
  useEffect(() => {
    const input = threadComposerRef.current;
    if (input) {
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 110)}px`;
    }
  }, [threadDraft, threadId]);
  function updateThreadDraft(text: string) {
    setThreadDraft(text);
    if (threadId) {
      if (threadDraftMap.current[threadId] !== text)
        threadDraftRevision.current[threadId] = (threadDraftRevision.current[threadId] || 0) + 1;
      threadDraftMap.current[threadId] = text;
    }
  }
  useEffect(() => {
    atBottom.current = true;
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [selectedId]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && atBottom.current)
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'auto' });
  }, [messages.length]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => {
      if (atBottom.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [selectedId, messages.length]);
  useEffect(() => {
    threadAtBottom.current = true;
    const scroller = threadScrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [threadId]);
  useEffect(() => {
    const scroller = threadScrollRef.current;
    if (scroller && threadAtBottom.current) scroller.scrollTop = scroller.scrollHeight;
  }, [replies.length]);
  useEffect(() => {
    const scroller = threadScrollRef.current;
    if (!scroller) return;
    const observer = new ResizeObserver(() => {
      if (threadAtBottom.current) scroller.scrollTop = scroller.scrollHeight;
    });
    observer.observe(scroller);
    for (const child of scroller.children) observer.observe(child);
    return () => observer.disconnect();
  }, [threadId, replies.length]);
  useEffect(() => {
    if (!jumpTarget || !selectedId) return;
    const timer = window.setTimeout(() => {
      const behavior = window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'auto'
        : 'smooth';
      // Target navigation takes precedence over bottom retention while media
      // settles; otherwise a ResizeObserver can cancel the smooth jump.
      atBottom.current = false;
      threadAtBottom.current = false;
      document
        .getElementById(`message-${jumpTarget}`)
        ?.scrollIntoView({ block: 'center', behavior });
    }, 60);
    const clear = window.setTimeout(() => setJumpTarget(null), 2500);
    return () => {
      window.clearTimeout(timer);
      window.clearTimeout(clear);
    };
  }, [selectedId, jumpTarget]);
  useEffect(() => {
    if (selectedId && state && !state.conversations.some((c) => c.id === selectedId)) {
      setSelectedId(null);
      setThreadId(null);
    }
  }, [selectedId, state]);
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(''), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    function shortcut(e: globalThis.KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    }
    window.addEventListener('keydown', shortcut);
    return () => window.removeEventListener('keydown', shortcut);
  }, []);
  async function act(action: ChatAction, success?: string) {
    const owner = currentUserNow.current;
    const generation = miniGeneration.current;
    const current = () =>
      !!owner &&
      currentUserNow.current === owner &&
      draftOwner.current === owner &&
      miniGeneration.current === generation;
    try {
      const result = await chat.action(action);
      if (success && current()) setToast(success);
      return result;
    } catch (error) {
      if (current())
        setToast(
          error instanceof Error ? error.message : 'Something went wrong. Please try again.',
        );
      throw error;
    }
  }
  function run(action: ChatAction, success?: string) {
    void act(action, success).catch(() => {});
  }
  function openConversation(conversation: Conversation) {
    setHomePreview(false);
    setSelectedId(conversation.id);
    setThreadId(null);
    setDraft(draftMap.current[conversation.id]?.text || '');
    setAttachments(draftMap.current[conversation.id]?.attachments || []);
    setQuery('');
    setSearchScope(null);
    setSearchFilters(DEFAULT_SEARCH_FILTERS);
    if (conversation.unread) run({ type: 'read', conversationId: conversation.id });
  }
  function openHomeConversation(conversation: Conversation, trigger: HTMLButtonElement) {
    openConversation(conversation);
    if (view === 'home' && splitEnabled && splitDesktop) {
      homeRowTrigger.current = trigger;
      setHomePreview(true);
    }
  }
  function expandPreview() {
    const scroller = scrollRef.current;
    const top = scroller?.getBoundingClientRect().top || 0;
    const anchor =
      scroller && !atBottom.current
        ? [...scroller.querySelectorAll<HTMLElement>('article')].find(
            (row) => row.getBoundingClientRect().bottom > top,
          )
        : undefined;
    const offset = anchor ? anchor.getBoundingClientRect().top - top : 0;
    setHomePreview(false);
    requestAnimationFrame(() => {
      // Changing pane width and intro height must not move the reader to a
      // different older message. The section and article nodes stay mounted.
      if (scroller && anchor?.isConnected)
        scroller.scrollTop +=
          anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offset;
      composerRef.current?.focus({ preventScroll: true });
    });
  }
  function closePreview(returnToOptions = false, preferredFocus?: HTMLElement | null) {
    setSelectedId(null);
    setThreadId(null);
    setHomePreview(false);
    requestAnimationFrame(() => {
      const trigger = preferredFocus?.isConnected
        ? preferredFocus
        : returnToOptions
          ? splitToggleRef.current
          : homeRowTrigger.current;
      if (trigger?.isConnected) trigger.focus();
      else splitToggleRef.current?.focus();
    });
  }
  function toggleSplit(focusTarget: HTMLElement | null = splitToggleRef.current) {
    const enabled = !splitEnabled;
    setSplitEnabled(enabled);
    if (state) {
      try {
        localStorage.setItem(`relay-home-split:${state.user.id}`, enabled ? 'on' : 'off');
      } catch {}
    }
    // Turning off a preview leaves Home open; its draft remains in the draft map.
    if (!enabled && homePreview) closePreview(true, focusTarget);
    else if (!enabled && emptyPreview)
      requestAnimationFrame(() => {
        const trigger = focusTarget?.isConnected ? focusTarget : splitToggleRef.current;
        trigger?.focus({ preventScroll: true });
      });
  }
  function closeMini(restoreFocus = false) {
    const ticket = miniReturnFocus.current;
    miniReturnFocus.current = null;
    miniIdRef.current = null;
    setMiniId(null);
    setMiniMinimized(false);
    if (!restoreFocus || !ticket) return;
    requestAnimationFrame(() => {
      if (
        miniIdRef.current ||
        currentUserNow.current !== ticket.owner ||
        draftOwner.current !== ticket.owner ||
        miniGeneration.current !== ticket.generation
      )
        return;
      const target = [
        ticket.trigger,
        composerRef.current,
        splitToggleRef.current,
        searchRef.current,
      ].find(
        (node) => node?.isConnected && node.getClientRects().length && !node.matches(':disabled'),
      );
      target?.focus({ preventScroll: true });
    });
  }
  function openMini(conversation: Conversation) {
    setModal(null);
    if (!state || draftOwner.current !== state.user.id) return;
    if (isCompactViewport() || window.matchMedia('(pointer: coarse)').matches) {
      openConversation(conversation);
      return;
    }
    if (miniId && miniId !== conversation.id)
      setToast('One pop-up at a time. Drafts stay with each conversation.');
    const active = document.activeElement;
    miniReturnFocus.current = {
      owner: state.user.id,
      generation: miniGeneration.current,
      trigger:
        active instanceof HTMLElement &&
        active !== document.body &&
        !active.closest('[role="dialog"]')
          ? active
          : menuAnchor.current,
    };
    miniOwner.current = state.user.id;
    miniIdRef.current = conversation.id;
    setMiniId(conversation.id);
    setMiniMinimized(false);
    const value = miniDraftMap.current[conversation.id] || { text: '', attachments: [] };
    miniDraftMap.current[conversation.id] = value;
    setMiniDraft(value);
    if (conversation.unread) run({ type: 'read', conversationId: conversation.id });
  }
  function updateMiniDraft(value: MiniDraft) {
    if (!state || !miniId || miniOwner.current !== state.user.id) return;
    miniDraftMap.current[miniId] = value;
    setMiniDraft(value);
  }
  async function sendMini(value: MiniDraft) {
    if (!state || !miniId || miniOwner.current !== state.user.id) return;
    const owner = state.user.id;
    const generation = miniGeneration.current;
    const conversationId = miniId;
    if (miniPending.current.has(conversationId))
      throw new Error('This message is still sending. Please wait.');
    miniPending.current.add(conversationId);
    setMiniPendingIds([...miniPending.current]);
    const action: Extract<ChatAction, { type: 'send' }> = {
      type: 'send',
      conversationId,
      text: value.text.trim(),
      attachments: value.attachments,
    };
    let id: string | undefined;
    try {
      id = await act(action);
    } finally {
      if (
        currentUserNow.current === owner &&
        draftOwner.current === owner &&
        miniGeneration.current === generation
      ) {
        miniPending.current.delete(conversationId);
        setMiniPendingIds([...miniPending.current]);
      }
    }
    // A closed or replaced panel still clears an acknowledged draft, but an
    // account change or a newly edited draft must never be overwritten.
    if (
      currentUserNow.current !== owner ||
      draftOwner.current !== owner ||
      miniGeneration.current !== generation
    )
      return;
    const transferred = expandedMiniDraft.current[conversationId];
    let durable = true;
    if (transferred === value) {
      const current = mainDraftNow.current;
      const stored = draftMap.current[conversationId];
      if (stored === value) {
        draftMap.current[conversationId] = { text: '', attachments: [] };
        if (
          current.selectedId === conversationId &&
          current.text === value.text &&
          current.attachments === value.attachments
        ) {
          setDraft('');
          setAttachments([]);
        }
      }
      delete expandedMiniDraft.current[conversationId];
    }
    if (miniDraftMap.current[conversationId] === value) {
      const empty = { text: '', attachments: [] };
      miniDraftMap.current[conversationId] = empty;
      if (miniIdRef.current === conversationId) setMiniDraft(empty);
    }
    if (transferred) durable = persistDrafts(owner);
    if (!durable) return;
    if (id) await chat.acknowledgeSend(action, id);
  }
  function expandMini() {
    if (!state || !miniConversation || miniOwner.current !== state.user.id) {
      closeMini();
      return;
    }
    const owner = state.user.id,
      generation = miniGeneration.current,
      conversationId = miniConversation.id;
    if (selectedId) {
      const stored = draftMap.current[selectedId];
      if (stored?.text !== draft || stored.attachments !== attachments)
        draftMap.current[selectedId] = { text: draft, attachments };
    }
    const value = miniDraftMap.current[miniConversation.id] || miniDraft;
    if (value.text || value.attachments.length) {
      const previous = draftMap.current[miniConversation.id] || { text: '', attachments: [] };
      draftMap.current[miniConversation.id] = value;
      if (miniPending.current.has(miniConversation.id))
        expandedMiniDraft.current[miniConversation.id] = value;
      // Preserve a different main-composer draft in this conversation's
      // pop-up slot, so expanding never discards either draft.
      miniDraftMap.current[miniConversation.id] = previous;
      if (previous.text || previous.attachments.length)
        setToast('Your other draft is saved in this conversation’s pop-up.');
    }
    openConversation(miniConversation);
    closeMini();
    requestAnimationFrame(() => {
      if (
        currentUserNow.current === owner &&
        draftOwner.current === owner &&
        miniGeneration.current === generation &&
        mainDraftNow.current.selectedId === conversationId
      )
        composerRef.current?.focus({ preventScroll: true });
    });
  }
  // Responsive transitions use the current draft, without rerunning on typing.
  const expandMiniNow = useRef(expandMini);
  expandMiniNow.current = expandMini;
  const miniConversationId = miniConversation?.id;
  useEffect(() => {
    if (miniId && !miniConversationId) closeMini();
    else if (miniId && !miniDesktop) expandMiniNow.current();
  }, [miniId, miniDesktop, miniConversationId]);
  function navigate(next: View) {
    setHomePreview(false);
    setView(next);
    setSelectedId(null);
    setThreadId(null);
    setQuery('');
    setSearchScope(null);
    setSearchFilters(DEFAULT_SEARCH_FILTERS);
    setUnreadOnly(false);
    setPinnedOnly(false);
    setThreadsOnly(false);
    setHomeKind('all');
  }
  async function send(inThread = false) {
    const text = inThread ? threadDraft : draft;
    if (
      !state ||
      !selected ||
      draftOwner.current !== state.user.id ||
      (inThread && !threadId) ||
      sending ||
      (!text.trim() && (!attachments.length || inThread))
    )
      return;
    const owner = state.user.id;
    const generation = miniGeneration.current;
    const conversationId = selected.id;
    const parentId = inThread ? threadId : null;
    const revision = parentId ? threadDraftRevision.current[parentId] || 0 : 0;
    const stored = draftMap.current[conversationId];
    const sentDraft =
      stored?.text === text && stored.attachments === attachments ? stored : { text, attachments };
    if (!inThread) draftMap.current[conversationId] = sentDraft;
    const stillOwned = () =>
      currentUserNow.current === owner &&
      draftOwner.current === owner &&
      miniGeneration.current === generation;
    const feedbackKey = `${conversationId}:${parentId || 'main'}`;
    if (!inThread) delete recoveredDrafts.current[conversationId];
    const sentAttachments = inThread ? [] : attachments;
    setSendFeedback((previous) => ({
      ...previous,
      [feedbackKey]: {
        stage: 'sending',
        text,
        attachments: sentAttachments,
      },
    }));
    setSending(true);
    if (inThread) threadAtBottom.current = true;
    else atBottom.current = true;
    try {
      const action: Extract<ChatAction, { type: 'send' }> = {
        type: 'send',
        conversationId,
        text: text.trim(),
        ...(parentId ? { parentId } : {}),
        attachments: inThread ? [] : attachments,
      };
      const id = await act(action);
      if (!stillOwned()) return;
      setSendFeedback((previous) => {
        const next = { ...previous };
        delete next[feedbackKey];
        return next;
      });
      if (parentId) {
        const current = threadDraftNow.current;
        if (
          (threadDraftRevision.current[parentId] || 0) === revision &&
          threadDraftMap.current[parentId] === text
        ) {
          threadDraftMap.current[parentId] = '';
          threadDraftRevision.current[parentId] = revision + 1;
          if (
            current.selectedId === conversationId &&
            current.threadId === parentId &&
            current.text === text
          ) {
            setThreadDraft('');
            threadComposerRef.current?.focus();
          }
        }
        if (id) await chat.acknowledgeSend(action, id);
      } else if (draftMap.current[conversationId] === sentDraft) {
        const current = mainDraftNow.current;
        draftMap.current[conversationId] = { text: '', attachments: [] };
        // Persist the acknowledged conversation even when another one is open.
        const durable = persistDrafts(owner);
        if (
          current.selectedId === conversationId &&
          current.text === text &&
          current.attachments === attachments
        ) {
          setDraft('');
          setAttachments([]);
          composerRef.current?.focus();
        }
        if (id && durable) await chat.acknowledgeSend(action, id);
      } else {
        // A newer draft is intentional, even when edited back to the same text.
        // Persist that replacement before consuming the older confirmation.
        if (id && persistDrafts(owner)) await chat.acknowledgeSend(action, id);
      }
    } catch {
      if (stillOwned()) {
        const receipt = await chat
          .inspectSend({
            type: 'send',
            conversationId,
            text: text.trim(),
            ...(parentId ? { parentId } : {}),
            attachments: sentAttachments,
          })
          .catch(() => null);
        if (stillOwned())
          setSendFeedback((previous) => ({
            ...previous,
            [feedbackKey]: {
              stage: 'unconfirmed',
              text,
              attachments: sentAttachments,
              durable: receipt?.durable,
            },
          }));
      }
    } finally {
      if (stillOwned()) setSending(false);
    }
  }
  function composeKey(event: KeyboardEvent<HTMLTextAreaElement>, inThread = false) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send(inThread);
    }
  }
  async function addFiles(files: FileList | null) {
    if (!files || !selected || !state) return;
    const chosen = Array.from(files);
    const ticket = { ...fileSelection.current };
    const input = fileRef.current;
    if (input) input.value = '';
    const stillOwned = () =>
      currentUserNow.current === ticket.owner &&
      draftOwner.current === ticket.owner &&
      fileSelection.current.revision === ticket.revision;
    const task = fileReadQueue.current
      .catch(() => undefined)
      .then(async () => {
        if (!stillOwned()) return;
        const incoming: Attachment[] = [];
        for (const f of chosen) {
          if (!stillOwned()) return;
          const rawType = f.type.toLowerCase().split(';')[0];
          const type =
            rawType === 'audio/x-m4a' ||
            rawType === 'audio/m4a' ||
            (!rawType && /\.m4a$/i.test(f.name))
              ? 'audio/mp4'
              : rawType === 'audio/x-wav'
                ? 'audio/wav'
                : rawType;
          if (!f.size || f.size > MAX_ATTACHMENT_BYTES) {
            setToast(`${f.name} could not be added. Choose a nonempty file 5 MB or smaller.`);
            continue;
          }
          if (mainDraftNow.current.attachments.length + incoming.length >= MAX_ATTACHMENTS) {
            setToast(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
            break;
          }
          if (
            !/^(image\/(png|jpeg|gif|webp)|text\/plain|application\/pdf|audio\/(webm|mp4|ogg|mpeg|wav))$/.test(
              type,
            )
          ) {
            setToast('Choose a PNG, JPG, GIF, WebP image, text file, PDF, or audio file.');
            continue;
          }
          try {
            const url = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader();
              fileReaders.current.add(reader);
              const finish = () => fileReaders.current.delete(reader);
              reader.onload = () => {
                finish();
                resolve(String(reader.result));
              };
              reader.onerror = () => {
                finish();
                reject(new Error('This file couldn’t be read. Please select it again.'));
              };
              reader.onabort = () => {
                finish();
                reject(new Error('File selection was cancelled.'));
              };
              reader.readAsDataURL(f);
            });
            // A selection belongs only to the account and conversation that began it.
            if (!stillOwned()) return;
            incoming.push({
              name: f.name,
              type,
              size: f.size,
              url: url.replace(/^data:[^;]+;/, `data:${type};`),
            });
          } catch (failure) {
            if (!stillOwned()) return;
            setToast(
              failure instanceof Error
                ? failure.message
                : 'This file couldn’t be attached. Please select it again.',
            );
          }
        }
        if (!stillOwned() || !incoming.length) return;
        const current = mainDraftNow.current;
        const next = [...current.attachments, ...incoming].slice(0, MAX_ATTACHMENTS);
        if (next.length < current.attachments.length + incoming.length)
          setToast(`You can attach up to ${MAX_ATTACHMENTS} files per message.`);
        mainDraftNow.current = { ...current, attachments: next };
        setAttachments(next);
      });
    fileReadQueue.current = task;
    await task;
  }
  async function copyInvitation(conversation: Conversation) {
    const owner = state?.user.id;
    const submittedModal = modal;
    const isCurrent = () =>
      modalContext.current.owner === owner && modalContext.current.modal === submittedModal;
    const url = `${location.origin}/?join=${encodeURIComponent(conversation.id)}`;
    try {
      await navigator.clipboard.writeText(url);
      if (isCurrent())
        setToast(
          'Invitation link copied. Share it with your friend and ask them to sign in with the email you added.',
        );
    } catch {
      if (isCurrent()) setToast(`Invitation link: ${url}`);
    }
  }
  async function shareInvitation(conversation: Conversation) {
    const owner = state?.user.id;
    const submittedModal = modal;
    if (!navigator.share) {
      await copyInvitation(conversation);
      return;
    }
    try {
      await navigator.share({
        title: `Join ${conversation.name} in Chat`,
        text: 'Join me in Chat. Sign in with Google using the email I added to our conversation.',
        url: `${location.origin}/?join=${encodeURIComponent(conversation.id)}`,
      });
    } catch (error) {
      if (
        modalContext.current.owner === owner &&
        modalContext.current.modal === submittedModal &&
        !(error instanceof DOMException && error.name === 'AbortError')
      )
        await copyInvitation(conversation);
    }
  }
  async function submitNew(conversation: NewConversation) {
    const { kind, name, emails, description } = conversation;
    const existing =
      kind === 'dm'
        ? state?.conversations.find(
            (item) =>
              item.kind === 'dm' &&
              item.members.some(
                (person) =>
                  person.id !== state.user.id &&
                  person.email.toLowerCase() === emails[0]?.toLowerCase(),
              ),
          )
        : undefined;
    if (existing) {
      setModal(null);
      openConversation(existing);
      return;
    }
    await modalAction(
      { type: 'create', name, kind, emails, description },
      kind === 'space' ? 'Space created' : 'Conversation started',
      (id) => {
        if (id) {
          setSelectedId(id);
          setThreadId(null);
          setDraft('');
          setAttachments([]);
        }
      },
    );
  }
  async function modalAction(
    action: ChatAction,
    success: string,
    complete?: (result: string | undefined) => void,
  ) {
    const owner = state?.user.id;
    const submittedModal = modal;
    if (!owner || !submittedModal || dialogInFlight.current.has(submittedModal)) return;
    dialogInFlight.current.add(submittedModal);
    setPendingDialogs(new Set(dialogInFlight.current));
    const isCurrent = () =>
      modalContext.current.owner === owner && modalContext.current.modal === submittedModal;
    try {
      const result = await chat.action(action);
      if (isCurrent()) {
        setToast(success);
        setModal(null);
        complete?.(result);
      }
    } catch (error) {
      if (isCurrent())
        setToast(
          error instanceof Error ? error.message : 'Something went wrong. Please try again.',
        );
    } finally {
      dialogInFlight.current.delete(submittedModal);
      setPendingDialogs(new Set(dialogInFlight.current));
    }
  }
  async function saveProfile(values: ProfileValues) {
    const owner = state?.user.id;
    const submittedModal = modal;
    if (!owner || submittedModal?.type !== 'profile' || profileInFlight.current.has(owner)) return;
    profileInFlight.current.add(owner);
    setProfilePendingOwners(new Set(profileInFlight.current));
    const isCurrent = () =>
      modalContext.current.owner === owner && modalContext.current.modal === submittedModal;
    try {
      await chat.action({ type: 'profile', ...values });
      // A response belongs to this form and account, even if another dialog opens.
      if (isCurrent()) {
        setToast('Profile updated');
        setModal(null);
      }
    } finally {
      profileInFlight.current.delete(owner);
      setProfilePendingOwners(new Set(profileInFlight.current));
    }
  }
  async function submitConversation(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (modal?.type !== 'conversation') return;
    const data = new FormData(e.currentTarget);
    await modalAction(
      {
        type: 'conversation',
        conversationId: modal.conversation.id,
        name: String(data.get('name') || ''),
        description: String(data.get('description') || ''),
        section: String(data.get('section') || ''),
      },
      'Conversation updated',
    );
  }
  function showMessage(message: Message) {
    setModal({ type: 'message', message });
  }
  const positionMessageToolbar = useMessageToolbarPosition();
  function messageRow(
    message: Message,
    compact = false,
    idPrefix = '',
    presentation: 'standard' | 'dm' = 'standard',
  ) {
    const ownDm = presentation === 'dm' && message.author.id === state?.user.id;
    const count = replyIndex.counts.get(message.id) || 0;
    return (
      <article
        id={`${idPrefix}message-${message.id}`}
        className={`message ${jumpTarget === message.id ? 'message-highlight' : ''} ${compact ? 'compact-message' : ''} ${presentation === 'dm' ? 'dm-message' : ''} ${ownDm ? 'dm-own' : ''}`}
        key={message.id}
        onMouseEnter={(event) => positionMessageToolbar(event.currentTarget)}
        onFocusCapture={(event) => positionMessageToolbar(event.currentTarget)}
      >
        {!ownDm && <Avatar person={message.author} />}
        <div className="message-body">
          <div className="message-meta">
            <strong className={ownDm ? 'dm-own-author' : undefined}>{message.author.name}</strong>
            <time dateTime={message.createdAt}>{time(message.createdAt)}</time>
            {message.edited && <span className="edited">Edited</span>}
            {message.starred && <Star size={13} className="star-fill" />}
          </div>
          {message.deleted ? (
            <p className="deleted-message">This message was deleted</p>
          ) : (
            <>
              <div className="message-text">{message.text}</div>
              {message.attachments.length > 0 && (
                <div className="message-attachments">
                  {message.attachments.map((attachment, i) => (
                    <MediaAttachment
                      key={i}
                      attachment={attachment}
                      messageId={message.id}
                      index={i}
                      onLoad={chat.loadAttachment}
                      onRetry={chat.retryAttachment}
                      onPreview={(attachment) => setModal({ type: 'attachment', attachment })}
                    />
                  ))}
                </div>
              )}
              {message.reactions.length > 0 && (
                <div className="reaction-list">
                  {message.reactions
                    .filter((r) => r.userIds.length)
                    .map((r) => (
                      <button
                        key={r.emoji}
                        className={`reaction ${r.userIds.includes(state!.user.id) ? 'mine' : ''}`}
                        onClick={() =>
                          run({
                            type: 'react',
                            messageId: message.id,
                            emoji: r.emoji,
                          })
                        }
                        aria-label={`${r.emoji}, ${r.userIds.length} reaction${r.userIds.length === 1 ? '' : 's'}. Toggle your reaction.`}
                      >
                        {r.emoji}
                        <span>{r.userIds.length}</span>
                      </button>
                    ))}
                </div>
              )}
              {count > 0 && !compact && (
                <button className="thread-link" onClick={() => setThreadId(message.id)}>
                  <MessageSquare size={15} />
                  {count} {count === 1 ? 'reply' : 'replies'}
                  <ChevronRight size={15} />
                </button>
              )}
            </>
          )}
        </div>
        {!message.deleted && (
          <div className="message-actions">
            <div className="quick-reactions" aria-label="Quick reactions">
              {['👍', '😂', '🙏'].map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  aria-label={`React ${emoji}`}
                  onClick={() => run({ type: 'react', messageId: message.id, emoji })}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <IconButton label="Add reaction" onClick={() => setModal({ type: 'emoji', message })}>
              <Smile size={18} />
            </IconButton>
            {message.author.id === state!.user.id && (
              <IconButton label="Edit message" onClick={() => setModal({ type: 'edit', message })}>
                <Pencil size={18} />
              </IconButton>
            )}
            {!compact && (
              <IconButton label="Reply in thread" onClick={() => setThreadId(message.id)}>
                <MessageSquare size={18} />
              </IconButton>
            )}
            <IconButton
              label={message.starred ? 'Unstar message' : 'Star message'}
              onClick={() => run({ type: 'star', messageId: message.id })}
            >
              <Star size={18} className={message.starred ? 'star-fill' : ''} />
            </IconButton>
            <IconButton label="More actions" onClick={() => showMessage(message)}>
              <Ellipsis size={18} />
            </IconButton>
          </div>
        )}
      </article>
    );
  }
  const toastUI = (
    <>
      {toast && (
        <div className="toast" role="status">
          <Info size={18} aria-hidden="true" />
          <span>{toast}</span>
          <IconButton label="Dismiss notification" onClick={() => setToast('')}>
            <X size={18} />
          </IconButton>
        </div>
      )}
      {chat.error && (
        <div className="error-banner" role="alert">
          <Info size={18} />
          <span>{chat.error}</span>
          <IconButton label="Dismiss error" onClick={chat.clearError}>
            <X size={18} />
          </IconButton>
        </div>
      )}
    </>
  );
  if (chat.loading && !state)
    return (
      <div className="loading-screen">
        <Brand />
        <span className="loader" />
        <p>Getting your conversations ready…</p>
      </div>
    );
  if (!state)
    return (
      <main className="welcome">
        <div className="welcome-header">
          <Brand />
          <span>Room for every conversation.</span>
        </div>
        <section className="welcome-content">
          <div className="welcome-copy">
            <span className="eyebrow">
              <span /> A familiar space to connect
            </span>
            <h1>
              Welcome to Chat.
              <br />
              <span>Stay close. Go further.</span>
            </h1>
            {requestedInvitation && (
              <div className="invitation-welcome">
                <Users size={20} />
                <span>
                  You’re invited. Continue with Google using the email your friend added to the
                  conversation.
                </span>
              </div>
            )}
            <p>
              Bring your people together in one calm, organized place. A chat experience built for
              your team, and the way you move.
            </p>
            <button
              className="google-button"
              onClick={chat.signIn}
              disabled={!chat.authAvailable || chat.signingIn}
              aria-busy={chat.signingIn || undefined}
            >
              <img src="/auth/google-g.svg" width={20} height={20} alt="" aria-hidden="true" />
              <span>{chat.signingIn ? 'Opening Google…' : 'Continue with Google'}</span>
            </button>
            {!chat.authAvailable && (
              <p className="auth-note">
                {demoAvailable
                  ? 'Google sign-in is being configured. Explore the local preview while we finish connecting it.'
                  : 'Google sign-in is temporarily unavailable. Please refresh and try again.'}
              </p>
            )}
            {demoAvailable && (
              <button className="demo-button" onClick={chat.startDemo}>
                Explore demo <ArrowUpRight size={18} />
              </button>
            )}
            <div className="welcome-benefits">
              <span>
                <Check size={16} /> Messages & spaces
              </span>
              <span>
                <Check size={16} /> {landingDeviceLabel}
              </span>
              <button
                type="button"
                onClick={(event) => {
                  event.currentTarget.focus({ preventScroll: true });
                  setModal({ type: 'install' });
                }}
              >
                <Smartphone size={20} /> Add to Home Screen
              </button>
            </div>
          </div>
          <LandingChatPreview />
        </section>
        <LandingDetails />
        <footer className="welcome-footer">Your conversations are private to this app.</footer>
        {toastUI}
        {modal?.type === 'install' && (
          <Dialog title="Make yourself at home" onClose={closeModal}>
            <InstallHelp canInstall={Boolean(installPrompt)} onInstall={installApp} />
          </Dialog>
        )}
      </main>
    );

  const matchesHomeFilters = (conversation: Conversation) =>
    (!unreadOnly || conversation.unread > 0) &&
    (!pinnedOnly || conversation.pinned) &&
    (homeKind === 'all' ||
      (homeKind === 'space' ? conversation.kind === 'space' : conversation.kind !== 'space'));
  const visibleConversations = state.conversations
    .filter(
      (c) =>
        (view === 'home'
          ? matchesHomeFilters(c)
          : (!unreadOnly || c.unread > 0) && (!pinnedOnly || c.pinned)) &&
        (!searchScope || c.id === searchScope) &&
        (view !== 'direct' || c.kind !== 'space') &&
        (view !== 'spaces' || c.kind === 'space') &&
        (!query ||
          `${c.name} ${c.lastMessage || ''} ${c.description || ''}`
            .toLowerCase()
            .includes(query.toLowerCase())),
    )
    .sort(
      (a, b) =>
        Number(!!b.pinned) - Number(!!a.pinned) ||
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
  const activeSearchFilters = {
    ...searchFilters,
    conversationId: searchScope || '',
  };
  const foundMessages =
    view === 'search'
      ? searchLoadedMessages({
          messages: state.messages,
          conversations: state.conversations,
          user: state.user,
          query,
          filters: activeSearchFilters,
        }).filter(
          (message) =>
            !unreadOnly ||
            state.conversations.some(
              (conversation) =>
                conversation.id === message.conversationId && conversation.unread > 0,
            ),
        )
      : state.messages.filter(
          (m) =>
            !m.deleted &&
            (!searchScope || m.conversationId === searchScope) &&
            (!unreadOnly ||
              state.conversations.some((c) => c.id === m.conversationId && c.unread > 0)) &&
            (view === 'home' && threadsOnly
              ? !m.parentId &&
                state.conversations.some(
                  (conversation) =>
                    conversation.id === m.conversationId && matchesHomeFilters(conversation),
                ) &&
                replyIndex.activeRoots.has(m.id)
              : view === 'starred'
                ? m.starred
                : view === 'mentions'
                  ? mentionsUser(m.text, state.user)
                  : query && m.text.toLowerCase().includes(query.toLowerCase())),
        );
  const navItems: {
    view: View;
    icon: ReactNode;
    label: string;
    count?: number;
  }[] = [
    {
      view: 'home',
      icon: <Home size={20} />,
      label: 'Home',
      count: state.conversations.reduce((a, c) => a + c.unread, 0),
    },
    { view: 'mentions', icon: <AtSign size={20} />, label: 'Mentions' },
    { view: 'starred', icon: <Star size={20} />, label: 'Starred' },
  ];
  function composerStatus(inThread: boolean) {
    const feedback = sendFeedback[`${selectedId}:${inThread ? threadId : 'main'}`];
    const currentText = inThread ? threadDraft : draft;
    const unchanged =
      feedback &&
      currentText === feedback.text &&
      (inThread || attachments === feedback.attachments);
    const status =
      feedback?.stage === 'sending'
        ? 'Sending… Waiting for confirmation.'
        : feedback?.stage === 'unconfirmed'
          ? unchanged
            ? 'Send not confirmed. Your draft is kept here. Press Send to retry.'
            : 'Previous send not confirmed. Your current draft is kept here.'
          : sending
            ? 'Another message is waiting for confirmation.'
            : chat.offline
              ? 'You may be offline. Your draft is kept here. You can try sending.'
              : '';
    const storageNote =
      feedback?.durable === false
        ? 'Keep this page open. Retry protection could not be saved for a reload.'
        : !inThread && selectedId && draftMap.current[selectedId]?.omittedAttachments
          ? 'Some attachments weren’t saved. Check the conversation before adding files and sending again.'
          : !inThread && draftStorageIssue && (draftStorageIssue === 'all' || attachments.length)
            ? draftStorageIssue === 'all'
              ? 'Keep this page open until sending is confirmed. This draft could not be saved for a reload.'
              : 'Attachments stay in this open page. After reloading, check the conversation before adding files and sending again.'
            : '';
    if (!status && !storageNote) return null;
    return (
      <div
        className={`composer-status ${feedback?.stage === 'unconfirmed' ? 'unconfirmed' : ''}`}
        role="status"
        aria-live="polite"
      >
        {status && <p>{status}</p>}
        {storageNote && <p>{storageNote}</p>}
      </div>
    );
  }
  const composer = (inThread = false) => (
    <div className={`composer-wrap ${inThread ? 'thread-composer-wrap' : ''}`}>
      {!inThread && attachments.length > 0 && (
        <div className="draft-attachments">
          {attachments.map((f, i) => (
            <span key={i}>
              {f.type.startsWith('audio/') ? <Mic size={15} /> : <File size={15} />}
              <span className="draft-attachment-name" title={f.name}>
                {f.name}
              </span>
              {f.type.startsWith('audio/') && (
                <AudioPreview
                  className="draft-audio"
                  controls
                  src={f.url}
                  aria-label="Voice note preview"
                />
              )}
              <IconButton
                label={`Remove ${f.name}`}
                onClick={() => setAttachments((files) => files.filter((_, j) => i !== j))}
              >
                <X size={14} />
              </IconButton>
            </span>
          ))}
        </div>
      )}
      <div className="composer" aria-busy={sending}>
        <textarea
          ref={inThread ? threadComposerRef : composerRef}
          value={inThread ? threadDraft : draft}
          onChange={(e) =>
            inThread ? updateThreadDraft(e.target.value) : setDraft(e.target.value)
          }
          onKeyDown={(e) => composeKey(e, inThread)}
          placeholder={inThread ? 'Reply in thread' : `Message ${selected?.name || ''}`}
          rows={1}
          maxLength={6000}
          aria-label={inThread ? 'Reply in thread' : 'Message'}
        />
        <div className="composer-controls">
          {!inThread && (
            <>
              <IconButton
                label="Add emoji"
                className={modal?.type === 'insertEmoji' ? 'active' : ''}
                onClick={() => setModal({ type: 'insertEmoji' })}
              >
                <Smile size={22} />
              </IconButton>
              <IconButton label="Record voice note" onClick={() => setModal({ type: 'voice' })}>
                <Mic size={21} />
              </IconButton>
              <IconButton
                className="composer-attach"
                label="Attach files (up to 5 MB each)"
                onClick={() => fileRef.current?.click()}
              >
                <Plus size={24} />
              </IconButton>
            </>
          )}
          <button
            type="button"
            className="send-button"
            aria-label={inThread ? 'Send reply' : 'Send message'}
            aria-busy={sending}
            title={
              sending ? 'Waiting for send confirmation' : inThread ? 'Send reply' : 'Send message'
            }
            disabled={
              sending || !(inThread ? threadDraft.trim() : draft.trim() || attachments.length)
            }
            onClick={() => void send(inThread)}
          >
            {sending ? (
              <LoaderCircle className="send-spinner" size={22} aria-hidden="true" />
            ) : (
              <SendHorizontal size={22} aria-hidden="true" />
            )}
          </button>
        </div>
      </div>
      {composerStatus(inThread)}
      {!inThread && (
        <input
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp,text/plain,application/pdf,audio/webm,audio/mp4,audio/ogg,audio/mpeg,audio/wav,audio/x-m4a,audio/x-wav,.m4a"
          hidden
          multiple
          ref={fileRef}
          onChange={(e) => void addFiles(e.target.files)}
        />
      )}
      {!inThread && <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>}
    </div>
  );

  const homeView = (
    <div className="home-view">
      {view === 'home' ? (
        <HomeControls
          key={state.user.id}
          unread={unreadOnly}
          threads={threadsOnly}
          kind={homeKind}
          pinned={pinnedOnly}
          splitAvailable={splitDesktop}
          splitEnabled={splitEnabled}
          optionsRef={splitToggleRef}
          onUnreadChange={setUnreadOnly}
          onThreadsChange={setThreadsOnly}
          onKindChange={setHomeKind}
          onPinnedChange={setPinnedOnly}
          onReset={() => {
            setUnreadOnly(false);
            setThreadsOnly(false);
            setPinnedOnly(false);
            setHomeKind('all');
          }}
          onSplitToggle={toggleSplit}
          onReadAll={() => {
            const owner = currentUserNow.current;
            const generation = miniGeneration.current;
            void Promise.all(
              state.conversations
                .filter((conversation) => conversation.unread)
                .map((conversation) => act({ type: 'read', conversationId: conversation.id })),
            )
              .then(() => {
                if (
                  owner &&
                  currentUserNow.current === owner &&
                  draftOwner.current === owner &&
                  miniGeneration.current === generation
                )
                  setToast('All conversations marked as read');
              })
              .catch(() => {});
          }}
        />
      ) : (
        <header className="home-header">
          <div>
            <h1>{names[view]}</h1>
            <p>
              {view === 'direct'
                ? 'A little closer to your people.'
                : view === 'spaces'
                  ? 'Big ideas start with a shared space.'
                  : view === 'starred'
                    ? 'Messages you want to come back to.'
                    : view === 'mentions'
                      ? 'Conversations that include you.'
                      : view === 'sections'
                        ? 'Keep your conversations organized.'
                        : searchScope
                          ? `Search in ${state.conversations.find((c) => c.id === searchScope)?.name}`
                          : query
                            ? `Results for “${query}”`
                            : 'Find messages and conversations.'}
            </p>
          </div>
          <button
            className={`filter-button ${unreadOnly ? 'active' : ''}`}
            aria-pressed={unreadOnly}
            onClick={() => setUnreadOnly(!unreadOnly)}
          >
            <span className="filter-dot" />
            Unread{unreadOnly && <Check size={14} />}
          </button>
        </header>
      )}
      <div className="mobile-search">
        <Search size={21} />
        <input
          aria-label="Search conversations"
          placeholder={
            searchScope
              ? `Search ${state.conversations.find((c) => c.id === searchScope)?.name || 'conversation'}`
              : 'Search in chat'
          }
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setView(e.target.value || view === 'search' ? 'search' : 'home');
          }}
        />
      </div>
      {view === 'search' && (
        <SearchFilters
          values={activeSearchFilters}
          people={[
            state.user,
            ...state.conversations.flatMap((conversation) => conversation.members),
            ...state.messages.map((message) => message.author),
          ]}
          conversations={state.conversations}
          resultCount={foundMessages.length}
          onChange={(values) => {
            setSearchFilters(values);
            setSearchScope(values.conversationId || null);
          }}
        />
      )}
      <div className="conversation-list">
        {(view === 'home' && threadsOnly) ||
        view === 'starred' ||
        view === 'mentions' ||
        view === 'search' ? (
          <>
            {view === 'search' &&
              !hasSearchFilters(activeSearchFilters) &&
              visibleConversations.length > 0 && (
                <>
                  <h2 className="list-heading">Conversations</h2>
                  {visibleConversations.map((conversation) => (
                    <button
                      key={conversation.id}
                      className="search-result"
                      onClick={() => openConversation(conversation)}
                    >
                      <ConversationAvatar userId={state.user.id} conversation={conversation} />
                      <span className="search-result-content">
                        <strong>{conversation.name}</strong>
                        <small>
                          {conversation.lastMessage ||
                            conversation.description ||
                            'Start a conversation'}
                        </small>
                      </span>
                      <ChevronRight size={18} />
                    </button>
                  ))}
                </>
              )}
            {view === 'search' && <h2 className="list-heading">Messages</h2>}
            {foundMessages.map((m) => {
              const c = state.conversations.find((c) => c.id === m.conversationId);
              const sentAt = new Date(m.createdAt);
              const fullDate = sentAt.toLocaleString([], {
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              });
              const currentDate = new Date();
              const compactDate =
                sentAt.toDateString() === currentDate.toDateString()
                  ? time(m.createdAt)
                  : sentAt.toLocaleDateString([], {
                      month: 'short',
                      day: 'numeric',
                      ...(sentAt.getFullYear() !== currentDate.getFullYear()
                        ? { year: 'numeric' as const }
                        : {}),
                    });
              const filenames = m.attachments.map((file) => file.name).join(', ');
              return (
                <button
                  key={m.id}
                  className="search-result"
                  aria-label={`Message from ${m.author.name} in ${c?.name || 'conversation'}: ${m.text || m.attachments.map((file) => file.name).join(', ')}`}
                  aria-description={`${fullDate}${filenames ? `; Attachments: ${filenames}` : ''}`}
                  onClick={() => {
                    if (c) openConversation(c);
                    setJumpTarget(m.parentId || m.id);
                    if (m.parentId) setThreadId(m.parentId);
                    else if (view === 'home' && threadsOnly) setThreadId(m.id);
                  }}
                >
                  <Avatar person={m.author} />
                  <span className="search-result-content">
                    <span className="search-result-heading">
                      <span
                        className="search-result-context"
                        title={`${m.author.name} · ${c?.name || 'conversation'}`}
                      >
                        {m.author.name} · {c?.name || 'conversation'}
                      </span>
                      <time className="search-result-date" dateTime={m.createdAt} title={fullDate}>
                        {compactDate}
                      </time>
                    </span>
                    <span className="search-result-preview">
                      <strong>{m.text || filenames}</strong>
                      {m.text && m.attachments.length > 0 && (
                        <span className="search-result-files" title={filenames} aria-hidden="true">
                          <Paperclip size={14} />
                          {m.attachments.length}
                        </span>
                      )}
                    </span>
                  </span>
                  <ChevronRight size={18} />
                </button>
              );
            })}
            {!foundMessages.length &&
              (view !== 'search' ||
                hasSearchFilters(activeSearchFilters) ||
                !visibleConversations.length) && (
                <div className="empty-state">
                  {view === 'starred' ? (
                    <Star size={40} />
                  ) : threadsOnly ? (
                    <MessageSquare size={40} />
                  ) : (
                    <AtSign size={40} />
                  )}
                  <h2>
                    {view === 'search'
                      ? 'No matching messages'
                      : view === 'starred'
                        ? 'Save a thought for later'
                        : threadsOnly
                          ? unreadOnly || pinnedOnly || homeKind !== 'all'
                            ? 'No matching threads'
                            : 'No threads yet'
                          : 'You’re all caught up'}
                  </h2>
                  <p>
                    {view === 'search'
                      ? 'Try different words or clear a filter.'
                      : view === 'starred'
                        ? 'Star a message in any conversation and find it here.'
                        : threadsOnly
                          ? unreadOnly || pinnedOnly || homeKind !== 'all'
                            ? 'Change or clear your Home filters to see more threads.'
                            : 'Reply in a thread to keep a focused discussion together. Threads from your conversations will appear here.'
                          : 'Messages that mention your name or @all will appear here.'}
                  </p>
                </div>
              )}
          </>
        ) : view === 'sections' ? (
          <>
            {sectionNames.length === 0 && (
              <div className="empty-state">
                <Folder size={40} />
                <h2>A place for everything</h2>
                <p>Open a conversation’s settings to add it to a custom section.</p>
                <button className="primary-button" onClick={() => navigate('home')}>
                  Browse conversations
                </button>
              </div>
            )}
            {sectionNames.map((section) => (
              <div key={section}>
                <h2 className="list-heading">
                  <Folder size={17} />
                  {section}
                </h2>
                {state.conversations
                  .filter((c) => c.section === section)
                  .map((c) => (
                    <button
                      key={c.id}
                      className="conversation-row"
                      onClick={() => openConversation(c)}
                    >
                      <ConversationAvatar userId={state.user.id} conversation={c} />
                      <span className="conversation-row-content">
                        <strong>{c.name}</strong>
                        <span>{c.lastMessage || 'Start a conversation'}</span>
                      </span>
                      <ChevronRight size={19} />
                    </button>
                  ))}
              </div>
            ))}
          </>
        ) : (
          <>
            {visibleConversations.map((c) => (
              <div key={c.id} className={`conversation-row-wrap ${c.unread ? 'unread-row' : ''}`}>
                <button
                  className={`conversation-row ${previewActive && selectedId === c.id ? splitStyles.selectedRow : ''}`}
                  aria-current={previewActive && selectedId === c.id ? 'true' : undefined}
                  onClick={(event) => openHomeConversation(c, event.currentTarget)}
                >
                  <ConversationAvatar userId={state.user.id} conversation={c} />
                  <span className="conversation-row-content">
                    <strong>
                      {c.name}
                      {c.pinned && <Pin size={13} />}
                      {c.muted && <BellOff size={13} />}
                    </strong>
                    <span>{c.lastMessage || c.description || 'Start a conversation'}</span>
                  </span>
                  <span className="conversation-row-meta">
                    <time>{time(c.updatedAt)}</time>
                    {c.unread > 0 && <b>{c.unread}</b>}
                  </span>
                </button>
                <IconButton
                  label={`Options for ${c.name}`}
                  className="row-options"
                  onClick={() => setModal({ type: 'about', conversation: c })}
                >
                  <Ellipsis size={20} />
                </IconButton>
              </div>
            ))}
            {!visibleConversations.length && (
              <div className="empty-state">
                <MessageSquare size={40} />
                <h2>
                  {view === 'home' && (pinnedOnly || homeKind !== 'all')
                    ? 'No matching conversations'
                    : unreadOnly
                      ? 'You’re all caught up'
                      : query
                        ? 'No conversations found'
                        : 'Make the first connection'}
                </h2>
                <p>
                  {view === 'home' && (pinnedOnly || homeKind !== 'all')
                    ? 'Change or clear your Home filters to see more conversations.'
                    : unreadOnly
                      ? 'No unread conversations. A nice moment to take a breath.'
                      : query
                        ? 'Try a different name or keyword.'
                        : 'Start a conversation or create a space for your team.'}
                </p>
                {!query && !unreadOnly && !pinnedOnly && homeKind === 'all' && (
                  <button
                    className="primary-button"
                    onClick={() =>
                      setModal({
                        type: 'new',
                        kind: view === 'spaces' ? 'space' : 'dm',
                      })
                    }
                  >
                    Start a conversation
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );

  return (
    <div
      className={`app-shell ${sidebarCollapsed ? 'sidebar-collapsed' : ''} ${selected ? 'conversation-open' : ''} ${thread ? 'thread-open' : ''}`}
      onClickCapture={(event) => {
        // Safari does not focus clicked buttons by default. Establish the
        // trigger before opening a dialog so Escape restores a useful target.
        const button = event.target instanceof Element ? event.target.closest('button') : null;
        if (button && !button.closest('[role=dialog]')) menuAnchor.current = button;
        button?.focus({ preventScroll: true });
      }}
    >
      <a href="#main-content" className="skip-link">
        Skip to conversation
      </a>
      <aside className="app-rail" aria-label="App shortcuts">
        <IconButton
          label="Main menu"
          expanded={!sidebarCollapsed}
          controls="chat-navigation"
          onClick={() => setSidebarCollapsed((value) => !value)}
        >
          <Menu size={24} />
        </IconButton>
        <button className="rail-chat" onClick={() => navigate('home')} aria-label="Chat">
          <MessageCircle size={25} />
          <small>Chat</small>
        </button>
        <div className="rail-bottom">
          <IconButton label="Add Chat to Home Screen" onClick={() => setModal({ type: 'install' })}>
            <Smartphone size={23} />
          </IconButton>
        </div>
      </aside>
      <header className="app-topbar">
        <Brand />
        <form
          className="search-box"
          onSubmit={(e) => {
            e.preventDefault();
            setView('search');
            setSelectedId(null);
          }}
        >
          <Search size={22} />
          <input
            ref={searchRef}
            aria-label="Search in chat"
            placeholder={
              searchScope
                ? `Search ${state.conversations.find((c) => c.id === searchScope)?.name || 'conversation'}`
                : 'Search in chat'
            }
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              if (e.target.value) {
                setView('search');
                setSelectedId(null);
              }
            }}
          />
          {query && (
            <IconButton
              label="Clear search"
              onClick={() => {
                setQuery('');
                setSearchScope(null);
                setSearchFilters(DEFAULT_SEARCH_FILTERS);
                setView('home');
              }}
            >
              <X size={19} />
            </IconButton>
          )}
          <span className="search-shortcut">⌘ K</span>
        </form>
        <div className="topbar-actions">
          <button className="status-button" onClick={() => setModal({ type: 'status' })}>
            <span
              className={`status-dot ${state.user.status === 'Do not disturb' ? 'dnd' : state.user.status === 'Away' ? 'away' : ''}`}
            />
            {state.user.status === 'Do not disturb'
              ? 'Do not disturb'
              : state.user.status === 'Away'
                ? 'Away'
                : 'Active'}
            <ChevronDown size={16} />
          </button>
          <IconButton label="Help and installation" onClick={() => setModal({ type: 'support' })}>
            <MaterialHelp />
          </IconButton>
          <IconButton label="Settings" onClick={() => setModal({ type: 'settings' })}>
            <MaterialSettings />
          </IconButton>
          <button
            className="account-button"
            aria-label="Your profile"
            onClick={() => setModal({ type: 'profile' })}
          >
            <Avatar person={state.user} size="small" />
          </button>
        </div>
      </header>
      <aside
        id="chat-navigation"
        className={`sidebar ${sidebarMotion.sidebar}`}
        aria-label="Chat navigation"
      >
        <button className="new-chat-button" onClick={() => setModal({ type: 'new', kind: 'dm' })}>
          <MaterialNewChat />
          New chat
        </button>
        <nav>
          <button
            className="sidebar-shortcuts-heading"
            aria-expanded={shortcutsExpanded}
            aria-controls="shortcut-navigation-items"
            onClick={() => setShortcutsExpanded((value) => !value)}
          >
            {shortcutsExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            <span>Shortcuts</span>
          </button>
          <div id="shortcut-navigation-items" hidden={!shortcutsExpanded && !sidebarCollapsed}>
            {navItems.map((item) => (
              <button
                key={item.view}
                aria-label={item.label}
                aria-current={
                  (!selected || previewActive) && view === item.view ? 'page' : undefined
                }
                className={`nav-item ${(!selected || previewActive) && view === item.view ? 'selected' : ''}`}
                onClick={() => navigate(item.view)}
              >
                {item.icon}
                <span>{item.label}</span>
                {!!item.count && <span className="nav-count">{item.count}</span>}
              </button>
            ))}
          </div>
        </nav>
        <div className="sidebar-group">
          <div className="sidebar-group-heading">
            <button
              aria-expanded={directExpanded}
              aria-controls="direct-conversations"
              onClick={() => setDirectExpanded((value) => !value)}
            >
              {directExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
              Direct messages
            </button>
            <IconButton
              label="New direct message"
              onClick={() => setModal({ type: 'new', kind: 'dm' })}
            >
              <Plus size={19} />
            </IconButton>
          </div>
          <div id="direct-conversations" hidden={!directExpanded}>
            {state.conversations
              .filter((c) => c.kind !== 'space' && !c.section)
              .slice(0, 7)
              .map((c) => (
                <button
                  key={c.id}
                  aria-label={c.name}
                  className={`sidebar-conversation ${!previewActive && selectedId === c.id ? 'selected' : ''}`}
                  onClick={() => openConversation(c)}
                >
                  <ConversationAvatar userId={state.user.id} conversation={c} small />
                  <span className={c.unread ? 'unread' : ''}>{c.name}</span>
                  {c.muted && <BellOff size={13} />}
                  {!!c.unread && <span className="unread-dot" />}
                </button>
              ))}
          </div>
        </div>
        <div className="sidebar-group">
          <div className="sidebar-group-heading">
            <button
              aria-expanded={spacesExpanded}
              aria-controls="space-conversations"
              onClick={() => setSpacesExpanded((value) => !value)}
            >
              {spacesExpanded ? <ChevronDown size={17} /> : <ChevronRight size={17} />}
              Spaces
            </button>
            <IconButton label="New space" onClick={() => setModal({ type: 'new', kind: 'space' })}>
              <Plus size={19} />
            </IconButton>
          </div>
          <div id="space-conversations" hidden={!spacesExpanded}>
            {state.conversations
              .filter((c) => c.kind === 'space' && !c.section)
              .map((c) => (
                <button
                  key={c.id}
                  aria-label={c.name}
                  className={`sidebar-conversation ${!previewActive && selectedId === c.id ? 'selected' : ''}`}
                  onClick={() => openConversation(c)}
                >
                  <ConversationAvatar userId={state.user.id} conversation={c} small />
                  <span className={c.unread ? 'unread' : ''}>{c.name}</span>
                  {c.pinned && <Pin size={13} />}
                  {!!c.unread && <span className="unread-dot" />}
                </button>
              ))}
          </div>
        </div>
        {sectionNames.map((section) => (
          <div className="sidebar-group" key={section}>
            <div className="sidebar-group-heading">
              <button onClick={() => navigate('sections')}>
                <ChevronDown size={17} />
                {section}
              </button>
            </div>
            {state.conversations
              .filter((c) => c.section === section)
              .map((c) => (
                <button
                  aria-label={c.name}
                  className={`sidebar-conversation ${!previewActive && selectedId === c.id ? 'selected' : ''}`}
                  key={c.id}
                  onClick={() => openConversation(c)}
                >
                  <ConversationAvatar userId={state.user.id} conversation={c} small />
                  <span className={c.unread ? 'unread' : ''}>{c.name}</span>
                  {c.kind !== 'space' && c.muted && <BellOff size={13} />}
                  {c.pinned && <Pin size={13} />}
                  {!!c.unread && <span className="unread-dot" />}
                </button>
              ))}
          </div>
        ))}
        <div className="sidebar-footer">
          {chat.demo && <span className="demo-badge">DEMO WORKSPACE</span>}
          <span>
            <span className={`connection-dot ${chat.offline ? 'offline' : ''}`} />
            {chat.offline ? 'May be offline' : chat.demo ? 'Local preview' : 'Signed in'}
          </span>
        </div>
      </aside>
      <main
        id="main-content"
        className={`main-panel ${previewActive || emptyPreview ? splitStyles.split : ''}`}
      >
        {(!selected || previewActive) && homeView}
        {emptyPreview && (
          <section
            className={splitStyles.emptyPreview}
            aria-label="Conversation preview placeholder"
          >
            <IconButton label="Close empty conversation preview" onClick={() => toggleSplit()}>
              <X size={18} />
            </IconButton>
            <div>
              <PanelRight size={48} aria-hidden="true" />
              <h2>No conversation selected</h2>
              <p>Use the toggle to switch between single and split pane modes</p>
            </div>
          </section>
        )}
        {selected && (
          <section
            key="conversation"
            aria-label={previewActive ? 'Conversation preview' : 'Conversation'}
            className={`conversation-pane ${splitStyles.pane} ${previewActive ? splitStyles.preview : ''}`}
          >
            {previewActive ? (
              <header className={splitStyles.previewHeader}>
                <ConversationAvatar userId={state.user.id} conversation={selected} />
                <button
                  className={splitStyles.previewTitle}
                  onClick={() => setModal({ type: 'about', conversation: selected })}
                >
                  {selected.name}
                </button>
                <IconButton label="Expand conversation" onClick={expandPreview}>
                  <Maximize2 size={18} />
                </IconButton>
                <IconButton label="Close conversation preview" onClick={() => closePreview()}>
                  <X size={18} />
                </IconButton>
              </header>
            ) : (
              <header className="conversation-header">
                <IconButton
                  label="Back to conversations"
                  className="mobile-back"
                  onClick={() => {
                    setSelectedId(null);
                    setThreadId(null);
                  }}
                >
                  <ArrowLeft size={24} />
                </IconButton>
                <ConversationAvatar userId={state.user.id} conversation={selected} />
                <button
                  className="conversation-title"
                  onClick={() => setModal({ type: 'about', conversation: selected })}
                >
                  <strong>
                    {selected.name}
                    <ChevronDown size={18} />
                  </strong>
                  <small>
                    {selected.kind === 'dm'
                      ? selected.members.find((p) => p.id !== state.user.id)?.status ||
                        'Direct message'
                      : `${selected.members.length} members`}
                    {selected.muted && ' · Muted'}
                  </small>
                </button>
                <div className="conversation-header-actions">
                  {miniDesktop && (
                    <IconButton label="Open in a pop-up" onClick={() => openMini(selected)}>
                      <PictureInPicture2 size={22} />
                    </IconButton>
                  )}
                  <a
                    className="icon-button"
                    aria-label="Open Google Meet"
                    title="Open Google Meet in a new tab"
                    href="https://meet.google.com/new"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <Video size={23} />
                  </a>
                  <IconButton
                    label="Search this conversation"
                    onClick={() => {
                      setSearchScope(selected.id);
                      setSearchFilters(DEFAULT_SEARCH_FILTERS);
                      setQuery('');
                      setSelectedId(null);
                      setView('search');
                      searchRef.current?.focus();
                    }}
                  >
                    <Search size={23} />
                  </IconButton>
                  <IconButton
                    label="Conversation details"
                    onClick={() => setModal({ type: 'about', conversation: selected })}
                  >
                    <Ellipsis size={24} />
                  </IconButton>
                </div>
              </header>
            )}
            {chat.demo && (
              <div className="demo-notice">
                <span>Demo workspace</span>
                <span>Explore freely. Your changes stay on this device.</span>
                <button onClick={() => setModal({ type: 'profile' })}>
                  Your profile
                  <ChevronRight size={14} />
                </button>
              </div>
            )}
            {!previewActive && (
              <div className="conversation-tabs">
                <span className="current">Chat</span>
                <button
                  onClick={() => {
                    setModal({ type: 'about', conversation: selected });
                  }}
                >
                  Shared <File size={14} />
                </button>
              </div>
            )}
            <div
              className="messages-scroll"
              ref={scrollRef}
              onScroll={(e) => {
                const el = e.currentTarget;
                atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
              }}
            >
              <div className="conversation-intro">
                <ConversationAvatar userId={state.user.id} conversation={selected} />
                <h1>{selected.name}</h1>
                <p>
                  {selected.description ||
                    (selected.kind === 'dm'
                      ? `The beginning of your conversation with ${selected.name}.`
                      : 'A space to share ideas, ask questions, and move things forward.')}
                </p>
                {selected.kind !== 'dm' && (
                  <button
                    className="text-button"
                    onClick={() => setModal({ type: 'invite', conversation: selected })}
                  >
                    <Users size={15} />
                    Add people
                  </button>
                )}
              </div>
              {previewActive && (
                <div className={splitStyles.historyNotice}>
                  <span>
                    <History size={14} /> Messages are saved
                  </span>
                  <p>
                    {chat.demo
                      ? 'Saved on this device in the demo workspace.'
                      : 'Your conversation stays available across your devices.'}
                  </p>
                </div>
              )}
              {messages.map((m, i) => (
                <div key={m.id}>
                  {(i === 0 ||
                    new Date(messages[i - 1].createdAt).toDateString() !==
                      new Date(m.createdAt).toDateString()) && (
                    <div className="date-divider">
                      <span>{dateLabel(m.createdAt)}</span>
                    </div>
                  )}
                  {messageRow(m, false, '', selected.kind === 'dm' ? 'dm' : 'standard')}
                </div>
              ))}
              {!messages.length && !previewActive && (
                <div className="empty-conversation">
                  <MessageSquare size={28} />
                  <p>Start the conversation</p>
                  <span>Say hello. A good idea often starts there.</span>
                </div>
              )}
            </div>
            <div className="composer-viewport">{composer()}</div>
          </section>
        )}
      </main>
      {thread && selected && (
        <aside className="thread-panel">
          <header>
            <h2>Thread</h2>
            <IconButton label="Close thread" onClick={() => setThreadId(null)}>
              <X size={22} />
            </IconButton>
          </header>
          <div
            className="thread-messages"
            ref={threadScrollRef}
            onScroll={(event) => {
              const scroller = event.currentTarget;
              threadAtBottom.current =
                scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
            }}
          >
            {messageRow(thread, true)}
            <div className="thread-divider">
              {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
            </div>
            {replies.map((m) => messageRow(m, true))}
          </div>
          {composer(true)}
        </aside>
      )}
      <nav className="mobile-tabs" aria-label="Main navigation">
        <button className={view === 'home' ? 'active' : ''} onClick={() => navigate('home')}>
          <Home size={23} />
          <span>Home</span>
        </button>
        <button className={view === 'direct' ? 'active' : ''} onClick={() => navigate('direct')}>
          <MessageSquare size={23} />
          <span>Direct messages</span>
        </button>
        <button
          className={view === 'sections' || view === 'spaces' ? 'active' : ''}
          onClick={() => navigate('sections')}
        >
          <Folder size={23} />
          <span>Sections</span>
        </button>
        <button onClick={() => setModal({ type: 'more' })}>
          <Ellipsis size={25} />
          <span>More</span>
        </button>
      </nav>
      {view !== 'search' && (
        <button
          className="mobile-new-chat"
          aria-label="New chat"
          onClick={() => setModal({ type: 'new', kind: 'dm' })}
        >
          <Pencil size={23} />
        </button>
      )}
      {miniConversation && miniOwner.current === state.user.id && (
        <MiniConversation
          key={`${state.user.id}:${miniConversation.id}`}
          conversation={miniConversation}
          messages={state.messages.filter(
            (message) => message.conversationId === miniConversation.id && !message.parentId,
          )}
          draft={miniDraft}
          minimized={miniMinimized}
          avatar={
            <ConversationAvatar small userId={state.user.id} conversation={miniConversation} />
          }
          offline={chat.offline}
          pending={miniPendingIds.includes(miniConversation.id)}
          currentUserId={state.user.id}
          renderMessage={(message) =>
            messageRow(message, true, 'mini-', miniConversation.kind === 'dm' ? 'dm' : 'standard')
          }
          onDraft={updateMiniDraft}
          onSend={sendMini}
          onMinimize={() => setMiniMinimized(true)}
          onRestore={() => {
            setMiniMinimized(false);
            if (miniConversation.unread) run({ type: 'read', conversationId: miniConversation.id });
          }}
          onExpand={expandMini}
          onClose={() => closeMini(true)}
        />
      )}
      {toastUI}

      {modal && (
        <Dialog
          contextual={
            ['message', 'emoji', 'insertEmoji', 'status', 'support'].includes(modal.type) ||
            (modal.type === 'new' && !compactViewport)
          }
          formPopover={modal.type === 'new'}
          emojiPopover={modal.type === 'emoji' || modal.type === 'insertEmoji'}
          messagePopover={modal.type === 'message'}
          anchor={menuAnchor.current}
          title={
            modal.type === 'status'
              ? 'Availability'
              : modal.type === 'support'
                ? 'Help and support'
                : modal.type === 'guide'
                  ? 'Using Chat'
                  : modal.type === 'attachment'
                    ? 'Image preview'
                    : modal.type === 'new'
                      ? 'Start a conversation'
                      : modal.type === 'settings'
                        ? 'Settings'
                        : modal.type === 'profile'
                          ? 'Your profile'
                          : modal.type === 'install'
                            ? 'Make yourself at home'
                            : modal.type === 'more'
                              ? 'More in Chat'
                              : modal.type === 'voice'
                                ? 'Record a voice note'
                                : modal.type === 'about'
                                  ? modal.conversation.name
                                  : modal.type === 'conversation'
                                    ? 'Conversation settings'
                                    : modal.type === 'invite'
                                      ? 'Add people'
                                      : modal.type === 'leave'
                                        ? 'Leave this conversation?'
                                        : modal.type === 'edit'
                                          ? 'Edit message'
                                          : modal.type === 'delete'
                                            ? 'Delete this message?'
                                            : modal.type === 'insertEmoji'
                                              ? 'Add emoji'
                                              : modal.type === 'emoji'
                                                ? 'Add a reaction'
                                                : 'Message actions'
          }
          onClose={closeModal}
          wide={modal.type === 'attachment'}
        >
          {modal.type === 'status' && (
            <div className="menu-list">
              {(['Active', 'Away', 'Do not disturb'] as const).map((status) => (
                <button
                  key={status}
                  aria-pressed={
                    (state.user.status === 'Away' || state.user.status === 'Do not disturb'
                      ? state.user.status
                      : 'Active') === status
                  }
                  onClick={() =>
                    void modalAction({ type: 'profile', status }, `Status set to ${status}`)
                  }
                  disabled={busy}
                >
                  <span
                    className={`status-dot ${status === 'Away' ? 'away' : status === 'Do not disturb' ? 'dnd' : ''}`}
                  />
                  {status}
                  {(state.user.status === 'Away' || state.user.status === 'Do not disturb'
                    ? state.user.status
                    : 'Active') === status && <Check size={18} />}
                </button>
              ))}
            </div>
          )}
          {modal.type === 'support' && (
            <div className="menu-list support-menu">
              <button onClick={() => setModal({ type: 'guide' })}>
                <CircleHelp size={20} />
                Using Chat
                <ChevronRight size={18} />
              </button>
              <button onClick={() => setModal({ type: 'install' })}>
                <Smartphone size={20} />
                Add to Home Screen
                <ChevronRight size={18} />
              </button>
              <button onClick={() => setModal({ type: 'settings' })}>
                <Settings size={20} />
                Settings
                <ChevronRight size={18} />
              </button>
            </div>
          )}
          {modal.type === 'guide' && (
            <div className="chat-guide">
              <p>
                <strong>Start a conversation</strong>Choose New chat, search for someone from your
                conversations, or enter a full email address to invite a friend. Pick Direct
                message, Group, or Space.
              </p>
              <p>
                <strong>Share more than text</strong>Attach images and files up to 5 MB each, or
                record a voice message up to 2 minutes. Listen before sending.
              </p>
              <p>
                <strong>Keep replies together</strong>Use a message’s More actions menu to reply in
                a thread, react, or star it. You can edit or delete your own messages.
              </p>
              <p>
                <strong>Invite a friend</strong>Open Conversation details, add their email, then
                share the invitation link. They sign in with Google using that same email.
              </p>
              <p>
                <strong>Keyboard shortcuts</strong>Enter sends. Shift + Enter adds a line. Ctrl or ⌘
                + K opens search. Escape closes menus.
              </p>
            </div>
          )}
          {modal.type === 'attachment' && (
            <div className="attachment-preview">
              <img src={modal.attachment.url} alt={modal.attachment.name} />
              <div>
                <span>{modal.attachment.name}</span>
                <a
                  className="text-button"
                  href={modal.attachment.url}
                  download={modal.attachment.name}
                >
                  <ArrowDownToLine size={18} />
                  Download original
                </a>
              </div>
            </div>
          )}
          {modal.type === 'voice' && (
            <VoiceRecorder
              onRecorded={(attachment) => {
                if (attachments.length >= MAX_ATTACHMENTS) {
                  setToast(`Attach up to ${MAX_ATTACHMENTS} files per message.`);
                  return;
                }
                setAttachments((files) => [...files, attachment]);
                setModal(null);
                composerRef.current?.focus();
              }}
              onClose={closeModal}
            />
          )}
          {modal.type === 'new' && (
            <NewConversationForm
              kind={modal.kind}
              compact={compactViewport}
              currentEmail={state.user.email}
              people={state.conversations
                .flatMap((conversation) => conversation.members)
                .filter((person) => person.id !== state.user.id)}
              busy={busy}
              onKind={(kind) => setModal({ type: 'new', kind })}
              onSubmit={submitNew}
              onClose={closeModal}
            />
          )}
          {modal.type === 'profile' && (
            <ProfileForm
              key={state.user.id}
              person={state.user}
              avatar={<Avatar person={state.user} size="large" />}
              demo={chat.demo}
              pending={profilePendingOwners.has(state.user.id)}
              onSave={saveProfile}
              onClose={closeModal}
              onSignOut={() => {
                void chat.signOut();
                closeModal();
              }}
            />
          )}
          {modal.type === 'settings' && (
            <div className="settings-content">
              <div className="setting-row">
                <span>
                  <Palette size={21} />
                  <span>
                    <strong>Appearance</strong>
                    <small>Make this space yours.</small>
                  </span>
                </span>
                <select
                  aria-label="Appearance"
                  value={theme}
                  onChange={(e) => setTheme(e.target.value)}
                >
                  <option value="system">System</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </div>
              <div className="setting-row">
                <span>
                  <File size={21} />
                  <span>
                    <strong>Save drafts on this device</strong>
                    <small>
                      {saveDrafts
                        ? 'Draft text and files are stored in this browser. Turn off on shared devices.'
                        : 'Drafts stay available for this visit. They won’t be restored after a reload.'}
                    </small>
                  </span>
                </span>
                <button
                  className="text-button"
                  role="switch"
                  style={{ minWidth: 44, flexShrink: 0 }}
                  aria-label="Save drafts on this device"
                  aria-checked={saveDrafts}
                  onClick={() => changeDraftSaving(!saveDrafts)}
                >
                  {saveDrafts ? 'On' : 'Off'}
                </button>
              </div>
              <div className="setting-row">
                <span>
                  <Smartphone size={21} />
                  <span>
                    <strong>Home Screen app</strong>
                    <small>One tap to your conversations.</small>
                  </span>
                </span>
                <button className="text-button" onClick={() => setModal({ type: 'install' })}>
                  Install
                </button>
              </div>
              <div className="setting-row">
                <span>
                  <Info size={21} />
                  <span>
                    <strong>Chat</strong>
                    <small>
                      {chat.demo ? 'Demo · saved on this device' : 'Private team messaging'} · v1.0
                    </small>
                  </span>
                </span>
              </div>
              <p className="dialog-note">
                Video and voice calls, external Google Chat messages, and background push
                notifications are not available in this version.
              </p>
            </div>
          )}
          {modal.type === 'install' && (
            <InstallHelp canInstall={Boolean(installPrompt)} onInstall={installApp} />
          )}
          {modal.type === 'more' && (
            <div className="menu-list">
              <button
                onClick={() => {
                  navigate('spaces');
                  setModal(null);
                }}
              >
                <Hash size={21} />
                Spaces
                <ChevronRight size={18} />
              </button>
              <button
                onClick={() => {
                  navigate('mentions');
                  setModal(null);
                }}
              >
                <AtSign size={21} />
                Mentions
                <ChevronRight size={18} />
              </button>
              <button
                onClick={() => {
                  navigate('starred');
                  setModal(null);
                }}
              >
                <Star size={21} />
                Starred
                <ChevronRight size={18} />
              </button>
              <button onClick={() => setModal({ type: 'profile' })}>
                <Avatar person={state.user} size="tiny" />
                Your profile
                <ChevronRight size={18} />
              </button>
              <button onClick={() => setModal({ type: 'settings' })}>
                <Settings size={21} />
                Settings
                <ChevronRight size={18} />
              </button>
              <button onClick={() => setModal({ type: 'install' })}>
                <Smartphone size={21} />
                Add to Home Screen
                <ChevronRight size={18} />
              </button>
            </div>
          )}
          {modal.type === 'about' && (
            <>
              <div className="about-summary">
                <ConversationAvatar userId={state.user.id} conversation={modal.conversation} />
                <p>{modal.conversation.description || 'A place to keep the conversation going.'}</p>
              </div>
              <div className="menu-list">
                <button onClick={() => openMini(modal.conversation)}>
                  <PictureInPicture2 size={20} />
                  Open in a pop-up
                </button>
                <button
                  onClick={() =>
                    setModal({
                      type: 'conversation',
                      conversation: modal.conversation,
                    })
                  }
                >
                  <Pencil size={20} />
                  Edit details and section
                  <ChevronRight size={18} />
                </button>
                <button
                  onClick={() => {
                    run(
                      {
                        type: 'conversation',
                        conversationId: modal.conversation.id,
                        pinned: !modal.conversation.pinned,
                      },
                      modal.conversation.pinned ? 'Conversation unpinned' : 'Conversation pinned',
                    );
                    setModal(null);
                  }}
                >
                  <Pin size={20} />
                  {modal.conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}
                </button>
                <button
                  onClick={() => {
                    run(
                      {
                        type: 'conversation',
                        conversationId: modal.conversation.id,
                        muted: !modal.conversation.muted,
                      },
                      modal.conversation.muted ? 'Conversation unmuted' : 'Conversation muted',
                    );
                    setModal(null);
                  }}
                >
                  {modal.conversation.muted ? <Bell size={20} /> : <BellOff size={20} />}
                  {modal.conversation.muted ? 'Unmute conversation' : 'Mute conversation'}
                </button>
                <button
                  onClick={() => {
                    run(
                      {
                        type: 'read',
                        conversationId: modal.conversation.id,
                        unread: true,
                      },
                      'Marked as unread',
                    );
                    setModal(null);
                    setSelectedId(null);
                  }}
                >
                  <MessageSquare size={20} />
                  Mark as unread
                </button>
                {modal.conversation.kind !== 'dm' && (
                  <>
                    <button
                      onClick={() =>
                        setModal({
                          type: 'invite',
                          conversation: modal.conversation,
                        })
                      }
                    >
                      <Users size={20} />
                      Add people
                      <ChevronRight size={18} />
                    </button>
                  </>
                )}
                <button onClick={() => void shareInvitation(modal.conversation)}>
                  <ArrowUpRight size={20} />
                  Share invitation
                  <ChevronRight size={18} />
                </button>
                <button onClick={() => void copyInvitation(modal.conversation)}>
                  <Link size={20} />
                  Copy invitation link
                  <Copy size={17} />
                </button>
                <button
                  className="danger"
                  onClick={() =>
                    setModal({
                      type: 'leave',
                      conversation: modal.conversation,
                    })
                  }
                >
                  <LogOut size={20} />
                  Leave conversation
                </button>
              </div>
              <h3 className="small-heading">Members · {modal.conversation.members.length}</h3>
              <div className="member-list">
                {modal.conversation.members.map((p) => (
                  <div key={p.id}>
                    <Avatar person={p} size="small" />
                    <span>
                      <strong>
                        {p.name}
                        {p.id === state.user.id ? ' (you)' : ''}
                      </strong>
                      <small>{p.email}</small>
                    </span>
                  </div>
                ))}
              </div>
              <h3 className="small-heading">Shared files</h3>
              <div className="shared-files">
                {state.messages
                  .filter((m) => m.conversationId === modal.conversation.id && !m.deleted)
                  .flatMap((m) =>
                    m.attachments.map((attachment, index) => ({
                      attachment,
                      index,
                      messageId: m.id,
                    })),
                  )
                  .map(({ attachment, index, messageId }) => (
                    <MediaAttachment
                      key={`${messageId}-${index}`}
                      shared
                      attachment={attachment}
                      messageId={messageId}
                      index={index}
                      onLoad={chat.loadAttachment}
                      onRetry={chat.retryAttachment}
                      onPreview={(attachment) => setModal({ type: 'attachment', attachment })}
                    />
                  ))}
                {!state.messages.some(
                  (m) =>
                    m.conversationId === modal.conversation.id &&
                    !m.deleted &&
                    m.attachments.length,
                ) && (
                  <p className="dialog-note">Files shared in this conversation will appear here.</p>
                )}
              </div>
            </>
          )}
          {modal.type === 'conversation' && (
            <form onSubmit={submitConversation}>
              <label>
                Name
                <input
                  disabled={busy}
                  name="name"
                  defaultValue={modal.conversation.name}
                  required
                  maxLength={80}
                />
              </label>
              <label>
                Description
                <textarea
                  disabled={busy}
                  name="description"
                  defaultValue={modal.conversation.description || ''}
                  rows={3}
                  maxLength={500}
                />
              </label>
              <label>
                Section
                <input
                  disabled={busy}
                  name="section"
                  defaultValue={modal.conversation.section || ''}
                  list="section-names"
                  placeholder="e.g. Projects"
                  maxLength={40}
                />
                <datalist id="section-names">
                  {sectionNames.map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
                <small>Enter a new section name, or leave blank to use the default list.</small>
              </label>
              <div className="dialog-footer">
                <button type="button" className="text-button" onClick={closeModal}>
                  Cancel
                </button>
                <button className="primary-button" disabled={busy}>
                  Save
                </button>
              </div>
            </form>
          )}
          {modal.type === 'invite' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                await modalAction(
                  {
                    type: 'invite',
                    conversationId: modal.conversation.id,
                    emails: String(data.get('emails') || '')
                      .split(/[,\s]+/)
                      .filter(Boolean),
                  },
                  'People added',
                );
              }}
            >
              <p className="dialog-note">
                Invite people to {modal.conversation.name} by their email address. They can sign in
                with Google to participate.
              </p>
              <label>
                Email addresses
                <input
                  disabled={busy}
                  name="emails"
                  placeholder="maya@example.com, alex@example.com"
                  required
                />
                <small>Separate email addresses with commas.</small>
              </label>
              <div className="dialog-footer">
                <button type="button" className="text-button" onClick={closeModal}>
                  Cancel
                </button>
                <button className="primary-button" disabled={busy}>
                  Add people
                </button>
              </div>
            </form>
          )}
          {modal.type === 'leave' && (
            <>
              <p className="dialog-note">
                You’ll leave <strong>{modal.conversation.name}</strong> and it will be removed from
                your conversation list. Other members can still see the messages.
              </p>
              <div className="dialog-footer">
                <button className="text-button" onClick={closeModal}>
                  Cancel
                </button>
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() =>
                    void modalAction(
                      { type: 'leave', conversationId: modal.conversation.id },
                      'You left the conversation',
                      () => {
                        setSelectedId(null);
                        setThreadId(null);
                      },
                    )
                  }
                >
                  Leave conversation
                </button>
              </div>
            </>
          )}
          {modal.type === 'message' && (
            <div className="menu-list">
              <button onClick={() => setModal({ type: 'emoji', message: modal.message })}>
                <Smile size={20} />
                Add reaction
                <ChevronRight size={18} />
              </button>
              <button
                onClick={() => {
                  const conversation = state.conversations.find(
                    (candidate) => candidate.id === modal.message.conversationId,
                  );
                  if (!conversation) {
                    setToast('This conversation is no longer available.');
                    setModal(null);
                    return;
                  }
                  openConversation(conversation);
                  // Thread controls occupy the same corner as a pop-up. Its
                  // draft stays in miniDraftMap while the full thread opens.
                  closeMini();
                  setThreadId(modal.message.parentId || modal.message.id);
                  setModal(null);
                }}
              >
                <MessageSquare size={20} />
                Reply in thread
              </button>
              <button
                onClick={() => {
                  run({ type: 'star', messageId: modal.message.id });
                  setModal(null);
                }}
              >
                <Star size={20} />
                {modal.message.starred ? 'Unstar message' : 'Star message'}
              </button>
              <button
                onClick={async () => {
                  const submittedModal = modal;
                  const owner = state.user.id;
                  const isCurrent = () =>
                    modalContext.current.owner === owner &&
                    modalContext.current.modal === submittedModal;
                  try {
                    await navigator.clipboard.writeText(modal.message.text);
                    if (isCurrent()) {
                      setToast('Message copied');
                      setModal(null);
                    }
                  } catch {
                    if (isCurrent())
                      setToast(
                        'Copy is unavailable in this browser. Select the message text to copy it.',
                      );
                  }
                }}
              >
                <Copy size={20} />
                Copy text
              </button>
              {modal.message.author.id === state.user.id && (
                <>
                  <button onClick={() => setModal({ type: 'edit', message: modal.message })}>
                    <Pencil size={20} />
                    Edit message
                  </button>
                  <button
                    className="danger"
                    onClick={() => setModal({ type: 'delete', message: modal.message })}
                  >
                    <Trash2 size={20} />
                    Delete message
                  </button>
                </>
              )}
            </div>
          )}
          {modal.type === 'emoji' && (
            <EmojiPicker
              currentUserId={state.user.id}
              onSelect={(emoji) => {
                run({ type: 'react', messageId: modal.message.id, emoji });
                setModal(null);
              }}
            />
          )}
          {modal.type === 'insertEmoji' && (
            <EmojiPicker
              currentUserId={state.user.id}
              selectionLabelPrefix="Insert"
              onSelect={(emoji) => {
                const composer = composerRef.current;
                const start = composer?.selectionStart ?? draft.length;
                const end = composer?.selectionEnd ?? start;
                if (draft.length - (end - start) + emoji.length > 6000) {
                  setToast('Messages can contain up to 6,000 characters.');
                  return;
                }
                setDraft(draft.slice(0, start) + emoji + draft.slice(end));
                setModal(null);
                requestAnimationFrame(() => {
                  composer?.focus();
                  composer?.setSelectionRange(start + emoji.length, start + emoji.length);
                });
              }}
            />
          )}
          {modal.type === 'edit' && (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                const text = String(new FormData(e.currentTarget).get('text') || '').trim();
                if (!text) return;
                await modalAction(
                  { type: 'edit', messageId: modal.message.id, text },
                  'Message updated',
                );
              }}
            >
              <label>
                Message
                <textarea
                  disabled={busy}
                  name="text"
                  defaultValue={modal.message.text}
                  required
                  rows={5}
                  maxLength={6000}
                />
              </label>
              <div className="dialog-footer">
                <button className="text-button" type="button" onClick={closeModal}>
                  Cancel
                </button>
                <button className="primary-button" disabled={busy}>
                  Save
                </button>
              </div>
            </form>
          )}
          {modal.type === 'delete' && (
            <>
              <p className="dialog-note">
                This removes the message and its attachments for everyone in this conversation.
                Replies remain in the thread.
              </p>
              <blockquote className="delete-preview">
                {modal.message.text || 'Attached files'}
              </blockquote>
              <div className="dialog-footer">
                <button className="text-button" onClick={closeModal}>
                  Cancel
                </button>
                <button
                  className="danger-button"
                  disabled={busy}
                  onClick={() =>
                    void modalAction(
                      { type: 'delete', messageId: modal.message.id },
                      'Message deleted',
                    )
                  }
                >
                  Delete message
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}
    </div>
  );
}
