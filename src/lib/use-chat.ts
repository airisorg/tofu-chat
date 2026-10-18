'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createClient,
  type RealtimeChannel,
  type Session,
  type SupabaseClient,
} from '@supabase/supabase-js';
import { applyDemoAction, createDemoState, DEMO_STORAGE_KEY } from './demo';
import { isStoredDemoState } from './demo-storage';
import type { ChatAction, ChatController, ChatState } from './types';
import { MAX_DEMO_STORAGE_LENGTH } from './media-limits';
import { PrivateMediaCache } from './media-cache';
import { withRequestDeadline } from './request-deadline';
import { uploadAttachments } from './media-upload';
import { authenticatedFetch, refreshFailure } from './authenticated-fetch';
import { PendingActionIds } from './action-identity';
import {
  beginLogin,
  cleanLoginCallback,
  inspectLoginCallback,
  LOGIN_REQUEST_KEY,
} from './login-callback';
import { errorMessage, normalizeNetworkError } from './network-error';
export { withRequestDeadline } from './request-deadline';

type Config = { supabaseUrl: string; supabaseAnonKey: string; databaseConfigured: boolean };
type Mode = 'guest' | 'auth' | 'demo';
const AUTH_STORAGE_KEY = 'relay-chat-auth-v1';
const DEMO_CHOICE_KEY = 'relay-chat-demo-choice-v1';
const BOOTSTRAP_ERROR = 'Unable to connect. Check your connection and refresh the page.';
const DEMO_ALLOWED =
  process.env.NODE_ENV !== 'production' || process.env.NEXT_PUBLIC_ENABLE_DEMO === 'true';
// The sign-in broker answers in about a second (longer when cold). A visit still here after this
// long had its navigation stopped or blocked, so Continue with Google is offered again.
const SIGN_IN_PENDING_MS = 15_000;

export class PendingSendIds {
  private readonly ids = new Map<string, { id: string; confirmed: boolean; durable: boolean }>();
  private readonly handles = new WeakMap<
    Extract<ChatAction, { type: 'send' }>,
    { fingerprint: string; id: string; revision: number }
  >();
  private revision = 0;
  private identity = '';
  private readonly prefix = 'relay-chat-send-ids-v1:';
  private readonly identityKey = 'relay-chat-send-ids-last-identity-v1';
  private readonly storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

  constructor(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {
    try {
      this.storage = storage ?? (typeof window === 'undefined' ? undefined : window.localStorage);
    } catch {
      /* In-memory retry protection remains available. */
    }
  }

  bindVerifiedIdentity(identity: string) {
    if (this.identity === identity) return;
    this.revision++;
    this.ids.clear();
    this.identity = identity;
    try {
      const previous = this.storage?.getItem(this.identityKey);
      if (previous && previous !== identity) this.storage?.removeItem(this.prefix + previous);
    } catch {
      /* Failed cleanup must not prevent reading this account's ledger. */
    }
    try {
      this.storage?.setItem(this.identityKey, identity);
    } catch {
      /* Some privacy/storage modes permit reads but reject writes. */
    }
    try {
      const raw = this.storage?.getItem(this.prefix + identity);
      if (!raw || raw.length > 12000) return;
      const saved = JSON.parse(raw) as { version?: number; entries?: unknown };
      if ((saved.version !== 1 && saved.version !== 2) || !Array.isArray(saved.entries)) return;
      for (const pair of saved.entries.slice(-64)) {
        if (
          Array.isArray(pair) &&
          pair.length === (saved.version === 1 ? 2 : 3) &&
          typeof pair[0] === 'string' &&
          /^[0-9a-f]{64}$/.test(pair[0]) &&
          typeof pair[1] === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
            pair[1],
          ) &&
          (saved.version === 1 || typeof pair[2] === 'boolean')
        )
          this.ids.set(pair[0], {
            id: pair[1],
            confirmed: saved.version === 2 && pair[2] === true,
            durable: true,
          });
      }
      if (saved.version === 1) this.persist();
    } catch {
      /* Damaged or unavailable browser storage uses memory only. */
    }
  }

  private persist() {
    if (!this.identity) return;
    try {
      if (this.ids.size) {
        const raw = JSON.stringify({
          version: 2,
          entries: [...this.ids].map(([fingerprint, value]) => [
            fingerprint,
            value.id,
            value.confirmed,
          ]),
        });
        this.storage?.setItem(this.prefix + this.identity, raw);
        if (this.storage?.getItem(this.prefix + this.identity) === raw)
          for (const entry of this.ids.values()) entry.durable = true;
      } else this.storage?.removeItem(this.prefix + this.identity);
    } catch {
      /* Storage capacity/privacy restrictions preserve memory retries. */
    }
  }

  private async fingerprint(action: Extract<ChatAction, { type: 'send' }>) {
    const revision = this.revision;
    const logical = JSON.stringify([
      action.conversationId.toLowerCase(),
      action.text.trim(),
      action.parentId?.toLowerCase() ?? null,
      (action.attachments ?? []).map((file) => [file.name, file.type, file.size, file.url]),
    ]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(logical));
    if (revision !== this.revision) throw new Error('Your account changed. Please try again.');
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
      '',
    );
  }

  async inspect(action: Extract<ChatAction, { type: 'send' }>) {
    const fingerprint = await this.fingerprint(action);
    const entry = this.ids.get(fingerprint);
    if (entry) this.handles.set(action, { fingerprint, id: entry.id, revision: this.revision });
    return entry ? { fingerprint, ...entry } : null;
  }

  known(action: Extract<ChatAction, { type: 'send' }>) {
    const handle = this.handles.get(action);
    if (!handle || handle.revision !== this.revision) return null;
    const entry = this.ids.get(handle.fingerprint);
    return entry?.id === handle.id ? { fingerprint: handle.fingerprint, ...entry } : null;
  }

  async prepare(action: Extract<ChatAction, { type: 'send' }>) {
    const fingerprint = await this.fingerprint(action);
    const existing = this.ids.get(fingerprint);
    if (!existing && this.ids.size >= 64)
      throw new Error(
        'Too many messages are still unconfirmed. Retry them before sending another message.',
      );
    const id = action.clientMessageId ?? existing?.id ?? crypto.randomUUID();
    this.ids.set(fingerprint, {
      id,
      confirmed: existing?.id === id && existing.confirmed,
      durable: existing?.id === id && existing.durable,
    });
    // Retain hashes/UUIDs only, never message text or media; bound memory use.
    this.persist();
    this.handles.set(action, { fingerprint, id, revision: this.revision });
    return { fingerprint, action: { ...action, clientMessageId: id } };
  }

  confirm(fingerprint: string, id: string) {
    if (this.ids.get(fingerprint)?.id === id) {
      this.ids.set(fingerprint, {
        id,
        confirmed: true,
        durable: this.ids.get(fingerprint)!.durable,
      });
      this.persist();
    }
  }

  acknowledge(fingerprint: string, id: string) {
    if (this.ids.get(fingerprint)?.id === id) {
      this.ids.delete(fingerprint);
      this.persist();
    }
  }

  async reconcile(
    drafts: Extract<ChatAction, { type: 'send' }>[],
    committedIds: ReadonlySet<string>,
    hasPartialRestoredDraft = false,
  ) {
    // Quota fallback may keep text while dropping media. Its unmatched hash
    // cannot prove a confirmed receipt is unrelated, so retain it until a
    // complete empty restored snapshot or explicit successful consumption.
    if (
      hasPartialRestoredDraft ||
      drafts.some((action) => action.text.trim() || action.attachments?.length)
    )
      return;
    const revision = this.revision;
    const previous = [...this.ids];
    const retained = new Set(await Promise.all(drafts.map((action) => this.fingerprint(action))));
    if (revision !== this.revision) throw new Error('Your account changed. Please try again.');
    for (const [fingerprint, entry] of previous) {
      // A crash after saving the cleared draft must not turn a later intentional
      // identical message into a replay. Never discard an unresolved receipt.
      if (
        !retained.has(fingerprint) &&
        (entry.confirmed || committedIds.has(entry.id)) &&
        this.ids.get(fingerprint) === entry
      )
        this.ids.delete(fingerprint);
    }
    this.persist();
  }
  clear(purge = false) {
    this.revision++;
    if (purge) {
      try {
        const identity = this.identity || this.storage?.getItem(this.identityKey);
        if (identity) this.storage?.removeItem(this.prefix + identity);
        this.storage?.removeItem(this.identityKey);
      } catch {
        /* Memory state still clears if storage is unavailable. */
      }
    }
    this.ids.clear();
    this.identity = '';
  }
}

export function committedSend(
  state: ChatState,
  draft: Extract<ChatAction, { type: 'send' }>,
  id: string,
) {
  // A message UUID is the server's durable send identity. Matching text alone
  // must never erase a deliberately repeated or subsequently edited draft.
  return state.messages.some(
    (message) =>
      message.id === id &&
      message.author.id === state.user.id &&
      message.conversationId.toLowerCase() === draft.conversationId.toLowerCase() &&
      (message.parentId?.toLowerCase() ?? null) === (draft.parentId?.toLowerCase() ?? null),
  );
}

export function useChat(): ChatController {
  const [state, setState] = useState<ChatState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [demo, setDemo] = useState(false);
  const [authAvailable, setAuthAvailable] = useState(false);
  const [offline, setOffline] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const stateRef = useRef<ChatState | null>(null);
  const configRef = useRef<Config | null>(null);
  const clientRef = useRef<SupabaseClient | null>(null);
  const modeRef = useRef<Mode>('guest');
  const tokenRef = useRef('');
  const identityRef = useRef('');
  const generation = useRef(0);
  const revision = useRef(0);
  const controllers = useRef(new Set<AbortController>());
  const syncing = useRef(false);
  const writing = useRef(false);
  const realtimeChannel = useRef<RealtimeChannel | null>(null);
  const realtimeIdentity = useRef('');
  const configureRealtime = useRef<((userId: string) => void) | null>(null);
  const eventDirty = useRef(false);
  const dismissed = useRef(false);
  const mounted = useRef(false);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const pendingSends = useRef(new PendingSendIds());
  const pendingActions = useRef(new PendingActionIds());
  const reachableWhileOffline = useRef(false);
  const fetchWithAuth = useCallback(async (url: string, init: RequestInit, signal: AbortSignal) => {
    const start = generation.current;
    const identity = identityRef.current;
    const response = await authenticatedFetch(
      (token) => {
        const headers = new Headers(init.headers);
        headers.set('Authorization', `Bearer ${token}`);
        return fetch(url, { ...init, headers, signal });
      },
      () => ({
        identity: identityRef.current,
        generation: generation.current,
        token: tokenRef.current,
      }),
      async () => {
        const client = clientRef.current;
        if (!client) throw refreshFailure({ name: 'AuthSessionMissingError' });
        let renewed;
        try {
          renewed = await client.auth.refreshSession();
        } catch (failure) {
          throw refreshFailure(failure);
        }
        signal.throwIfAborted();
        if (start !== generation.current || identity !== identityRef.current)
          throw new Error('Your account changed. Please try again.');
        if (renewed.error) throw refreshFailure(renewed.error);
        const session = renewed.data.session;
        if (!session) throw refreshFailure({ name: 'AuthSessionMissingError' });
        if (session.user.id !== identity)
          throw new Error('Your account changed. Please try again.');
        tokenRef.current = session.access_token;
        void client.realtime.setAuth(session.access_token).catch(() => undefined);
        return { identity, token: session.access_token };
      },
      signal,
    );
    reachableWhileOffline.current = true;
    if (mounted.current) setOffline(false);
    return response;
  }, []);
  const wireState = useRef<ChatState | null>(null);
  const mediaChanged = useRef<() => void>(() => undefined);
  const mediaCache = useRef<PrivateMediaCache | null>(null);
  if (!mediaCache.current)
    mediaCache.current = new PrivateMediaCache(
      async (source, signal) => {
        return fetchWithAuth(source, { cache: 'no-store' }, signal);
      },
      () => mediaChanged.current(),
    );
  mediaChanged.current = () => {
    if (
      !mounted.current ||
      modeRef.current !== 'auth' ||
      !wireState.current ||
      wireState.current.user.id !== identityRef.current
    )
      return;
    const next = mediaCache.current!.materialize(wireState.current);
    stateRef.current = next;
    setState(next);
  };

  const publish = useCallback((next: ChatState | null) => {
    if (next && modeRef.current === 'auth') {
      wireState.current = next;
      mediaCache.current!.adopt(next);
      next = mediaCache.current!.materialize(next);
    } else wireState.current = null;
    stateRef.current = next;
    if (mounted.current) setState(next);
  }, []);

  const stopRealtime = useCallback(() => {
    const channel = realtimeChannel.current;
    realtimeChannel.current = null;
    realtimeIdentity.current = '';
    eventDirty.current = false;
    if (channel && clientRef.current)
      void clientRef.current.removeChannel(channel).catch(() => undefined);
  }, []);

  const reset = useCallback(
    (mode: Mode, identity = '', token = '') => {
      generation.current++;
      revision.current++;
      for (const controller of controllers.current) controller.abort();
      controllers.current.clear();
      pendingSends.current.clear();
      pendingActions.current.clear();
      reachableWhileOffline.current = false;
      mediaCache.current?.reset();
      writing.current = false;
      stopRealtime();
      modeRef.current = mode;
      identityRef.current = identity;
      tokenRef.current = token;
      syncing.current = false;
      publish(null);
      if (mounted.current) {
        setDemo(mode === 'demo');
        setError(null);
        setLoading(mode === 'auth');
      }
    },
    [publish, stopRealtime],
  );

  const request = useCallback(
    async (method: 'GET' | 'POST', action?: ChatAction, receiptId?: string) => {
      const controller = new AbortController();
      controllers.current.add(controller);
      try {
        const timeout =
          method === 'GET'
            ? 8000
            : action?.type === 'send' && action.attachments?.length
              ? 60000
              : 20000;
        return await withRequestDeadline(controller, timeout, async () => {
          let body = action;
          if (action?.type === 'send' && action.attachments?.length)
            body = await uploadAttachments(
              action,
              async (chunk) => {
                const uploaded = await fetchWithAuth(
                  '/api/uploads',
                  {
                    method: 'POST',
                    cache: 'no-store',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(chunk),
                  },
                  controller.signal,
                );
                const payload = (await uploaded.json()) as { ok?: boolean; error?: string };
                if (!uploaded.ok || payload.ok !== true) {
                  const failure = new Error(
                    payload.error || 'Unable to upload this file. Retry your message.',
                  ) as Error & { status: number };
                  failure.status = uploaded.status;
                  throw failure;
                }
              },
              controller.signal,
            );
          const response = await fetchWithAuth(
            receiptId ? `/api/chat?clientActionId=${encodeURIComponent(receiptId)}` : '/api/chat',
            {
              method,
              cache: 'no-store',
              headers: method === 'POST' ? { 'Content-Type': 'application/json' } : {},
              body: body ? JSON.stringify(body) : undefined,
            },
            controller.signal,
          );
          let payload: { state?: ChatState; id?: string; actionId?: string; error?: string };
          try {
            payload = await response.json();
          } catch {
            throw Object.assign(new Error('Chat is temporarily unavailable. Please try again.'), {
              status: response.ok ? 503 : response.status,
            });
          }
          if (!response.ok) {
            const failure = new Error(
              payload.error || 'Chat is temporarily unavailable.',
            ) as Error & { status: number };
            failure.status = response.status;
            throw failure;
          }
          if (!payload.state?.user || payload.state.user.id !== identityRef.current)
            throw new Error('Your account changed. Please sign in again.');
          return payload as { state: ChatState; id?: string; actionId?: string };
        });
      } finally {
        controllers.current.delete(controller);
      }
    },
    [fetchWithAuth],
  );

  const sync = useCallback(
    async (explicit = false): Promise<void> => {
      if (
        modeRef.current !== 'auth' ||
        syncing.current ||
        writing.current ||
        (!navigator.onLine && !reachableWhileOffline.current && !explicit) ||
        document.hidden ||
        !tokenRef.current
      )
        return;
      const start = generation.current;
      const version = revision.current;
      syncing.current = true;
      eventDirty.current = false;
      try {
        const result = await request('GET');
        if (
          start !== generation.current ||
          version !== revision.current ||
          modeRef.current !== 'auth'
        )
          return;
        pendingSends.current.bindVerifiedIdentity(result.state.user.id);
        pendingActions.current.bindVerifiedIdentity(result.state.user.id);
        publish(result.state);
        configureRealtime.current?.(result.state.user.id);
        if (mounted.current) setError(null);
      } catch (failure) {
        if (
          start !== generation.current ||
          (failure instanceof Error && failure.name === 'AbortError')
        )
          return;
        if ((failure as Error & { status?: number }).status === 401) {
          dismissed.current = true;
          reset('guest');
          if (mounted.current) setError('Your session expired. Please sign in again.');
        } else if (mounted.current) setError(errorMessage(failure, 'Unable to connect to chat.'));
      } finally {
        if (start === generation.current) {
          syncing.current = false;
          if (mounted.current) setLoading(false);
          if (eventDirty.current && !writing.current)
            queueMicrotask(() => {
              void sync();
            });
        }
      }
    },
    [publish, request, reset],
  );

  const startDemo = useCallback(() => {
    if (!DEMO_ALLOWED) return;
    reset('demo');
    try {
      localStorage.setItem(DEMO_CHOICE_KEY, 'yes');
    } catch {
      /* Demo works without storage. */
    }
    let next = createDemoState();
    try {
      const raw = localStorage.getItem(DEMO_STORAGE_KEY);
      if (raw && raw.length <= MAX_DEMO_STORAGE_LENGTH) {
        const saved: unknown = JSON.parse(raw);
        // This key is solely the explicit demo. Never read auth/private chat into it.
        if (isStoredDemoState(saved)) next = saved;
      }
    } catch {
      /* A damaged demo resets to the examples. */
    }
    publish(next);
    setLoading(false);
  }, [publish, reset]);

  useEffect(() => {
    mounted.current = true;
    const activeControllers = controllers.current;
    const sends = pendingSends.current;
    const actions = pendingActions.current;
    let disposed = false;
    let unsubscribe: (() => void) | undefined;
    let bootstrap: AbortController | null = null;
    let initializing = false;
    let initialized = false;
    const accept = (session: Session | null) => {
      if (disposed || modeRef.current === 'demo' || (dismissed.current && session)) return;
      if (!session) {
        if (modeRef.current !== 'guest') reset('guest');
        else if (mounted.current) setLoading(false);
        return;
      }
      if (modeRef.current !== 'auth' || identityRef.current !== session.user.id)
        reset('auth', session.user.id, session.access_token);
      else tokenRef.current = session.access_token;
      if (clientRef.current && realtimeChannel.current)
        void clientRef.current.realtime.setAuth(session.access_token).catch(() => undefined);
      // Do not await Supabase calls inside its auth-state callback lock.
      queueMicrotask(() => {
        if (!disposed) void sync(true);
      });
    };
    const restoreDemo = () => {
      if (!DEMO_ALLOWED) return false;
      try {
        if (localStorage.getItem(DEMO_CHOICE_KEY) === 'yes') {
          startDemo();
          return true;
        }
      } catch {
        /* Private browsing may disable storage. */
      }
      return false;
    };
    const initialize = async () => {
      if (disposed || initializing || initialized) return;
      initializing = true;
      const controller = new AbortController();
      bootstrap = controller;
      controllers.current.add(controller);
      const callbackUrl = new URL(window.location.href);
      let callback: { hasCallback: boolean; accepted: boolean };
      try {
        callback = inspectLoginCallback(callbackUrl, sessionStorage);
      } catch {
        callback = inspectLoginCallback(callbackUrl, { getItem: () => null });
      }
      // Reject unsolicited token URLs before the SDK can replace the session.
      if (callback.hasCallback && !callback.accepted) {
        window.history.replaceState(null, '', cleanLoginCallback(callbackUrl));
        setError(
          'This sign-in request could not be verified. Please use Continue with Google to try again.',
        );
      }
      try {
        const config = await withRequestDeadline(controller, 8000, async () => {
          const response = await fetch('/api/config', {
            cache: 'no-store',
            signal: controller.signal,
          });
          if (!response.ok || !response.headers.get('content-type')?.includes('application/json'))
            throw new Error('Unable to load sign-in settings.');
          return (await response.json()) as Config;
        });
        controllers.current.delete(controller);
        if (
          !config ||
          typeof config.supabaseUrl !== 'string' ||
          typeof config.supabaseAnonKey !== 'string' ||
          typeof config.databaseConfigured !== 'boolean'
        )
          throw new Error('Unable to load sign-in settings.');
        let valid = false;
        try {
          const url = new URL(config.supabaseUrl);
          valid =
            url.protocol === 'https:' &&
            !url.username &&
            !url.password &&
            Boolean(config.supabaseAnonKey) &&
            config.databaseConfigured === true;
        } catch {
          /* Unconfigured local preview remains a guest. */
        }
        if (disposed) return;
        configRef.current = config;
        // A recovered settings request clears only its own connection error;
        // callback validation and account errors must remain visible.
        setError((current) => (current === BOOTSTRAP_ERROR ? null : current));
        setAuthAvailable(valid);
        if (!valid) {
          initialized = true;
          if (!restoreDemo()) setLoading(false);
          return;
        }
        const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: callback.accepted,
            flowType: 'implicit',
            storageKey: AUTH_STORAGE_KEY,
          },
        });
        clientRef.current = client;
        initialized = true;
        configureRealtime.current = (userId: string) => {
          // The API has already verified this identity before this subscription.
          if (disposed || realtimeIdentity.current === userId || modeRef.current !== 'auth') return;
          stopRealtime();
          realtimeIdentity.current = userId;
          const start = generation.current;
          void client.realtime
            .setAuth(tokenRef.current)
            .then(() => {
              if (
                disposed ||
                start !== generation.current ||
                modeRef.current !== 'auth' ||
                realtimeIdentity.current !== userId
              )
                return;
              realtimeChannel.current = client
                .channel(`relay-events-${userId}`)
                .on(
                  'postgres_changes',
                  {
                    event: 'INSERT',
                    schema: 'relay',
                    table: 'events',
                    filter: `user_id=eq.${userId}`,
                  },
                  () => {
                    if (disposed || start !== generation.current || identityRef.current !== userId)
                      return;
                    eventDirty.current = true;
                    void sync();
                  },
                )
                .subscribe();
            })
            .catch(() => {
              if (start === generation.current) realtimeIdentity.current = '';
            });
        };
        const { data: listener } = client.auth.onAuthStateChange((_event, session) =>
          accept(session),
        );
        unsubscribe = () => listener.subscription.unsubscribe();
        const hash = new URLSearchParams(callbackUrl.hash.slice(1));
        const restored = await withRequestDeadline(controller, 8000, () =>
          client.auth.getSession(),
        );
        if (disposed) return;
        const { data, error: authError } = restored;
        if (data.session || !restoreDemo()) accept(data.session);
        if (authError || (callback.accepted && hash.has('error')))
          setError('Google sign-in did not complete. Please try again.');
        else if (callback.hasCallback && !callback.accepted)
          setError(
            'This sign-in request could not be verified. Please use Continue with Google to try again.',
          );
      } catch (failure) {
        if (!disposed && !(failure instanceof Error && failure.name === 'AbortError')) {
          restoreDemo();
          setError(BOOTSTRAP_ERROR);
          setLoading(false);
        }
      } finally {
        if (!disposed && callback.hasCallback) {
          window.history.replaceState(null, '', cleanLoginCallback(callbackUrl));
          try {
            sessionStorage.removeItem(LOGIN_REQUEST_KEY);
          } catch {}
        }
        controllers.current.delete(controller);
        initializing = false;
      }
    };
    const connectivity = () => {
      setOffline(!navigator.onLine);
      if (!navigator.onLine) {
        reachableWhileOffline.current = false;
        controllers.current.forEach((controller) =>
          controller.abort(new Error('You’re offline. Reconnect to continue.')),
        );
        mediaCache.current?.abortPending();
      } else {
        if (!initialized) void initialize();
        void sync(true);
      }
    };
    const visibility = () => {
      if (!document.hidden) void sync(true);
    };
    connectivity();
    window.addEventListener('online', connectivity);
    window.addEventListener('offline', connectivity);
    document.addEventListener('visibilitychange', visibility);
    const timer = window.setInterval(() => {
      void sync();
    }, 3000);
    void initialize();
    return () => {
      disposed = true;
      mounted.current = false;
      // Invalidate the latest request generation, not a captured old counter.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      generation.current++;
      syncing.current = false;
      bootstrap?.abort();
      activeControllers.forEach((c) => c.abort());
      activeControllers.clear();
      sends.clear();
      actions.clear();
      mediaCache.current?.reset();
      stopRealtime();
      configureRealtime.current = null;
      unsubscribe?.();
      clientRef.current?.auth.stopAutoRefresh();
      clientRef.current = null;
      window.clearInterval(timer);
      window.removeEventListener('online', connectivity);
      window.removeEventListener('offline', connectivity);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [reset, startDemo, stopRealtime, sync]);

  const loadMedia = useCallback((messageId: string, index: number, retry = false) => {
    if (
      modeRef.current !== 'auth' ||
      !wireState.current ||
      wireState.current.user.id !== identityRef.current
    )
      return;
    const file = wireState.current.messages.find((message) => message.id === messageId)
      ?.attachments[index];
    if (file) void mediaCache.current?.load(file.url, retry);
  }, []);
  const loadAttachment = useCallback(
    (messageId: string, index: number) => loadMedia(messageId, index),
    [loadMedia],
  );
  const retryAttachment = useCallback(
    (messageId: string, index: number) => loadMedia(messageId, index, true),
    [loadMedia],
  );

  const action = useCallback(
    (value: ChatAction): Promise<string | undefined> => {
      const start = generation.current;
      const pending = queue.current
        .catch(() => undefined)
        .then(async () => {
          if (start !== generation.current)
            throw new Error('Your account changed. Please try again.');
          if (modeRef.current === 'demo') {
            if (!stateRef.current) throw new Error('Start the demo first.');
            const result = applyDemoAction(stateRef.current, value);
            publish(result.state);
            try {
              localStorage.setItem(DEMO_STORAGE_KEY, JSON.stringify(result.state));
            } catch {
              /* Storage may be disabled or full; the active demo still works. */
            }
            setError(null);
            return result.id;
          }
          if (modeRef.current !== 'auth' || !tokenRef.current)
            throw new Error('Sign in to continue.');
          if (stateRef.current?.user.id !== identityRef.current)
            throw new Error('Wait for your account to finish connecting.');
          pendingSends.current.bindVerifiedIdentity(stateRef.current.user.id);
          pendingActions.current.bindVerifiedIdentity(stateRef.current.user.id);
          const prepared = value.type === 'send' ? await pendingSends.current.prepare(value) : null;
          let intended = value;
          if (value.type === 'star' && value.starred === undefined) {
            const message = stateRef.current.messages.find(
              (message) => message.id === value.messageId,
            );
            if (message) intended = { ...value, starred: !message.starred };
          } else if (value.type === 'react' && value.active === undefined) {
            const message = stateRef.current.messages.find(
              (message) => message.id === value.messageId,
            );
            if (message)
              intended = {
                ...value,
                active: !message.reactions.some(
                  (reaction) =>
                    reaction.emoji === value.emoji &&
                    reaction.userIds.includes(identityRef.current),
                ),
              };
          }
          const mutation =
            intended.type !== 'send' ? await pendingActions.current.prepare(intended) : null;
          if (start !== generation.current)
            throw new Error('Your account changed. Please try again.');
          revision.current++;
          writing.current = true;
          try {
            let result;
            try {
              result = await request('POST', prepared?.action ?? mutation?.action ?? value);
            } catch (failure) {
              const status = (failure as Error & { status?: number }).status;
              if (
                mutation &&
                start === generation.current &&
                modeRef.current === 'auth' &&
                (status === undefined || status >= 500)
              ) {
                // A receipt query confirms a possibly committed change without
                // replaying a toggle/create. Keep its identity if confirmation fails.
                try {
                  const confirmed = await request('GET', undefined, mutation.action.clientActionId);
                  if (start === generation.current && modeRef.current === 'auth') {
                    revision.current++;
                    publish(confirmed.state);
                    if (confirmed.actionId === mutation.action.clientActionId) result = confirmed;
                  }
                } catch {
                  /* The original intent remains available for explicit retry. */
                }
              }
              if (!result) {
                if (
                  mutation &&
                  status !== undefined &&
                  status >= 400 &&
                  status < 500 &&
                  status !== 401
                )
                  pendingActions.current.acknowledge(
                    mutation.fingerprint,
                    mutation.action.clientActionId,
                  );
                throw failure;
              }
            }
            if (start !== generation.current || modeRef.current !== 'auth')
              throw new Error('Your account changed. Please try again.');
            revision.current++;
            publish(result.state);
            // Keep a durable confirmation until the composer has safely cleared
            // its matching draft. Exiting between these steps must remain a replay.
            if (prepared && result.id === prepared.action.clientMessageId)
              pendingSends.current.confirm(prepared.fingerprint, result.id);
            if (mutation)
              pendingActions.current.acknowledge(
                mutation.fingerprint,
                mutation.action.clientActionId,
              );
            setError(null);
            return result.id;
          } finally {
            if (start === generation.current) writing.current = false;
            if (start === generation.current && eventDirty.current)
              queueMicrotask(() => {
                void sync();
              });
          }
        })
        .catch((failure) => {
          if (start === generation.current && mounted.current) {
            if ((failure as Error & { status?: number }).status === 401) {
              dismissed.current = true;
              reset('guest');
            }
            setError(errorMessage(failure, 'Unable to complete this action.'));
            const status = (failure as Error & { status?: number }).status;
            if (
              value.type === 'send' &&
              modeRef.current === 'auth' &&
              (status === undefined || status >= 500)
            )
              queueMicrotask(() => {
                void sync(true);
              });
          }
          throw normalizeNetworkError(failure);
        });
      queue.current = pending;
      return pending;
    },
    [publish, request, reset, sync],
  );

  const inspectSend = useCallback(async (draft: Extract<ChatAction, { type: 'send' }>) => {
    const start = generation.current;
    const current = stateRef.current;
    if (
      modeRef.current !== 'auth' ||
      !current ||
      current.user.id !== identityRef.current ||
      !current.conversations.some(
        (conversation) => conversation.id.toLowerCase() === draft.conversationId.toLowerCase(),
      )
    )
      return null;
    pendingSends.current.bindVerifiedIdentity(current.user.id);
    const entry = await pendingSends.current.inspect(draft);
    if (
      start !== generation.current ||
      modeRef.current !== 'auth' ||
      stateRef.current?.user.id !== current.user.id
    )
      throw new Error('Your account changed. Please try again.');
    if (!entry) return null;
    const confirmed = entry.confirmed || committedSend(stateRef.current, draft, entry.id);
    if (confirmed && !entry.confirmed) pendingSends.current.confirm(entry.fingerprint, entry.id);
    return { id: entry.id, confirmed, durable: entry.durable };
  }, []);

  const acknowledgeSend = useCallback(
    async (draft: Extract<ChatAction, { type: 'send' }>, id: string) => {
      const start = generation.current;
      const current = stateRef.current;
      if (modeRef.current !== 'auth' || !current || current.user.id !== identityRef.current) return;
      const known = pendingSends.current.known(draft);
      if (known) {
        // The caller reuses the exact prepared/inspected action object. Consume
        // before yielding, after its durable draft change, to close the exit gap.
        if (known.id === id && (known.confirmed || committedSend(current, draft, id)))
          pendingSends.current.acknowledge(known.fingerprint, id);
        return;
      }
      const entry = await pendingSends.current.inspect(draft);
      if (
        start !== generation.current ||
        modeRef.current !== 'auth' ||
        stateRef.current?.user.id !== current.user.id
      )
        throw new Error('Your account changed. Please try again.');
      if (entry?.id === id && (entry.confirmed || committedSend(stateRef.current, draft, id)))
        pendingSends.current.acknowledge(entry.fingerprint, id);
    },
    [],
  );

  const reconcileSendDrafts = useCallback(
    async (drafts: Extract<ChatAction, { type: 'send' }>[], hasPartialRestoredDraft = false) => {
      const current = stateRef.current;
      if (modeRef.current !== 'auth' || !current || current.user.id !== identityRef.current) return;
      pendingSends.current.bindVerifiedIdentity(current.user.id);
      const committedIds = new Set(
        current.messages
          .filter((message) => message.author.id === current.user.id)
          .map((message) => message.id),
      );
      await pendingSends.current.reconcile(drafts, committedIds, hasPartialRestoredDraft);
    },
    [],
  );

  useEffect(() => {
    if (!signingIn) return;
    // This page stays alive while the broker answers. If the visit comes back instead (restored
    // from the back/forward cache, or the navigation was stopped), sign-in must not stay pending.
    // Only a restore fires pageshow now: the listener is added after the page has loaded.
    const restore = () => setSigningIn(false);
    const timer = window.setTimeout(restore, SIGN_IN_PENDING_MS);
    window.addEventListener('pageshow', restore);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('pageshow', restore);
    };
  }, [signingIn]);

  const signIn = useCallback(() => {
    if (!authAvailable || !configRef.current) {
      setError('Google sign-in is unavailable. Please try again when you’re connected.');
      return;
    }
    dismissed.current = false;
    try {
      localStorage.removeItem(DEMO_CHOICE_KEY);
    } catch {
      /* Demo preference is optional. */
    }
    try {
      const callback = beginLogin(`${window.location.origin}/`, sessionStorage);
      const url = new URL('https://oauth.trytofu.ai/start');
      url.searchParams.set('return', callback);
      setSigningIn(true);
      window.location.assign(url.href);
    } catch {
      setSigningIn(false);
      setError(
        'This browser could not save the sign-in request. Allow site storage, then try Continue with Google again.',
      );
    }
  }, [authAvailable]);

  const signOut = useCallback(async () => {
    dismissed.current = true;
    pendingSends.current.clear(true);
    pendingActions.current.clear(true);
    reset('guest');
    try {
      sessionStorage.removeItem(LOGIN_REQUEST_KEY);
    } catch {}
    try {
      localStorage.removeItem(AUTH_STORAGE_KEY);
      localStorage.removeItem(DEMO_CHOICE_KEY);
    } catch {
      /* Private browsing may disable storage. */
    }
    const client = clientRef.current;
    if (client) {
      try {
        await client.auth.signOut({ scope: 'local' });
      } catch {
        /* Local state was already cleared. */
      }
      client.auth.stopAutoRefresh();
    }
  }, [reset]);

  return {
    state,
    loading,
    error,
    demo,
    authAvailable,
    offline,
    action,
    inspectSend,
    acknowledgeSend,
    reconcileSendDrafts,
    signIn,
    signingIn,
    signOut,
    startDemo,
    loadAttachment,
    retryAttachment,
    clearError: useCallback(() => setError(null), []),
  };
}
