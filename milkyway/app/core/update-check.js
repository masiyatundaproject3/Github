const VERSION_URL = new URL('../app-version.json', import.meta.url);
const RELOAD_KEY = 'mw-service-worker-reloaded';

export async function checkDeployment(deploymentId, fetchImpl = fetch) {
  if (typeof deploymentId !== 'string' || !deploymentId) return null;
  const response = await fetchImpl(VERSION_URL, {
    cache: 'no-store',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Version check failed (${response.status}).`);
  const remote = await response.json();
  if (typeof remote?.buildId !== 'string' || !remote.buildId) throw new Error('Deployment version response is invalid.');
  return remote.buildId === deploymentId ? null : remote.buildId;
}

function showUpdateNotice(buildId) {
  if (!document.body || document.getElementById('mwUpdateNotice')) return;
  const notice = document.createElement('div');
  notice.id = 'mwUpdateNotice';
  notice.className = 'mw-update-notice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-live', 'polite');
  const message = document.createElement('span');
  message.textContent = 'A new MilkyWay version is ready.';
  const refresh = document.createElement('button');
  refresh.type = 'button';
  refresh.textContent = 'Refresh';
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    location.reload();
  });
  notice.append(message, refresh);
  document.body.append(notice);
  notice.dataset.buildId = buildId;
}

function registerWorker(deploymentId) {
  if (!('serviceWorker' in navigator)) return;
  if (typeof navigator.storage?.persist === 'function') {
    navigator.storage.persist().then(persisted => {
      if (!persisted) console.info('[offline-cache] browser did not grant persistent storage; cached content may be evicted');
    }).catch(error => console.warn('[offline-cache] persistent storage request failed', error));
  }
  const hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    try {
      if (sessionStorage.getItem(RELOAD_KEY) === deploymentId) return;
      sessionStorage.setItem(RELOAD_KEY, deploymentId);
    } catch {}
    location.reload();
  });
  navigator.serviceWorker.register(new URL('../../sw.js', import.meta.url), { updateViaCache: 'none' })
    .then(registration => registration.update().catch(() => {}))
    .catch(() => {});
}

export function startUpdateCheck(deploymentId) {
  registerWorker(deploymentId);
  let checking = false;
  const check = async () => {
    if (checking || !navigator.onLine) return;
    checking = true;
    try {
      const update = await checkDeployment(deploymentId);
      if (update) showUpdateNotice(update);
    } catch {
      // Offline or DNS errors must not block app startup; try again on reconnect or next foreground visit.
    } finally {
      checking = false;
    }
  };
  void check();
  addEventListener('online', check);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void check();
  });
}
