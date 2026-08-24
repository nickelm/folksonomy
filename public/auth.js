// Presenter token handling, shared by the console and the live control page.
//
// The token lives in sessionStorage rather than localStorage: a lectern machine
// is often shared, and the presenter session should not outlive the browser tab.

const KEY = 'folksonomy.presenterToken';

export function getToken() {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setToken(token) {
  try {
    sessionStorage.setItem(KEY, token);
  } catch { /* ignore */ }
}

export function clearToken() {
  try {
    sessionStorage.removeItem(KEY);
  } catch { /* ignore */ }
}

export async function login(password) {
  const response = await fetch('/api/presenter/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || 'Could not sign in');
  }

  const { token } = await response.json();
  setToken(token);
  return token;
}

/** True if the stored token is still one the server recognises. */
export async function checkSession() {
  const token = getToken();
  if (!token) return false;
  const response = await fetch('/api/presenter/session', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) clearToken();
  return response.ok;
}

/** fetch with the presenter token attached, throwing a useful error on failure. */
export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });

  if (response.status === 401) {
    clearToken();
    location.reload();
    throw new Error('Session expired');
  }

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${response.status})`);
  }

  return response.status === 204 ? null : response.json();
}
