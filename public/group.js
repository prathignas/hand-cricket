// Group page: invite link + THIS WEEK / ALL TIME leaderboard.

import { apiRequest } from './api.js';
import { escapeHtml } from './match-ui.js';
import { getPlayerId, getSavedName, cleanName } from './player.js';
import { GROUP_CODE_PATTERN } from './home-groups.js';

const COPY_STATUS_MS = 2000;
const $ = (id) => document.getElementById(id);
const els = {
  name: $('group-name'),
  code: $('group-code'),
  copy: $('copy-invite'),
  copyStatus: $('copy-status'),
  line: $('standing-line'),
  body: $('board-body'),
  tabs: [...document.querySelectorAll('.tab')],
};

const state = { code: '', range: 'week', playerId: getPlayerId(), loading: false };

async function load() {
  state.loading = true;
  renderTabs();
  const response = await apiRequest(`/groups/${state.code}/leaderboard?range=${state.range}`);
  state.loading = false;
  if (!response.ok) {
    renderProblem(response);
    return;
  }
  document.title = `${response.group.name} — Hand Cricket`;
  els.name.textContent = response.group.name;
  els.line.hidden = !response.line;
  els.line.textContent = response.line;
  els.body.innerHTML = tableHtml(response.rows);
  renderTabs();
}

function tableHtml(rows) {
  if (rows.length === 0) return '<p class="board-empty">No members yet.</p>';
  const body = rows
    .map((row) => {
      const isMe = row.playerId === state.playerId;
      const crown = row.rank === 1 && row.wins > 0;
      const streak = row.streak >= 2 ? `🔥 ${row.streak}` : row.streak === 1 ? '1' : '—';
      return `
        <tr class="${isMe ? 'is-me' : ''} ${crown ? 'is-first' : ''}">
          <td class="rank">${crown ? '👑 ' : ''}${row.rank}</td>
          <td>${escapeHtml(row.name)}${isMe ? '<span class="you-tag">YOU</span>' : ''}</td>
          <td>${row.played}</td>
          <td>${row.wins}</td>
          <td>${row.played ? `${row.winPct}%` : '—'}</td>
          <td>${streak}</td>
        </tr>`;
    })
    .join('');
  return `
    <div class="table-wrap">
      <table class="board-table">
        <thead><tr><th>RANK</th><th>NAME</th><th>PLAYED</th><th>WINS</th><th>WIN %</th><th>STREAK</th></tr></thead>
        <tbody>${body}</tbody>
      </table>
    </div>`;
}

function renderProblem({ status, error }) {
  els.line.hidden = true;
  let action = '<button class="btn btn-small" data-retry>Try again</button>';
  if (status === 403) action = '<button class="btn btn-small" data-join>Join this group</button>';
  if (status === 404 || status === 400) action = '<a class="btn btn-small" href="/">Back to home</a>';
  if (status === 404 || status === 400) els.name.textContent = 'Group not found';
  els.body.innerHTML = `<div class="board-empty"><p>${escapeHtml(error)}</p>${action}</div>`;
}

async function joinThisGroup() {
  const playerName = cleanName(getSavedName());
  if (!playerName) {
    location.href = `/?group=${state.code}`; // pick a name first; the home screen then joins
    return;
  }
  const response = await apiRequest('/groups/join', { method: 'POST', body: { code: state.code, playerName } });
  if (response.ok) load();
  else renderProblem(response);
}

async function copyInvite() {
  const link = `${location.origin}/?group=${state.code}`;
  try {
    await navigator.clipboard.writeText(link);
    els.copyStatus.textContent = 'Invite link copied!';
  } catch (error) {
    console.warn('Clipboard blocked, showing the link instead:', error);
    window.prompt('Copy this invite link and send it to your friends:', link);
  }
  setTimeout(() => {
    els.copyStatus.textContent = '';
  }, COPY_STATUS_MS);
}

function renderTabs() {
  for (const tab of els.tabs) {
    tab.setAttribute('aria-selected', String(tab.dataset.range === state.range));
  }
}

els.tabs.forEach((tab) =>
  tab.addEventListener('click', () => {
    if (tab.dataset.range === state.range || state.loading) return;
    state.range = tab.dataset.range;
    load();
  })
);
els.copy.addEventListener('click', copyInvite);
els.body.addEventListener('click', (event) => {
  if (event.target.closest('[data-retry]')) load();
  if (event.target.closest('[data-join]')) joinThisGroup();
});

function boot() {
  const code = (new URLSearchParams(location.search).get('code') ?? '').trim().toUpperCase();
  if (!GROUP_CODE_PATTERN.test(code)) {
    location.replace('/');
    return;
  }
  state.code = code;
  els.code.textContent = code;
  load();
}

boot();
