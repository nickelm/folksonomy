// Shared client helpers: session identity, the reconnecting socket, and escaping.

/**
 * A per-tab id, used to keep one person from voting twice.
 *
 * sessionStorage, not localStorage, and that choice is the whole design. Every
 * tab of one browser shares localStorage, so two tabs would be one voter and the
 * second tab's votes would vanish into the unique constraint with no error - the
 * single most confusing thing this app can do, because everything looks like it
 * worked. sessionStorage gives each tab its own identity, survives a reload, and
 * still absorbs the accidental double-tap that the id is really there to catch.
 *
 * The trade is honest: somebody who deliberately opens five tabs gets five votes.
 * localStorage barely stopped that either - a private window or a cleared site
 * setting was always enough - and this is a lecture exercise, not a ballot.
 *
 * crypto.randomUUID only exists in a secure context, and this app is served over
 * plain HTTP on a Duck DNS hostname - so on the very machines the students use,
 * the obvious call is undefined. getRandomValues has no such restriction.
 */
export function getSessionId() {
  const KEY = 'folksonomy.sessionId';
  let id = null;
  try {
    id = sessionStorage.getItem(KEY);
  } catch {
    // Private browsing with storage blocked. Fall through to a per-load id:
    // voting still works, it just will not survive a refresh.
  }
  if (id) return id;

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  id = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    /* not persistable; the in-memory value is still fine for this page load */
  }
  return id;
}

/**
 * Remember which tags this tab voted for, so pills look right instantly.
 *
 * sessionStorage for the same reason getSessionId uses it: this records what the
 * session did, so it has to disappear exactly when that session does. Left in
 * localStorage it would tell a fresh tab that it had already voted for things it
 * has not, and the pills would lie.
 */
export function votedStore(slug) {
  const KEY = `folksonomy.voted.${slug}`;
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      cache = new Set(JSON.parse(sessionStorage.getItem(KEY) || '[]'));
    } catch {
      cache = new Set();
    }
    return cache;
  }

  function persist(set) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify([...set]));
    } catch { /* ignore */ }
  }

  return {
    has(questionId, label) { return read().has(`${questionId}:${label}`); },
    add(questionId, label) {
      const set = read();
      set.add(`${questionId}:${label}`);
      persist(set);
    },
    /** Single-select: this label, and only this label, on this question. */
    select(questionId, label) {
      const set = read();
      const prefix = `${questionId}:`;
      for (const key of [...set]) if (key.startsWith(prefix)) set.delete(key);
      if (label !== null) set.add(`${questionId}:${label}`);
      persist(set);
    },
    chosen(questionId) {
      const prefix = `${questionId}:`;
      for (const key of read()) if (key.startsWith(prefix)) return key.slice(prefix.length);
      return null;
    },
  };
}

/**
 * Remember how this browser voted on each freetext response.
 *
 * Kept client-side for the same reason votedStore is: the broadcast payload is
 * byte-identical for every student, which is what lets the server skip sending
 * an unchanged one. Putting "did *you* vote" in it would make every payload
 * per-person and throw that away for something the browser already knows.
 *
 * Stores +1, -1, or absent. Absent and 0 mean the same thing.
 */
export function responseVoteStore(slug) {
  const KEY = `folksonomy.responseVotes.${slug}`;
  let cache = null;

  function read() {
    if (cache) return cache;
    try {
      cache = new Map(Object.entries(JSON.parse(sessionStorage.getItem(KEY) || '{}')));
    } catch {
      cache = new Map();
    }
    return cache;
  }

  function persist(map) {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
    } catch { /* private browsing; the in-memory copy still works this session */ }
  }

  return {
    get(questionId, responseId) {
      return read().get(`${questionId}:${responseId}`) || 0;
    },
    /** Apply a tap locally, matching the server's undo/flip rule exactly. */
    toggle(questionId, responseId, direction) {
      const map = read();
      const key = `${questionId}:${responseId}`;
      const next = map.get(key) === direction ? 0 : direction;
      if (next === 0) map.delete(key);
      else map.set(key, next);
      persist(map);
      return next;
    },
    /** Accept the server's word for it, when the two disagree. */
    set(questionId, responseId, direction) {
      const map = read();
      const key = `${questionId}:${responseId}`;
      if (direction === 0) map.delete(key);
      else map.set(key, direction);
      persist(map);
    },
  };
}

/**
 * Put a sheet's join address and QR code into the given elements.
 *
 * Two separate attempts on purpose: the address is the thing that must be on
 * screen, and a failed QR fetch should not replace a good address with the
 * fallback. Both endpoints are public.
 */
export async function loadJoinDetails(slug, { urlEl, qrEl }) {
  const base = `/api/sheets/${encodeURIComponent(slug)}`;
  try {
    const { url } = await (await fetch(`${base}/join`)).json();
    urlEl.textContent = url.replace(/^https?:\/\//, '');
  } catch {
    urlEl.textContent = `${location.host}/${encodeURIComponent(slug)}`;
    return;
  }
  if (!qrEl) return;
  try {
    qrEl.innerHTML = await (await fetch(`${base}/qr.svg`)).text();
  } catch {
    /* the address is still there to read out */
  }
}

export function escapeHtml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * A WebSocket that reconnects on its own, with backoff.
 *
 * Not a nicety: phones lock, wifi roams between access points, and a socket that
 * dies silently leaves a student staring at a frozen cloud with no clue that
 * anything is wrong. Backoff is capped low enough that a server restart between
 * classes is picked up within a few seconds.
 */
export function connect({
  slug, role, onState, onStatus, onError,
  onSubmission, onVoteAck, onChoiceAck, onClusterStatus,
}) {
  let socket = null;
  let attempt = 0;
  let closed = false;
  let timer = null;

  function open() {
    if (closed) return;

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const query = new URLSearchParams({ slug });
    if (role) query.set('role', role);
    socket = new WebSocket(`${scheme}://${location.host}/ws?${query}`);

    socket.addEventListener('open', () => {
      attempt = 0;
      onStatus?.('online');
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'state_update') onState?.(msg);
      else if (msg.type === 'submission') onSubmission?.(msg);
      else if (msg.type === 'vote_ack') onVoteAck?.(msg);
      else if (msg.type === 'choice_ack') onChoiceAck?.(msg);
      else if (msg.type === 'cluster_status') onClusterStatus?.(msg);
      else if (msg.type === 'error') onError?.(msg.reason);
    });

    socket.addEventListener('close', () => {
      if (closed) return;
      onStatus?.('offline');
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      timer = setTimeout(open, delay);
    });

    socket.addEventListener('error', () => socket?.close());
  }

  open();

  return {
    send(msg) {
      if (socket?.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(msg));
        return true;
      }
      return false;
    },
    close() {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
