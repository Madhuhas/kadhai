import { $, h, toast } from './util.js';
import { state, on, emit } from './store.js';
import { api } from './api.js';

/**
 * Rooms: other folders open at the same time. Each room is a Kadhai of its
 * own, in its own browser window; this menu lists them, opens their windows,
 * and starts a new one.
 */
let rooms = [];

const baseOf = (dir) => String(dir ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';

function render() {
  const others = rooms.filter((room) => !room.here);
  $('#rooms-count').textContent = String(rooms.length || 1);
  $('#rooms-list').replaceChildren(
    ...rooms.map((room) =>
      h(
        'div',
        { class: `room-row${room.here ? ' here' : ''}`, dataset: { state: room.state } },
        h(
          'button',
          {
            class: 'room-open',
            type: 'button',
            disabled: room.here || room.state !== 'running',
            title: room.here ? 'You are in this kitchen' : room.state === 'running' ? `${room.dir}\nOpen its window` : (room.error ?? 'Starting…'),
            onclick: () => {
              $('#rooms-menu').open = false;
              // Named after the room, so a second click goes to the window that is already there.
              window.open(room.url, `kadhai-room-${room.id}`);
            },
          },
          h('strong', null, room.name),
          h('span', { class: 'muted' }, room.here ? 'this window' : room.state === 'running' ? room.url.replace('http://', '') : room.state === 'starting' ? 'starting…' : 'stopped'),
        ),
        !room.main && !room.here
          ? h('button', { class: 'icon-btn', type: 'button', title: `Close the kitchen "${room.name}". Its folder is not touched.`, ariaLabel: `Close the kitchen ${room.name}`, onclick: () => close(room) }, '×')
          : null,
      ),
    ),
    ...(others.length ? [] : [h('p', { class: 'muted room-hint' }, 'One kitchen so far. A second kitchen is a second folder, with its own crew, cooking at the same time in its own window.')]),
    h(
      'button',
      {
        class: 'crew-row hire',
        type: 'button',
        onclick: () => {
          $('#rooms-menu').open = false;
          emit('newroom');
        },
      },
      '+ new kitchen',
    ),
  );
}

async function refresh() {
  try {
    ({ rooms } = await api.rooms.list());
  } catch {
    // Rooms are not available on this server (or the first room is away): show this one alone.
    rooms = [{ id: 'main', here: true, main: true, name: baseOf(state.app.workspaceDir) || 'workspace', dir: state.app.workspaceDir, url: location.origin, state: 'running' }];
  }
  render();
}

async function close(room) {
  if (!confirm(`Close the kitchen "${room.name}"?\n\nIts crew stops and its window stops working. The folder and everything in it stay as they are.`)) return;
  try {
    await api.rooms.close(room.id);
    toast(`Kitchen "${room.name}" closed`);
  } catch (err) {
    toast(err.message, 'err');
  }
  refresh();
}

/** Open a folder in a new room and show it. Called by the folder dialog. */
export async function openRoom(dir) {
  // Opened now, while this is still a click: a window opened after the wait would be blocked as a pop-up.
  const win = window.open('about:blank', '_blank');
  try {
    const room = await api.rooms.open(dir);
    if (win) win.location = room.url;
    else toast(`Kitchen "${room.name}" is ready at ${room.url}`, 'ok');
    refresh();
    return room;
  } catch (err) {
    // Already open somewhere: go there instead of failing.
    if (err.room?.url && win) {
      win.location = err.room.url;
      toast(`${err.message}: showing that kitchen`);
    } else {
      win?.close();
      throw err;
    }
    return null;
  }
}

export function initRooms() {
  $('#rooms-menu').addEventListener('toggle', (e) => e.target.open && refresh());
  on('sync', () => {
    // Several windows: each says which folder it is.
    document.title = `${baseOf(state.app.workspaceDir) || 'workspace'} · Kadhai`;
    refresh();
  });
}
