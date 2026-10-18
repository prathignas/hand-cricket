// "My groups" panel on the home screen: list with this week's standing, create, join.

import { apiRequest } from './api.js';
import { escapeHtml } from './match-ui.js';

export const GROUP_CODE_PATTERN = /^[A-HJKMNP-Z2-9]{6}$/; // must match groups.js
const MAX_GROUP_NAME_LENGTH = 30;

export const groupPageUrl = (code) => `/group.html?code=${encodeURIComponent(code)}`;

/**
 * @param {{ element: HTMLElement, requireName: () => string|null }} options
 *   requireName checks the home screen's name field and returns the name, or null after showing why.
 */
export function createGroupsPanel({ element, requireName }) {
  const state = { groups: null, loading: false, error: '', busy: false };

  async function load() {
    state.loading = true;
    render();
    const response = await apiRequest('/me/groups');
    state.loading = false;
    if (response.ok) {
      state.groups = response.groups;
      state.error = '';
    } else {
      state.error = response.error;
    }
    render();
  }

  async function submit(kind) {
    if (state.busy) return;
    const name = requireName();
    if (!name) return;

    const input = element.querySelector(kind === 'create' ? '#group-name-input' : '#group-code-input');
    const value = input.value.trim();
    if (kind === 'create' && !value) return showError('Give your group a name, like “CSE Gang”.', input);
    if (kind === 'join' && !GROUP_CODE_PATTERN.test(value.toUpperCase())) {
      return showError('Group codes are 6 characters, like K7MX2Q.', input);
    }

    state.busy = true;
    state.error = '';
    render();
    const response =
      kind === 'create'
        ? await apiRequest('/groups', { method: 'POST', body: { name: value, playerName: name } })
        : await apiRequest('/groups/join', { method: 'POST', body: { code: value, playerName: name } });
    state.busy = false;
    if (response.ok) {
      location.href = groupPageUrl(response.group.code);
      return;
    }
    showError(response.error);
  }

  function showError(message, focus) {
    state.error = message;
    render();
    if (focus) element.querySelector(`#${focus.id}`)?.focus();
  }

  function render() {
    // Keep what the player was typing across re-renders.
    const typedName = element.querySelector('#group-name-input')?.value ?? '';
    const typedCode = element.querySelector('#group-code-input')?.value ?? '';

    element.innerHTML = `
      <h2 class="groups-title">MY GROUPS</h2>
      <div class="groups-list" aria-live="polite">${listHtml()}</div>
      ${state.error ? `<p class="form-error" role="alert">${escapeHtml(state.error)}</p>` : ''}
      <form class="row" data-group-form="create">
        <input class="text-input small-input" id="group-name-input" maxlength="${MAX_GROUP_NAME_LENGTH}"
          placeholder="New group, e.g. CSE Gang" aria-label="New group name" autocomplete="off" value="${escapeHtml(typedName)}">
        <button class="btn btn-small" type="submit" ${state.busy ? 'disabled' : ''}>Create</button>
      </form>
      <form class="row" data-group-form="join">
        <input class="text-input small-input code-input" id="group-code-input" maxlength="6"
          placeholder="CODE" aria-label="Group code" autocomplete="off" spellcheck="false" value="${escapeHtml(typedCode)}">
        <button class="btn btn-small btn-pink" type="submit" ${state.busy ? 'disabled' : ''}>Join</button>
      </form>`;
  }

  function listHtml() {
    if (state.loading && !state.groups) return '<p class="groups-empty">Loading your groups…</p>';
    if (!state.groups) return '<p class="groups-empty">Groups couldn’t load.</p>';
    if (state.groups.length === 0) {
      return '<p class="groups-empty">No groups yet. Make one for your friends and share the link — wins between members land on its leaderboard.</p>';
    }
    return state.groups
      .map(
        (group) => `
        <a class="group-row" href="${groupPageUrl(group.code)}">
          <span class="group-row-top">
            <span class="group-row-name">${escapeHtml(group.name)}</span>
            <span class="group-row-meta">${group.members} member${group.members === 1 ? '' : 's'}${
              group.rank === 1 && group.wins > 0 ? ' · 👑' : group.rank ? ` · #${group.rank}` : ''
            }</span>
          </span>
          <span class="group-row-line">${escapeHtml(group.line)}</span>
        </a>`
      )
      .join('');
  }

  element.addEventListener('submit', (event) => {
    event.preventDefault();
    event.stopPropagation();
    submit(event.target.dataset.groupForm);
  });
  element.addEventListener('input', (event) => {
    if (event.target.id === 'group-code-input') {
      event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    }
  });

  return {
    load,
    setVisible(visible) {
      element.hidden = !visible;
      element.closest('.home-grid')?.classList.toggle('has-groups', visible);
      if (visible && !state.groups && !state.loading) load();
    },
  };
}
