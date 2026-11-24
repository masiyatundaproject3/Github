// Profile ("Nova" tab for the signed-in user, or any author tapped in the feed / Lives).
// Header, counts and posts come from Supabase as the caller, so row-level security decides what is visible.
import { t } from '../core/i18n.js';
import { api, auth, supabase } from '../core/net.js';
import { config } from '../config.js';
import { identifyMediaFile, openFilePicker } from '../core/media-files.js';
import { optimizeImage } from '../core/media-optimizer.js';
import { setImage, poster } from '../core/media.js';
import { profiles } from '../data/profiles.js';
import { actions } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, icon, avatar, count, toast } from './dom.js';
import { PostViewer, postKind } from './post-viewer.js';
import { presence } from '../data/presence.js';
import { isOwnerAccount } from './admin-view.js';
import { openShare } from './share-sheet.js';
import { USERNAME_COOLDOWN_MS, usernameAvailable, usernameValidationMessage } from '../data/usernames.js';

const quiet = promise => Promise.resolve(promise).then(result => result, () => ({}));
const profileText = value => typeof value === 'string' ? value.replace(/\b(?:null|undefined)\b/gi, '').trim() : '';

const PROFILE_POST_REQUIRED = ['id', 'author_id', 'caption', 'media_url', 'media_type', 'created_at'];
const PROFILE_POST_OPTIONAL = ['scheduled_at', 'slideshow_style', 'audio_url', 'media_items', 'media_preview_items'];
const PROFILE_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);
const PROFILE_PHOTO_MAX_BYTES = 10 * 1024 * 1024;
const PROFILE_PHOTO_MAX_PIXELS = 40_000_000;

async function validateProfilePhoto(file) {
  const info = await identifyMediaFile(file);
  if (info.kind !== 'image' || !PROFILE_PHOTO_TYPES.has(info.type)) throw new Error(t('photoUnsupported'));
  if (file.size > PROFILE_PHOTO_MAX_BYTES) throw new Error(t('photoTooLarge'));
  const url = URL.createObjectURL(file);
  try {
    const dimensions = await new Promise((resolve, reject) => {
      if (typeof createImageBitmap === 'function') {
        createImageBitmap(file).then(bitmap => {
          resolve([bitmap.width, bitmap.height]);
          bitmap.close?.();
        }).catch(() => {
          const image = new Image();
          image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
          image.onerror = () => reject(new Error(t('photoUnsupported')));
          image.src = url;
        });
      } else {
        const image = new Image();
        image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
        image.onerror = () => reject(new Error(t('photoUnsupported')));
        image.src = url;
      }
    });
    if (!dimensions[0] || !dimensions[1]) throw new Error(t('photoUnsupported'));
    if (dimensions[0] * dimensions[1] > PROFILE_PHOTO_MAX_PIXELS) throw new Error(t('photoTooLarge'));
  } finally {
    URL.revokeObjectURL(url);
  }
}

function missingProfileColumn(error, columns) {
  const message = String(error?.message || '');
  if (!['PGRST204', '42703'].includes(String(error?.code || ''))
    && !/schema cache|column .* does not exist|could not find the .*column/i.test(message)) return null;
  return columns.find(column => new RegExp(`\\b${column}\\b`, 'i').test(message)) || columns[columns.length - 1] || null;
}

async function loadProfilePosts(sb, id) {
  const optional = [...PROFILE_POST_OPTIONAL];
  while (true) {
    const fields = [...PROFILE_POST_REQUIRED, ...optional].join(',');
    const result = await sb.from('mw_posts').select(fields).eq('author_id', id).order('created_at', { ascending: false }).limit(30);
    if (!result.error) {
      const rows = Array.isArray(result.data) ? result.data : [];
      return { ...result, data: rows.filter(row => row && typeof row === 'object').map(normalizeProfilePost) };
    }
    const missing = missingProfileColumn(result.error, optional);
    if (!missing) return result;
    optional.splice(optional.indexOf(missing), 1);
  }
}

function normalizeProfilePost(row) {
  const mediaItems = Array.isArray(row.media_items) ? row.media_items.filter(item => typeof item === 'string') : [];
  const previews = Array.isArray(row.media_preview_items) ? row.media_preview_items.filter(item => typeof item === 'string') : [];
  const mediaUrl = typeof row.media_url === 'string' && row.media_url ? row.media_url : mediaItems[0] || '';
  const mediaType = typeof row.media_type === 'string' ? row.media_type : /\.(mp4|m4v|mov|webm|ogv|3gp)(\?|#|$)/i.test(mediaUrl) ? 'video' : mediaUrl ? 'image' : null;
  return { ...row, media_url: mediaUrl, media_type: mediaType, media_items: mediaItems, media_preview_items: previews };
}

export class ProfileView {
  constructor({ requireLogin, openCreate, openComments, openMenu, openChat, openFollowers, openActivity }) {
    this.hooks = { requireLogin, openCreate, openComments, openMenu, openChat, openFollowers, openActivity };
    this.sheet = new Sheet({ title: t('me'), className: 'profile-sheet', onClose: () => this.#sheetClosed() });
    this.content = h('div', { class: 'profile' });
    this.sheet.body.append(this.content);
    this.token = 0;
    this.posts = [];
    this.viewer = null;
    this.historyEntry = null;
    this.historyPopPending = null;
    this.handlingProfilePop = false;
    addEventListener('popstate', () => this.#historyChanged());
    // Delete confirmation for a post picked from the grid's "⋯" button.
    this.menu = new Sheet({ title: t('post'), className: 'post-menu-sheet' });
  }

  #viewer() {
    return this.viewer ||= new PostViewer({
      requireLogin: () => this.hooks.requireLogin(),
      openComments: post => this.hooks.openComments?.(post),
      onDeleted: post => this.#removed(post),
    });
  }

  #openPost(post) {
    const source = this.displayPosts || this.posts;
    const index = source.indexOf(post);
    if (index >= 0) this.#viewer().open(source, index, { own: post.author_id === auth.userId });
  }

  #removed(post) {
    const postId = String(post.id);
    const at = this.posts.findIndex(item => String(item.id) === postId);
    if (at >= 0) this.posts.splice(at, 1);
    this.displayPosts = (this.displayPosts || []).filter(item => String(item.id) !== postId);
    this.grid?.querySelector(`[data-post="${CSS.escape(postId)}"]`)?.remove();
    if (at >= 0 && this.postCount) this.postCount.textContent = count(this.posts.length);
    if (this.grid && !this.displayPosts.length) {
      const message = this.activeTab === 'saved' ? t('noSaved')
        : this.activeTab === 'liked' ? t('empty')
          : this.own ? t('noPostsYet') : t('empty');
      this.#renderGrid([], { message });
    }
  }

  #pushProfileHistory() {
    if (this.historyEntry) return;
    const state = history.state && typeof history.state === 'object' ? history.state : {};
    const entry = `profile-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    history.pushState({ ...state, mwProfileSheet: entry }, '', location.href);
    this.historyEntry = entry;
  }

  #sheetClosed() {
    clearInterval(this.usernameCooldownTimer);
    const entry = this.historyEntry;
    if (!entry || this.handlingProfilePop) return;
    this.historyEntry = null;
    if (history.state?.mwProfileSheet === entry) {
      this.historyPopPending = entry;
      history.back();
    }
  }

  #historyChanged() {
    const currentEntry = history.state?.mwProfileSheet;
    if (this.historyPopPending && currentEntry !== this.historyPopPending) {
      this.historyPopPending = null;
      return;
    }
    if (!this.historyEntry || currentEntry === this.historyEntry) return;
    const topLayer = [...document.querySelectorAll('.sheet-layer.open, .pv-layer.open')].at(-1);
    if (topLayer && topLayer !== this.sheet.root) {
      this.historyEntry = null;
      if (topLayer.matches('.pv-layer')) topLayer.querySelector('.pv-close')?.click();
      else topLayer.querySelector('.sheet-backdrop')?.click();
      this.#pushProfileHistory();
      return;
    }
    this.historyEntry = null;
    this.handlingProfilePop = true;
    this.sheet.close();
    this.handlingProfilePop = false;
  }

  close() {
    if (this.historyEntry && history.state?.mwProfileSheet === this.historyEntry) {
      history.back();
      return;
    }
    this.sheet.close();
  }

  #renderGrid(posts = this.posts, { loading = false, message = '' } = {}) {
    if (!this.grid) return;
    this.displayPosts = posts;
    if (loading) {
      this.grid.replaceChildren(h('p', { class: 'muted center', role: 'status' }, t('loading')));
    } else if (message) {
      this.grid.replaceChildren(h('p', { class: 'muted center', role: 'status' }, profileText(message)));
    } else if (!posts.length) {
      this.grid.replaceChildren(h('p', { class: 'muted center' }, this.own ? t('noPostsYet') : t('empty')));
    } else {
      this.grid.replaceChildren(...posts.map(post => tile(post, {
        open: () => this.#openPost(post),
        menu: this.own && post.author_id === auth.userId ? () => this.#postMenu(post) : null,
      })));
    }
  }

  async #selectTab(tab) {
    this.activeTab = tab;
    this.tabs?.forEach(button => button.setAttribute('aria-selected', String(button.dataset.profileTab === tab)));
    const token = this.token;
    if (tab === 'posts') { this.#renderGrid(); return; }
    if (tab === 'private') {
      this.#renderGrid([], { message: !this.own && this.profilePrivate ? t('privateAccount') : t('empty') });
      return;
    }
    if (!this.own) { this.#renderGrid([], { message: t('privateActivity') }); return; }

    this.#renderGrid([], { loading: true });
    try {
      const sb = await supabase();
      let ids = [];
      if (tab === 'saved') {
        const result = await api(`${config.api.feed}?action=saved`, { timeout: 12000 });
        ids = (Array.isArray(result?.saved) ? result.saved : [])
          .map(item => String(item?.postId || '')).filter(Boolean).slice(0, 100);
      } else {
        const { data, error } = await sb.from('mw_signals').select('post_id')
          .eq('user_id', this.id).eq('kind', 'light').limit(100);
        if (error) throw error;
        ids = [...new Set((Array.isArray(data) ? data : []).map(row => String(row?.post_id || '')).filter(Boolean))];
      }
      if (token !== this.token || tab !== this.activeTab) return;
      if (!ids.length) { this.#renderGrid([], { message: tab === 'saved' ? t('noSaved') : t('empty') }); return; }
      const { data, error } = await sb.from('mw_posts').select(PROFILE_POST_REQUIRED.join(',')).in('id', ids);
      if (error) throw error;
      if (token !== this.token || tab !== this.activeTab) return;
      const byId = new Map((Array.isArray(data) ? data : []).map(row => [String(row.id), normalizeProfilePost(row)]));
      const posts = ids.map(id => byId.get(id)).filter(Boolean);
      this.#renderGrid(posts, { message: posts.length ? '' : tab === 'saved' ? t('noSaved') : t('empty') });
    } catch (error) {
      if (token === this.token && tab === this.activeTab) this.#renderGrid([], { message: profileText(error?.message) || t('retry') });
    }
  }

  #postMenu(post) {
    const message = h('p', { class: 'muted center', role: 'status' });
    const remove = h('button', { class: 'pill-btn danger wide', type: 'button' }, t('deletePost'));
    let armed = 0;
    remove.onclick = async () => {
      if (!armed) {
        remove.textContent = t('tapAgainDelete'); remove.classList.add('armed');
        armed = setTimeout(() => { armed = 0; remove.textContent = t('deletePost'); remove.classList.remove('armed'); }, 3000);
        return;
      }
      clearTimeout(armed);
      remove.disabled = true; remove.textContent = t('deleting'); message.textContent = '';
      try {
        await actions.remove(post);
        this.#removed(post);
        this.menu.close();
        toast(t('postDeleted'));
      } catch (error) {
        armed = 0; remove.disabled = false; remove.textContent = t('deletePost'); remove.classList.remove('armed');
        message.textContent = profileText(error?.message) || t('deleteFailed');
      }
    };
    this.menu.body.replaceChildren(h('div', { class: 'stack' },
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => { this.menu.close(); this.#openPost(post); } }, t('openPost')),
      remove, message,
      h('button', { class: 'link center', type: 'button', onclick: () => this.menu.close() }, t('cancel'))));
    this.menu.open();
  }

  /** person: { id, name, username, avatar } or null for the signed-in user. */
  open(person = null, { photo = null, fullscreen = false } = {}) {
    const id = String(person?.id || auth.userId || '');
    if (!id) return;
    this.pendingPhoto = photo;
    this.id = id;
    this.own = id === auth.userId;
    this.activeTab = 'posts';
    this.sheet.panel.classList.toggle('profile-sheet-fullscreen', fullscreen);
    this.sheet.title = this.own ? t('me') : (profileText(person?.name || profiles.peek(id)?.name) || t('profile'));
    this.sheet.panel.setAttribute('aria-label', this.sheet.title);
    this.#render({ profile: person || profiles.peek(id) || { id, name: this.own ? auth.name : '' }, loading: true });
    this.#pushProfileHistory();
    this.sheet.open();
    this.#load(id);
  }

  openForPhoto(file) {
    if (!auth.userId || !file) return;
    this.open(null, { photo: file });
  }

  async #load(id) {
    const token = ++this.token;
    this.mode = 'profile';
    try {
      const sb = await supabase();
      const head = { count: 'exact', head: true };
      const [profile, followers, following, posts, followingRows, followerRows, requests] = await Promise.all([
        quiet(sb.from('mw_profiles').select('*').eq('id', id).maybeSingle()),
        quiet(sb.from('mw_follows').select('follower_id', head).eq('following_id', id)),
        quiet(sb.from('mw_follows').select('following_id', head).eq('follower_id', id)),
        quiet(loadProfilePosts(sb, id)),
        quiet(sb.from('mw_follows').select('following_id').eq('follower_id', id).limit(2000)),
        quiet(sb.from('mw_follows').select('follower_id').eq('following_id', id).limit(2000)),
        this.own ? quiet(sb.from('mw_follow_requests').select('requester_id', head).eq('target_id', id)) : Promise.resolve({ count: 0 }),
      ]);
      if (token !== this.token) return;
      const row = profile.data || {};
      const person = {
        id,
        name: row.display_name || profiles.peek(id)?.name || (this.own ? auth.name : 'MilkyWay'),
        username: row.username || '',
        usernameAutoGenerated: Boolean(row.username_auto_generated),
        usernameUpdatedAt: row.username_updated_at || '',
        avatar: row.avatar_url || '',
        bio: row.bio || '',
        role: row.role || row.status || '',
        interests: row.interests || [],
        private: Boolean(row.is_private),
      };
      profiles.prime([{ id, name: person.name, username: person.username, avatar: person.avatar, private: person.private }]);
      if (!this.own) this.sheet.title = profileText(person.name) || t('profile');
      const { data: pin } = await quiet(sb.from('mw_creator_pins').select('post_id').eq('creator_id', id).maybeSingle());
      const profilePosts = Array.isArray(posts.data) ? posts.data : [];
      if (pin?.post_id) profilePosts.sort((a, b) => Number(b.id === pin.post_id) - Number(a.id === pin.post_id));
      const followingIds = new Set((followingRows.data || []).map(item => String(item.following_id)));
      const friends = (followerRows.data || []).reduce((total, item) => total + Number(followingIds.has(String(item.follower_id))), 0);
      const renderData = {
        profile: person,
        followers: followers.count || 0,
        following: following.count || 0,
        friends,
        requests: requests.count || 0,
        posts: profilePosts,
        postsError: profileText(posts.error?.message),
      };
      this.#render(renderData);
      if (this.own && this.pendingPhoto) {
        const selected = this.pendingPhoto;
        this.pendingPhoto = null;
        this.#edit(person, { photo: selected });
      }
      this.#loadBusiness(person, token);
    } catch {
      if (token === this.token) this.#render({ profile: profiles.peek(id) || { id }, error: true });
    }
  }

  async #loadBusiness(profile, token) {
    let section;
    try {
      const sb = await supabase();
      const { data, error } = await sb.from('mw_creator_services')
        .select('id,title,category,description,pricing')
        .eq('creator_id', profile.id).eq('is_published', true).order('created_at', { ascending: false });
      if (error) throw error;
      if (token !== this.token || this.mode !== 'profile' || !data?.length) return;
      section = h('section', { class: 'mw-profile-services' },
        h('h3', {}, t('studioPortfolio')),
        h('div', { class: 'mw-studio-service-list' }, ...data.map(service => this.#profileService(service, profile))));
    } catch (error) {
      if (token !== this.token || this.mode !== 'profile') return;
      section = h('section', { class: 'mw-profile-services' },
        h('h3', {}, t('studioPortfolio')),
        h('p', { class: 'muted', role: 'status' }, `${t('studioServiceUnavailable')}: ${profileText(error?.message) || t('retry')}`));
    }
    if (token === this.token && this.mode === 'profile' && section) this.content.append(section);
  }

  #profileService(service, profile) {
    const card = h('article', { class: 'mw-studio-service-card' },
      h('div', {}, h('small', { class: 'mw-studio-eyebrow' }, profileText(service.category)),
        h('h4', {}, profileText(service.title)), h('p', { class: 'muted' }, profileText(service.description)),
        profileText(service.pricing) ? h('b', { class: 'mw-studio-price' }, profileText(service.pricing)) : null));
    if (this.own || !auth.signedIn()) return card;
    const button = h('button', { class: 'pill-btn hot', type: 'button', onclick: () => {
      const note = h('p', { class: 'muted', role: 'status' });
      const preferredAt = h('input', { class: 'field', type: 'datetime-local', 'aria-label': t('studioPreferredDate') });
      const inquiryText = h('textarea', { class: 'field area', maxlength: '2000', minlength: '10', required: true, placeholder: t('studioInquiryMessage') });
      const submit = h('button', { class: 'pill-btn hot', type: 'submit' }, t('studioSendInquiry'));
      const form = h('form', { class: 'mw-studio-service-request', onsubmit: async event => {
        event.preventDefault();
        submit.disabled = true;
        try {
          const sb = await supabase();
          const { error } = await sb.from('mw_service_inquiries').insert({
            service_id: service.id,
            creator_id: profile.id,
            requester_id: auth.userId,
            client_name: auth.name.slice(0, 80),
            message: inquiryText.value.trim(),
            preferred_at: preferredAt.value ? new Date(preferredAt.value).toISOString() : null,
          });
          if (error) throw error;
          note.textContent = t('studioInquirySent');
          submit.remove();
          toast(t('studioInquirySent'));
        } catch (error) {
          note.textContent = profileText(error?.message) || t('retry');
          submit.disabled = false;
        }
      } }, preferredAt, inquiryText, submit, note);
      card.replaceChildren(card.firstElementChild, form);
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } }, t('studioRequestService'));
    card.append(button);
    return card;
  }

  #render({ profile, followers = 0, following = 0, friends = 0, requests = 0, posts = [], loading = false, error = false, postsError = '' }) {
    profile = profile && typeof profile === 'object' ? profile : { id: this.id || auth.userId || '' };
    this.profilePrivate = Boolean(profile.private);
    this.posts = Array.isArray(posts) ? posts.filter(post => post && typeof post === 'object') : [];
    this.postCount = h('b', {}, count(this.posts.length));
    const stats = h('div', { class: 'profile-stats' },
      h('button', { type: 'button', onclick: () => this.hooks.openFollowers?.(profile, { tab: 'following' }) }, h('b', {}, count(following)), t('followingCount')),
      h('button', { type: 'button', onclick: () => this.hooks.openFollowers?.(profile, { tab: 'followers' }) }, h('b', {}, count(followers)), t('followers')),
      h('button', { type: 'button', onclick: () => this.hooks.openFollowers?.(profile, { tab: 'friends' }) }, h('b', {}, count(friends)), t('friends')),
      h('span', {}, this.postCount, t('posts')));
    const actionsRow = h('div', { class: 'profile-actions' });
    if (this.own) {
      actionsRow.append(
        h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#edit(profile) }, t('editProfile')),
        h('button', { class: 'pill-btn hot', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openCreate(); } }, t('create')));
      // Owner-only gold Admin button (shown at once for the owner email; the server checks again on every action).
      if (isOwnerAccount() && !actionsRow.querySelector('.nova-admin-btn')) {
        actionsRow.append(h('button', { class: 'pill-btn nova-admin-btn', type: 'button', onclick: () => {
          this.sheet.close();
          import('./admin-view.js').then(m => (ProfileView.admin ||= new m.AdminView()).open());
        } }, '🛡 Admin'));
      }
    } else if (auth.signedIn()) {
      const button = h('button', { class: 'pill-btn hot', type: 'button' });
      const paint = () => {
        const on = profiles.isFollowing(profile.id);
        const requested = profiles.isRequested(profile.id);
        button.textContent = on ? t('following') : requested ? t('requested') : t('follow');
        button.classList.toggle('hot', !on && !requested);
        button.setAttribute('aria-pressed', String(on || requested));
      };
      button.onclick = () => {
        const on = !profiles.isFollowing(profile.id) && !profiles.isRequested(profile.id);
        actions.follow(profile.id, on).then(paint).catch(() => toast(t('queued')));
        paint();
      };
      paint();
      actionsRow.append(button,
        h('button', { class: 'pill-btn', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openChat?.(profile); } }, h('span', { html: icon.inbox }), t('inbox')));
    } else {
      actionsRow.append(h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.hooks.requireLogin() }, t('follow')));
    }

    const grid = this.grid = h('div', { class: 'profile-grid' });
    grid.id = 'profileMediaGrid';
    const tabItems = [
      ['posts', t('posts'), '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3h8v8H3zm10 0h8v8h-8zM3 13h8v8H3zm10 0h8v8h-8z"/></svg>'],
      ['private', t('privateAccount'), '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 10V7a6 6 0 0 1 12 0v3h1a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zm2 0h8V7a4 4 0 0 0-8 0zm4 4a2 2 0 0 0-1 3.73V19h2v-1.27A2 2 0 0 0 12 14z"/></svg>'],
      ['saved', t('savedPosts'), icon.bookmark],
      ['liked', t('likedPosts'), icon.heart],
    ];
    const tabs = this.tabs = h('div', { class: 'profile-tabs', role: 'tablist', 'aria-label': t('profileContent') },
      ...tabItems.map(([key, label, glyph]) => h('button', {
        class: 'profile-tab', type: 'button', role: 'tab', 'data-profile-tab': key,
        'aria-label': label, title: label, 'aria-controls': grid.id, 'aria-selected': String(this.activeTab === key),
        html: glyph, onclick: () => this.#selectTab(key),
      })));
    if (loading) this.#renderGrid([], { loading: true });
    else if (error || postsError) this.#renderGrid([], { message: profileText(postsError) || t('retry') });
    else this.#renderGrid();

    const profileAvatar = avatar({ ...profile, name: profileText(profile.name) }, 84);
    const avatarControl = this.own
      ? h('button', { class: 'profile-avatar-shortcut', type: 'button', 'aria-label': t('changeProfilePhoto'), onclick: () => this.#edit(profile, { openPicker: true }) },
        h('span', { class: `presence-avatar${presence.isOnline(profile.id) || presence.visible ? ' online' : ''}`, 'data-presence': profile.id },
          profileAvatar, h('i', { class: 'presence-dot', 'aria-hidden': 'true' })))
      : h('span', { class: `presence-avatar${presence.isOnline(profile.id) ? ' online' : ''}`, 'data-presence': profile.id },
        profileAvatar, h('i', { class: 'presence-dot', 'aria-hidden': 'true' }));
    const toolbar = h('div', { class: 'profile-toolbar', 'data-no-swipe': true },
      h('div', { class: 'profile-toolbar-group' },
        h('button', { class: 'profile-icon-btn', type: 'button', 'aria-label': t('back'), title: t('back'), onclick: () => this.close() }, '‹'),
        h('button', { class: 'profile-icon-btn', type: 'button', 'aria-label': t('followers'), title: t('followers'), html: icon.guests, onclick: () => this.hooks.openFollowers?.(profile) })),
      h('div', { class: 'profile-toolbar-group' },
        h('button', { class: 'profile-icon-btn', type: 'button', 'aria-label': t('share'), title: t('share'), html: icon.share, onclick: () => openShare({
          title: profileText(profile.name) || t('profile'),
          text: profileText(profile.bio),
          url: new URL(location.pathname, location.origin).href,
        }) }),
        this.own ? h('button', {
          class: 'profile-icon-btn profile-activity-btn', type: 'button',
          'aria-label': t('activity'), title: t('activity'),
          onclick: () => (this.hooks.openActivity || this.hooks.openFollowers)?.(profile, { mode: 'activity' }),
        }, h('span', { class: 'profile-icon-glyph', 'aria-hidden': 'true' }, '◷'),
        Number(requests) > 0 ? h('span', { class: 'profile-activity-count', 'aria-label': `${count(requests)} ${t('followRequests')}` }, count(requests)) : null) : null,
        this.own ? h('button', { class: 'profile-icon-btn nova-menu-btn', type: 'button', 'aria-label': t('menu'), title: t('menu'), html: icon.gear, onclick: () => this.hooks.openMenu?.(profile) }) : null,
        h('button', { class: 'profile-icon-btn profile-close-btn', type: 'button', 'aria-label': t('close'), title: t('close'), html: icon.close, onclick: () => this.close() })));
    const interests = Array.isArray(profile.interests)
      ? profile.interests.map(profileText).filter(Boolean)
      : profileText(profile.interests).split(/[,\n]/).map(value => value.trim()).filter(Boolean);
    this.content.replaceChildren(
      toolbar,
      h('div', { class: 'profile-head' },
        avatarControl,
        h('div', { class: 'profile-names' },
          h('b', {}, profileText(profile.name)),
          profileText(profile.username) ? h('span', { class: 'muted' }, `@${profileText(profile.username)}`) : null,
          profileText(profile.role || profile.status) ? h('small', { class: 'profile-role' }, profileText(profile.role || profile.status)) : null,
          profile.private ? h('small', { class: 'muted' }, `🔒 ${t('privateAccount')}`) : null,
          presence.isOnline(profile.id) || (this.own && presence.visible) ? h('small', { class: 'presence-label' }, t('activeNow')) : null)),
      profileText(profile.bio) ? h('p', { class: 'profile-bio' }, profileText(profile.bio)) : null,
      interests.length ? h('div', { class: 'profile-interests', 'aria-label': 'Interests' }, ...interests.map(value => h('span', {}, value))) : null,
      stats, actionsRow, tabs, grid);
  }

  #edit(profile, { openPicker = false, photo: initialPhoto = null } = {}) {
    this.mode = 'edit';
    clearInterval(this.usernameCooldownTimer);
    const name = h('input', { class: 'field', maxlength: '60', value: profileText(profile.name), placeholder: t('displayName'), required: true });
    const username = h('input', { class: 'field', maxlength: '20', value: profileText(profile.username), placeholder: t('username'), autocapitalize: 'off', spellcheck: 'false', required: true });
    const usernameStatus = h('small', { class: 'muted', role: 'status', 'aria-live': 'polite' });
    const usernameOriginal = profileText(profile.username).replace(/^@/, '').toLowerCase();
    const updatedAt = Date.parse(profile.usernameUpdatedAt || '');
    const cooldownExpiry = !profile.usernameAutoGenerated && Number.isFinite(updatedAt)
      ? updatedAt + USERNAME_COOLDOWN_MS : 0;
    const paintUsernameCooldown = () => {
      const remaining = Math.max(0, cooldownExpiry - Date.now());
      username.disabled = remaining > 0;
      if (remaining > 0) {
        const totalMinutes = Math.ceil(remaining / 60_000);
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        usernameStatus.textContent = `${t('usernameCooldown')} ${hours}h ${minutes}m.`;
      } else {
        usernameStatus.textContent = '';
        clearInterval(this.usernameCooldownTimer);
      }
    };
    paintUsernameCooldown();
    if (cooldownExpiry > Date.now()) this.usernameCooldownTimer = setInterval(paintUsernameCooldown, 1000);
    const bio = h('textarea', { class: 'field area', maxlength: '300', placeholder: t('bio') });
    bio.value = profileText(profile.bio);
    const message = h('p', { class: 'muted', role: 'status' });
    const photoInput = h('input', { type: 'file', accept: 'image/*,.heic,.heif', hidden: true });
    const photoPreview = h('div', { class: 'profile-photo-preview' }, avatar(profile, 72));
    let selectedPhoto = null;
    let previewUrl = '';
    let selectionVersion = 0;
    const choosePhoto = h('button', { class: 'pill-btn', type: 'button', onclick: () => {
      try { openFilePicker(photoInput); } catch (error) { message.textContent = profileText(error.message) || t('photoUnsupported'); }
    } }, t('choosePhoto'));
    const clearPreview = () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      previewUrl = '';
      photoPreview.replaceChildren(avatar(profile, 72));
    };
    const selectPhoto = async file => {
      if (!file) return;
      const version = ++selectionVersion;
      selectedPhoto = null;
      submit.disabled = true;
      choosePhoto.disabled = true;
      clearPreview();
      try {
        await validateProfilePhoto(file);
        if (version !== selectionVersion) return;
        previewUrl = URL.createObjectURL(file);
        selectedPhoto = file;
        photoPreview.replaceChildren(avatar({ ...profile, avatar: previewUrl }, 72));
        message.textContent = '';
      } catch (error) {
        if (version !== selectionVersion) return;
        photoInput.value = '';
        message.textContent = profileText(error?.message) || t('photoUnsupported');
      } finally {
        if (version === selectionVersion) {
          submit.disabled = false;
          choosePhoto.disabled = false;
        }
      }
    };
    photoInput.addEventListener('change', event => { void selectPhoto(event.currentTarget.files?.[0] || null); });
    const submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('save'));
    this.content.replaceChildren(h('form', { class: 'stack', onsubmit: async event => {
      event.preventDefault();
      const handle = username.value.trim().replace(/^@/, '');
      const normalizedHandle = handle.toLowerCase();
      const usernameChanged = normalizedHandle !== usernameOriginal;
      if (!handle || (usernameChanged && usernameValidationMessage(normalizedHandle))) {
        message.textContent = usernameValidationMessage(normalizedHandle) || t('usernameRule');
        return;
      }
      if (usernameChanged && cooldownExpiry > Date.now()) {
        paintUsernameCooldown();
        message.textContent = usernameStatus.textContent;
        return;
      }
      if (!auth.userId) { message.textContent = t('signInToContinue'); return; }
      if (submit.disabled) return;
      submit.disabled = true; choosePhoto.disabled = true; photoInput.disabled = true;
      message.textContent = selectedPhoto ? t('uploading') : t('loading');
      let uploadedPath = '';
      try {
        const sb = await supabase();
        if (usernameChanged && !(await usernameAvailable(sb, normalizedHandle, auth.userId))) {
          message.textContent = t('usernameTaken');
          submit.disabled = false; choosePhoto.disabled = false; photoInput.disabled = false;
          return;
        }
        let avatarUrl;
        if (selectedPhoto) {
          const optimized = await optimizeImage(selectedPhoto);
          selectedPhoto = optimized.full;
          const photoInfo = await identifyMediaFile(selectedPhoto);
          if (!['image/jpeg', 'image/png', 'image/webp'].includes(photoInfo.type)) throw new Error(t('photoUnsupported'));
          if (selectedPhoto.size > PROFILE_PHOTO_MAX_BYTES) throw new Error(t('photoTooLarge'));
          const extension = photoInfo.extension;
          uploadedPath = `milkyway/${auth.userId}/avatars/${crypto.randomUUID()}.${extension}`;
          const { error: uploadError } = await sb.storage.from('portfolio').upload(uploadedPath, selectedPhoto, {
            contentType: photoInfo.type,
            cacheControl: '3600',
            upsert: false,
          });
          if (uploadError) throw uploadError;
          const result = sb.storage.from('portfolio').getPublicUrl(uploadedPath);
          avatarUrl = result?.data?.publicUrl;
          if (!avatarUrl) throw new Error(t('photoUploadFailed'));
        }
        const changes = { display_name: name.value.trim(), username: normalizedHandle, bio: bio.value.trim() || null };
        if (avatarUrl) changes.avatar_url = avatarUrl;
        const { data: saved, error } = await sb.from('mw_profiles').update(changes).eq('id', auth.userId).select('id,display_name,username,avatar_url').maybeSingle();
        if (error) throw error;
        if (!saved) throw new Error(t('profileSettingsUnavailable'));
        if (avatarUrl && saved.avatar_url !== avatarUrl) throw new Error(t('profileSettingsUnavailable'));
        const updatedProfile = {
          id: saved.id,
          name: saved.display_name || name.value.trim(),
          username: saved.username || '',
          avatar: saved.avatar_url || '',
        };
        profiles.update(updatedProfile);
        clearInterval(this.usernameCooldownTimer);
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = '';
        toast('✓');
        this.#load(this.id);
      } catch (error) {
        if (uploadedPath) {
          try {
            const client = await supabase();
            const { error: cleanupError } = await client.storage.from('portfolio').remove([uploadedPath]);
            if (cleanupError) console.error('[profile] failed to clean up an unlinked photo upload', cleanupError);
          } catch (cleanupError) {
            console.error('[profile] failed to clean up an unlinked photo upload', cleanupError);
          }
        }
        const errorText = profileText(error?.message);
        if (/username.*reserved|reserved.*username/i.test(errorText)) message.textContent = t('usernameReserved');
        else if (/username.*72 hours|change.*72 hours/i.test(errorText)) message.textContent = `${t('usernameCooldownActive')}.`;
        else if (/username.*(duplicate|already exists)|duplicate key/i.test(errorText)) message.textContent = t('usernameTaken');
        else message.textContent = errorText || t('photoUploadFailed');
        submit.disabled = false; choosePhoto.disabled = false; photoInput.disabled = false;
      }
    } }, name, username, usernameStatus, bio,
    h('div', { class: 'stack profile-photo-edit' },
      h('label', { class: 'muted' }, t('profilePhoto')),
      photoPreview,
      choosePhoto,
      photoInput),
    submit, message,
    h('button', { class: 'link center', type: 'button', onclick: () => { clearInterval(this.usernameCooldownTimer); selectionVersion++; selectedPhoto = null; clearPreview(); this.#load(this.id); } }, t('cancel'))));
    if (initialPhoto) void selectPhoto(initialPhoto);
    else if (openPicker) {
      try { openFilePicker(photoInput); } catch (error) { message.textContent = profileText(error.message) || t('photoUnsupported'); }
    }
  }

}

function tile(post, { open, menu }) {
  const kind = postKind(post);
  const url = typeof post?.media_url === 'string' ? post.media_url : '';
  const caption = profileText(post?.caption);
  const node = h('div', { class: `profile-tile ${kind}`, role: 'button', tabindex: '0', 'data-post': String(post?.id || ''), 'aria-label': caption || t('post') });
  if (kind === 'video') {
    const still = poster(url, 360);
    if (still) {
      const img = h('img', { alt: '', loading: 'lazy', decoding: 'async', draggable: 'false' });
      setImage(img, still, 360, { quality: 60, onFail: () => { img.remove(); node.classList.add('missing'); } });
      node.append(img);
    } else {
      node.classList.add('missing');
      node.append(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '▶'));
    }
    node.append(h('span', { class: 'tile-badge', html: icon.play, 'aria-hidden': 'true' }));
  } else if (kind === 'image') {
    const img = h('img', { alt: caption, loading: 'lazy', decoding: 'async', draggable: 'false' });
    const preview = Array.isArray(post.media_preview_items) ? post.media_preview_items[0] || url : url;
    setImage(img, preview, 360, { quality: 65, onFail: () => { node.classList.add('missing'); img.remove(); node.prepend(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '🖼')); } });
    node.append(img);
  } else {
    node.append(h('p', {}, caption.slice(0, 140)));
  }
  const rawViews = post?.view_count ?? post?.viewCount ?? post?.views;
  const views = Number(rawViews);
  if (rawViews !== undefined && rawViews !== null && rawViews !== '' && Number.isFinite(views) && views >= 0) {
    node.append(h('span', { class: 'tile-badge tile-views', 'aria-label': `${count(views)} ${t('viewCount')}` },
      h('span', { html: icon.eye }), count(views)));
  }
  if (post.scheduled_at && Date.parse(post.scheduled_at) > Date.now()) {
    node.append(h('span', { class: 'mw-profile-scheduled' }, t('studioScheduled')));
  }
  if (menu) {
    node.append(h('button', { class: 'tile-more', type: 'button', 'aria-label': t('postOptions'), onclick: event => { event.stopPropagation(); menu(); } }, '⋯'));
  }
  node.addEventListener('click', open);
  node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  return node;
}
