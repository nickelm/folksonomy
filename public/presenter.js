// Presenter console: create, clone, open, close, and export sheets.

import { api, checkSession, getToken, login } from '/auth.js';

const loginPanel = document.getElementById('login');
const consolePanel = document.getElementById('console');
const passwordInput = document.getElementById('password');
const loginBtn = document.getElementById('login-btn');
const loginError = document.getElementById('login-error');
const newTitle = document.getElementById('new-title');
const createBtn = document.getElementById('create-btn');
const createHint = document.getElementById('create-hint');
const rows = document.getElementById('sheet-rows');
const noSheets = document.getElementById('no-sheets');

async function boot() {
  if (await checkSession()) {
    showConsole();
  } else {
    loginPanel.hidden = false;
    passwordInput.focus();
  }
}

async function doLogin() {
  loginError.textContent = '';
  loginBtn.disabled = true;
  try {
    await login(passwordInput.value);
    passwordInput.value = '';
    loginPanel.hidden = true;
    showConsole();
  } catch (err) {
    loginError.textContent = err.message;
  } finally {
    loginBtn.disabled = false;
  }
}

loginBtn.addEventListener('click', doLogin);
passwordInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') doLogin();
});

function showConsole() {
  consolePanel.hidden = false;
  loadSheets();
}

createBtn.addEventListener('click', async () => {
  const title = newTitle.value.trim();
  if (!title) {
    createHint.textContent = 'Give it a title first.';
    createHint.classList.add('is-error');
    return;
  }
  createBtn.disabled = true;
  try {
    const { sheet } = await api('/api/sheets', {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    newTitle.value = '';
    createHint.classList.remove('is-error');
    createHint.textContent = `Created /${sheet.slug}`;
    await loadSheets();
  } catch (err) {
    createHint.classList.add('is-error');
    createHint.textContent = err.message;
  } finally {
    createBtn.disabled = false;
  }
});

newTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') createBtn.click();
});

function cell(text) {
  const td = document.createElement('td');
  td.textContent = text;
  return td;
}

function actionButton(label, className, handler) {
  const button = document.createElement('button');
  button.className = `btn btn-small ${className}`;
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

/**
 * Closing cannot be undone from this UI, so it asks for the sheet's title rather
 * than a yes/no. A misclick mid-lecture would freeze the exercise in front of
 * the whole room; typing the title is a deliberate act a stray tap cannot make.
 */
async function closeSheet(sheet) {
  const typed = prompt(
    `Closing "${sheet.title}" stops all responses permanently and reveals every `
    + 'tag cloud. This cannot be undone here.\n\n'
    + 'Type the sheet title to confirm:',
  );
  if (typed == null) return;
  if (typed.trim() !== sheet.title) {
    alert('That did not match the title. Nothing was changed.');
    return;
  }
  await api(`/api/sheets/${sheet.slug}/status`, {
    method: 'POST',
    body: JSON.stringify({ status: 'closed' }),
  });
  await loadSheets();
}

async function downloadExport(slug, kind) {
  // The export endpoints need an Authorization header, which a plain link cannot
  // send - so fetch the body and hand the browser a blob instead.
  const response = await fetch(`/api/sheets/${slug}/export.${kind}`, {
    headers: { Authorization: `Bearer ${getToken()}` },
  });
  if (!response.ok) {
    alert('Could not export that sheet.');
    return;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${slug}.${kind}`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function buildRow(sheet) {
  const tr = document.createElement('tr');

  const titleCell = document.createElement('td');
  const title = document.createElement('div');
  title.style.fontWeight = '600';
  title.textContent = sheet.title;
  const slug = document.createElement('code');
  slug.textContent = `/${sheet.slug}`;
  titleCell.append(title, slug);

  const statusCell = document.createElement('td');
  const badge = document.createElement('span');
  badge.className = `badge badge-${sheet.status}`;
  badge.textContent = sheet.status;
  statusCell.append(badge);

  const actions = document.createElement('td');
  const row = document.createElement('div');
  row.className = 'row';

  const open = document.createElement('a');
  open.className = 'btn btn-small btn-primary';
  open.href = `/presenter/${sheet.slug}`;
  open.textContent = 'Run';
  row.append(open);

  if (sheet.status === 'draft') {
    row.append(actionButton('Open to class', '', async () => {
      await api(`/api/sheets/${sheet.slug}/status`, {
        method: 'POST',
        body: JSON.stringify({ status: 'live' }),
      });
      await loadSheets();
    }));
  }

  if (sheet.status === 'live') {
    row.append(actionButton('Close', 'btn-danger', () => closeSheet(sheet)));
  }

  row.append(actionButton('Clone', '', async () => {
    const title = prompt('Title for the copy:', `${sheet.title} (copy)`);
    if (!title) return;
    await api(`/api/sheets/${sheet.slug}/clone`, {
      method: 'POST',
      body: JSON.stringify({ title }),
    });
    await loadSheets();
  }));

  row.append(actionButton('CSV', '', () => downloadExport(sheet.slug, 'csv')));
  row.append(actionButton('JSON', '', () => downloadExport(sheet.slug, 'json')));

  actions.append(row);

  tr.append(
    titleCell,
    statusCell,
    cell(sheet.question_count),
    cell(`${sheet.vote_count} from ${sheet.participant_count}`),
    actions,
  );
  return tr;
}

async function loadSheets() {
  const { sheets } = await api('/api/sheets');
  rows.innerHTML = '';
  noSheets.hidden = sheets.length > 0;
  for (const sheet of sheets) rows.append(buildRow(sheet));
}

boot();
