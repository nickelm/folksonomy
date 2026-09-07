// The presenter's "Next" control, shared by the dashboard and the live view.
//
// Both pages are projected. The presenter drives the lecture from the control
// page, but stepping to the next question from the screen everyone is looking
// at saves a tab switch at exactly the moment the room is waiting. So: one
// button, shown only once a presenter token has been verified, and a sign-in
// link discreet enough that a student glancing at the projector reads past it.
//
// Nothing here uses auth.js's api(): that helper reloads the page on a 401,
// which on a projected view mid-lecture means a blank screen for a second.

import { checkSession, clearToken, getToken, login } from '/auth.js';

/**
 * What pressing Next would do, given the current state.
 *
 * Questions arrive in position order. With nothing active, Next opens the first
 * question nobody has seen yet - or the first one, on a second pass. After the
 * last question there is nothing left to open, so the same button stops it:
 * ending the last question is a real act (student input closes and a freetext
 * question is clustered), and it belongs under the same key.
 */
export function nextStep(state) {
  const questions = state?.questions ?? [];
  if (questions.length === 0) return { kind: 'none' };

  const index = questions.findIndex((q) => q.id === state.activeQuestionId);
  if (index === -1) {
    return { kind: 'next', question: questions.find((q) => !q.revealed) || questions[0] };
  }
  const following = questions[index + 1];
  return following ? { kind: 'next', question: following } : { kind: 'stop' };
}

// How long the button stays held after a press if no broadcast confirms the
// change. Broadcasts land every 300ms; this only matters if one is lost.
const PENDING_MS = 1500;

/**
 * Build the control into `host` and wire it to the page's socket.
 *
 * @param {object} options
 * @param {HTMLElement} options.host
 * @param {(msg: object) => boolean} options.send  the page's socket send
 * @returns {{ update(state): void, online(): void, error(reason: string): void }}
 */
export function createAdvance({ host, send }) {
  const signin = el('button', 'advance-signin', 'Presenter? Sign in');
  signin.type = 'button';

  const form = document.createElement('form');
  form.className = 'advance-login';
  form.hidden = true;

  const password = document.createElement('input');
  password.type = 'password';
  password.className = 'advance-password';
  password.placeholder = 'Presenter password';
  password.autocomplete = 'current-password';
  password.setAttribute('aria-label', 'Presenter password');

  const submitBtn = el('button', 'btn btn-small btn-primary', 'Sign in');
  submitBtn.type = 'submit';

  const error = el('span', 'advance-error hint is-error', '');
  form.append(password, submitBtn, error);

  const control = document.createElement('div');
  control.className = 'advance-control';
  control.hidden = true;

  const next = el('button', 'btn btn-primary advance-next', 'Next');
  next.type = 'button';
  next.title = 'Open the next question (N or right arrow)';

  const upcoming = el('span', 'advance-upcoming', '');
  const hint = el('span', 'advance-hint hint', '');
  control.append(next, upcoming, hint);

  host.append(signin, form, control);

  let presenter = false;
  let latest = null;

  // Set on a press and cleared when a broadcast shows the active question moved,
  // so a double tap or a held key cannot step two questions on one intention.
  let waiting = false;
  let waitingFrom = null;
  let waitingTimer = null;

  function paint() {
    control.hidden = !presenter;
    signin.hidden = presenter || !form.hidden;

    const step = nextStep(latest);
    const closed = latest?.sheet?.status === 'closed';

    next.textContent = step.kind === 'stop' ? 'Stop' : 'Next';
    if (step.kind === 'next') upcoming.textContent = `Up next: ${step.question.title}`;
    else if (step.kind === 'stop') upcoming.textContent = 'Ends the last question';
    else upcoming.textContent = 'No questions yet';

    next.disabled = !latest || step.kind === 'none' || closed || waiting;
    if (closed) hint.textContent = 'This sheet is closed';
  }

  function advance() {
    if (!presenter || next.disabled) return;
    const step = nextStep(latest);
    if (step.kind === 'none') return;

    const questionId = step.kind === 'next' ? step.question.id : null;
    if (!send({ type: 'set_active', questionId })) {
      hint.textContent = 'Not connected';
      return;
    }

    hint.textContent = '';
    waiting = true;
    waitingFrom = latest?.activeQuestionId ?? null;
    clearTimeout(waitingTimer);
    waitingTimer = setTimeout(() => { waiting = false; paint(); }, PENDING_MS);
    paint();
  }

  function authenticate() {
    const token = getToken();
    if (token) send({ type: 'authenticate', token });
  }

  signin.addEventListener('click', () => {
    form.hidden = false;
    signin.hidden = true;
    password.focus();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    error.textContent = '';
    submitBtn.disabled = true;
    try {
      await login(password.value);
      password.value = '';
      form.hidden = true;
      presenter = true;
      authenticate();
      paint();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      submitBtn.disabled = false;
    }
  });

  next.addEventListener('click', advance);

  document.addEventListener('keydown', (event) => {
    if (!presenter || event.repeat) return;
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.target instanceof Element
        && event.target.closest('input, textarea, select, [contenteditable]')) return;
    if (event.key === 'ArrowRight' || event.key === 'n' || event.key === 'N') {
      event.preventDefault();
      advance();
    }
  });

  // A token left in this tab is checked quietly. Nothing presenter-shaped shows
  // until the server has said the token is good.
  if (getToken()) {
    checkSession().then((ok) => {
      presenter = ok;
      if (ok) authenticate();
      paint();
    });
  }
  paint();

  return {
    update(state) {
      latest = state;
      if (waiting && state.activeQuestionId !== waitingFrom) {
        waiting = false;
        clearTimeout(waitingTimer);
      }
      paint();
    },

    /** The socket (re)opened. The server forgets who we are on every connection. */
    online() {
      if (presenter) authenticate();
    },

    error(reason) {
      if (reason === 'bad_token') {
        // A server restart empties the token set. Back to the link.
        clearToken();
        presenter = false;
        form.hidden = true;
        paint();
      } else if (reason === 'not_authenticated') {
        // Pressed in the gap between a reconnect and its re-authentication.
        authenticate();
        hint.textContent = 'Reconnected - press again';
        waiting = false;
        paint();
      } else if (reason === 'sheet_closed' || reason === 'unknown_question') {
        hint.textContent = reason === 'sheet_closed'
          ? 'This sheet is closed'
          : 'That question is gone';
        waiting = false;
        paint();
      }
    },
  };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
