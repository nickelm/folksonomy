// Student-facing list of sheets.

const container = document.getElementById('sheets');

function timeAgo(ms) {
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  const months = Math.round(days / 30);
  return months === 1 ? 'a month ago' : `${months} months ago`;
}

function render(sheets) {
  container.innerHTML = '';

  if (sheets.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'Nothing here yet. Your instructor has not opened a sheet.';
    container.append(empty);
    return;
  }

  const list = document.createElement('ul');
  list.className = 'sheet-list';

  for (const sheet of sheets) {
    const item = document.createElement('li');
    const link = document.createElement('a');
    link.className = 'sheet-link';
    link.href = `/${sheet.slug}`;

    const left = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = sheet.title;
    const slug = document.createElement('span');
    slug.className = 'slug';
    slug.textContent = sheet.status === 'live'
      ? `/${sheet.slug}`
      : `/${sheet.slug} - ${timeAgo(sheet.closed_at || sheet.created_at)}`;
    left.append(title, slug);

    const badge = document.createElement('span');
    badge.className = `badge badge-${sheet.status === 'live' ? 'live' : 'closed'}`;
    badge.textContent = sheet.status === 'live' ? 'Live now' : 'Closed';

    link.append(left, badge);
    item.append(link);
    list.append(item);
  }

  container.append(list);
}

async function load() {
  try {
    const response = await fetch('/api/public/sheets');
    const data = await response.json();
    render(data.sheets || []);
  } catch {
    container.innerHTML = '<p class="empty">Could not load the list. Try again.</p>';
  }
}

load();

// A student may land here before the instructor opens the sheet, then sit with
// the page open waiting. Refresh quietly so it appears without a manual reload.
setInterval(load, 15_000);
