import { cloudEnabled, config } from '../config';
import { getDriveToken, getUser, isDriveConnected, renderSignInButton, signIn, signOut } from '../auth/google';
import { checkUsername, claimUsername, updateProfileMeta } from '../publish/publish';
import { fullResync, syncNow } from '../sync/sync';
import { bus, debounce, h, toast } from '../util/misc';
import { modal } from './modal';

export function openAccountModal(): void {
  const body = h('div', { class: 'account' });
  let close = () => {};
  const offs: Array<() => void> = [];
  const cleanup = () => offs.forEach((f) => f());

  // Rebuild the modal in place whenever sign-in / Drive state changes.
  const rerender = () => {
    body.innerHTML = '';
    fill(body, () => close());
  };
  offs.push(bus.on('auth', rerender));
  offs.push(bus.on('drive-connected', rerender));
  offs.push(bus.on('drive-needs-reconnect', rerender));

  fill(body, () => close());
  close = modal('Account', body, [], cleanup);
}

function fill(body: HTMLElement, close: () => void): void {
  const user = getUser();

  if (!cloudEnabled()) {
    body.append(
      h('p', { class: 'modal-message' }, [
        'Cloud sync is not configured for this deployment yet. The editor, offline storage and export all work without it.',
      ]),
    );
    return;
  }

  if (!user) {
    body.append(
      h('p', { class: 'modal-message' }, ['Sign in with Google to back up your notes to your own Drive and publish a public page.']),
    );
    const btnHost = h('div', { class: 'gsi-host' });
    const fallback = h('button', { class: 'btn btn-primary', onclick: () => void signIn() }, ['Continue with Google']);
    body.append(btnHost, fallback);
    setTimeout(() => {
      renderSignInButton(btnHost);
      // Google's button renders async; hide our fallback once it's there.
      setTimeout(() => { if (btnHost.childElementCount > 0) fallback.style.display = 'none'; }, 400);
    }, 60);
    return;
  }

  /* signed in */
  body.append(
    h('div', { class: 'account-id' }, [
      user.picture ? h('img', { src: user.picture, alt: '', class: 'avatar' }) : h('div', { class: 'avatar' }, ['👤']),
      h('div', {}, [h('strong', {}, [user.name]), h('div', { class: 'muted' }, [user.email])]),
    ]),
  );

  /* Drive */
  const driveRow = h('div', { class: 'account-row' });
  if (isDriveConnected()) {
    driveRow.append(
      h('span', { class: 'pill pill-ok' }, ['Drive connected']),
      h('button', { class: 'btn btn-sm', onclick: () => void syncNow('manual') }, ['Sync now']),
      h('button', { class: 'btn btn-sm', onclick: () => void fullResync() }, ['Full re-sync']),
    );
  } else {
    driveRow.append(
      h('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          try {
            await getDriveToken(false);
            toast('Google Drive connected — syncing.', 'success');
          } catch (e) {
            toast('Could not connect Drive: ' + (e as Error).message, 'error');
          }
        },
      }, ['Connect Google Drive']),
    );
  }
  body.append(h('h3', {}, ['Backup']), driveRow);

  /* Username / publishing */
  body.append(h('h3', {}, ['Public page']));
  if (user.username) {
    const url = `${config.SITE_URL}/${user.username}`;
    body.append(
      h('p', { class: 'modal-message' }, [
        'Your page: ',
        h('a', { href: url, target: '_blank', rel: 'noopener' }, [url]),
      ]),
    );
    const dn = h('input', { class: 'field', value: user.displayName ?? user.name, placeholder: 'Display name' }) as HTMLInputElement;
    const bio = h('textarea', { class: 'field', rows: '2', placeholder: 'Short bio (optional)' }) as HTMLTextAreaElement;
    bio.value = user.bio ?? '';
    body.append(
      h('label', { class: 'field-label' }, ['Display name', dn]),
      h('label', { class: 'field-label' }, ['Bio', bio]),
      h('button', {
        class: 'btn',
        onclick: async () => {
          await updateProfileMeta({ displayName: dn.value.trim(), bio: bio.value.trim() });
          toast('Profile updated.', 'success');
        },
      }, ['Save profile']),
    );
  } else {
    body.append(usernameClaimForm());
  }

  body.append(
    h('div', { class: 'account-foot' }, [
      h('button', {
        class: 'btn btn-sm',
        onclick: async () => {
          await signOut();
          toast('Signed out.');
          close();
        },
      }, ['Sign out']),
    ]),
  );
}

function usernameClaimForm(): HTMLElement {
  const wrap = h('div', { class: 'claim' });
  const input = h('input', { class: 'field', placeholder: 'your-name', autocapitalize: 'none', spellcheck: 'false' }) as HTMLInputElement;
  const status = h('div', { class: 'claim-status muted' }, ['3–30 chars · a–z, 0–9, hyphen']);
  const btn = h('button', { class: 'btn btn-primary', disabled: true }, ['Claim username']) as HTMLButtonElement;

  const check = debounce(async () => {
    const name = input.value.trim().toLowerCase();
    if (!name) {
      status.textContent = '3–30 chars · a–z, 0–9, hyphen';
      btn.disabled = true;
      return;
    }
    status.textContent = 'Checking…';
    try {
      const r = await checkUsername(name);
      if (r.available) {
        status.textContent = `✓ ${config.SITE_URL}/${name} is available`;
        status.className = 'claim-status ok';
        btn.disabled = false;
      } else {
        status.textContent = `✕ ${r.reason ?? 'taken'}`;
        status.className = 'claim-status bad';
        btn.disabled = true;
      }
    } catch {
      status.textContent = 'Name server unreachable.';
      btn.disabled = true;
    }
  }, 350);

  input.addEventListener('input', () => {
    input.value = input.value.toLowerCase().replace(/[^a-z0-9-]/g, '');
    check();
  });
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Claiming…';
    try {
      await claimUsername(input.value.trim());
      // updateStoredUser fires 'auth' -> the modal re-renders to the claimed state.
    } catch (e) {
      toast((e as Error).message, 'error');
      btn.disabled = false;
      btn.textContent = 'Claim username';
    }
  });

  wrap.append(
    h('p', { class: 'modal-message' }, ['Pick a username. Published notes will appear at ', h('code', {}, [`${config.SITE_URL}/you`]), '.']),
    h('div', { class: 'claim-row' }, [input, btn]),
    status,
  );
  return wrap;
}
