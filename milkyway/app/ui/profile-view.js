// Profile ("Nova" tab for the signed-in user, or any author tapped in the feed / Lives).
// Header, counts and posts come from Supabase as the caller, so row-level security decides what is visible.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
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

const quiet = promise => Promise.resolve(promise).then(result => result, () => ({}));

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
  constructor({ requireLogin, openCreate, openComments, openMenu, openChat }) {
    this.hooks = { requireLogin, openCreate, openComments, openMenu, openChat };
    this.sheet = new Sheet({ title: t('me'), className: 'profile-sheet' });
    this.content = h('div', { class: 'profile' });
    this.sheet.body.append(this.content);
    this.token = 0;
    this.posts = [];
    this.viewer = null;
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
    const index = this.posts.indexOf(post);
    if (index >= 0) this.#viewer().open(this.posts, index, { own: this.own });
  }

  #removed(post) {
    const at = this.posts.indexOf(post);
    if (at >= 0) this.posts.splice(at, 1);
    this.grid?.querySelector(`[data-post="${CSS.escape(String(post.id))}"]`)?.remove();
    if (this.postCount) this.postCount.textContent = count(this.posts.length);
    if (this.grid && !this.posts.length) this.grid.replaceChildren(h('p', { class: 'muted center' }, this.own ? t('noPostsYet') : t('empty')));
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
        message.textContent = error?.message || t('deleteFailed');
      }
    };
    this.menu.body.replaceChildren(h('div', { class: 'stack' },
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => { this.menu.close(); this.#openPost(post); } }, t('openPost')),
      remove, message,
      h('button', { class: 'link center', type: 'button', onclick: () => this.menu.close() }, t('cancel'))));
    this.menu.open();
  }

  /** person: { id, name, username, avatar } or null for the signed-in user. */
  open(person = null, { photo = null } = {}) {
    const id = String(person?.id || auth.userId || '');
    if (!id) return;
    this.pendingPhoto = photo;
    this.id = id;
    this.own = id === auth.userId;
    this.sheet.title = this.own ? t('me') : (person?.name || profiles.peek(id)?.name || t('profile'));
    this.#render({ profile: person || profiles.peek(id) || { id, name: this.own ? auth.name : '' }, loading: true });
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
      const [profile, followers, following, posts] = await Promise.all([
        quiet(sb.from('mw_profiles').select('*').eq('id', id).maybeSingle()),
        quiet(sb.from('mw_follows').select('follower_id', head).eq('following_id', id)),
        quiet(sb.from('mw_follows').select('following_id', head).eq('follower_id', id)),
        quiet(loadProfilePosts(sb, id)),
      ]);
      if (token !== this.token) return;
      const row = profile.data || {};
      const person = { id, name: row.display_name || profiles.peek(id)?.name || (this.own ? auth.name : 'MilkyWay'), username: row.username || '', avatar: row.avatar_url || '', bio: row.bio || '', private: Boolean(row.is_private) };
      profiles.prime([{ id, name: person.name, username: person.username, avatar: person.avatar }]);
      if (!this.own) this.sheet.title = person.name;
      const { data: pin } = await quiet(sb.from('mw_creator_pins').select('post_id').eq('creator_id', id).maybeSingle());
      const profilePosts = Array.isArray(posts.data) ? posts.data : [];
      if (pin?.post_id) profilePosts.sort((a, b) => Number(b.id === pin.post_id) - Number(a.id === pin.post_id));
      const renderData = {
        profile: person,
        followers: followers.count || 0,
        following: following.count || 0,
        posts: profilePosts,
        postsError: posts.error?.message || '',
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
        h('p', { class: 'muted', role: 'status' }, `${t('studioServiceUnavailable')}: ${error?.message || t('retry')}`));
    }
    if (token === this.token && this.mode === 'profile' && section) this.content.append(section);
  }

  #profileService(service, profile) {
    const card = h('article', { class: 'mw-studio-service-card' },
      h('div', {}, h('small', { class: 'mw-studio-eyebrow' }, service.category),
        h('h4', {}, service.title), h('p', { class: 'muted' }, service.description),
        service.pricing ? h('b', { class: 'mw-studio-price' }, service.pricing) : null));
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
          note.textContent = error?.message || t('retry');
          submit.disabled = false;
        }
      } }, preferredAt, inquiryText, submit, note);
      card.replaceChildren(card.firstElementChild, form);
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } }, t('studioRequestService'));
    card.append(button);
    return card;
  }

  #render({ profile, followers = 0, following = 0, posts = [], loading = false, error = false, postsError = '' }) {
    profile = profile && typeof profile === 'object' ? profile : { id: this.id || auth.userId || '' };
    this.posts = Array.isArray(posts) ? posts.filter(post => post && typeof post === 'object') : [];
    this.postCount = h('b', {}, count(this.posts.length));
    const stats = h('div', { class: 'profile-stats' },
      h('span', {}, this.postCount, t('posts')),
      h('span', {}, h('b', {}, count(followers)), t('followers')),
      h('span', {}, h('b', {}, count(following)), t('followingCount')));
    const actionsRow = h('div', { class: 'profile-actions' });
    if (this.own) {
      actionsRow.append(
        h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#edit(profile) }, t('editProfile')),
        h('button', { class: 'pill-btn hot', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openCreate(); } }, t('create')),
        h('button', { class: 'pill-btn nova-menu-btn', type: 'button', 'aria-label': t('menu'), onclick: () => this.hooks.openMenu?.(profile) }, h('span', { html: icon.gear }), t('menu')));
      // Owner-only gold Admin button (shown at once for the owner email; the server checks again on every action).
      if (isOwnerAccount() && !actionsRow.querySelector('.nova-admin-btn')) {
        actionsRow.append(h('button', { class: 'pill-btn nova-admin-btn', type: 'button', onclick: () => {
          this.sheet.close();
          import('./admin-view.js').then(m => (ProfileView.admin ||= new m.AdminView()).open());
        } }, '🛡 Admin'));
      }
    } else if (auth.signedIn()) {
      const button = h('button', { class: 'pill-btn hot', type: 'button' });
      const paint = () => { const on = profiles.isFollowing(profile.id); button.textContent = on ? t('following') : t('follow'); button.classList.toggle('hot', !on); button.setAttribute('aria-pressed', String(on)); };
      button.onclick = () => {
        const on = !profiles.isFollowing(profile.id);
        actions.follow(profile.id, on).catch(() => toast(t('queued')));
        paint();
      };
      paint();
      actionsRow.append(button,
        h('button', { class: 'pill-btn', type: 'button', onclick: () => { this.sheet.close(); this.hooks.openChat?.(profile); } }, h('span', { html: icon.inbox }), t('inbox')));
    } else {
      actionsRow.append(h('button', { class: 'pill-btn hot', type: 'button', onclick: () => this.hooks.requireLogin() }, t('follow')));
    }

    const grid = this.grid = h('div', { class: 'profile-grid' });
    if (loading) grid.append(h('p', { class: 'muted center' }, t('loading')));
    else if (error || postsError) grid.append(h('p', { class: 'muted center', role: 'status' }, postsError || t('retry')));
    else if (!this.posts.length) grid.append(h('p', { class: 'muted center' }, this.own ? t('noPostsYet') : t('empty')));
    else grid.append(...this.posts.map(post => tile(post, {
      open: () => this.#openPost(post),
      menu: this.own ? () => this.#postMenu(post) : null,
    })));

    const profileAvatar = avatar(profile, 84);
    const avatarControl = this.own
      ? h('button', { class: 'profile-avatar-shortcut', type: 'button', 'aria-label': t('changeProfilePhoto'), onclick: () => this.#edit(profile, { openPicker: true }) },
        h('span', { class: `presence-avatar${presence.isOnline(profile.id) || presence.visible ? ' online' : ''}`, 'data-presence': profile.id },
          profileAvatar, h('i', { class: 'presence-dot', 'aria-hidden': 'true' })))
      : h('span', { class: `presence-avatar${presence.isOnline(profile.id) ? ' online' : ''}`, 'data-presence': profile.id },
        profileAvatar, h('i', { class: 'presence-dot', 'aria-hidden': 'true' }));
    this.content.replaceChildren(
      h('div', { class: 'profile-head' },
        avatarControl,
        h('div', { class: 'profile-names' },
          h('b', {}, profile.name || ''),
          profile.username ? h('span', { class: 'muted' }, `@${profile.username}`) : null,
          profile.private ? h('small', { class: 'muted' }, `🔒 ${t('privateAccount')}`) : null,
          presence.isOnline(profile.id) || (this.own && presence.visible) ? h('small', { class: 'presence-label' }, t('activeNow')) : null)),
      profile.bio ? h('p', { class: 'profile-bio' }, profile.bio) : null,
      stats, actionsRow, grid);
  }

  #edit(profile, { openPicker = false, photo: initialPhoto = null } = {}) {
    this.mode = 'edit';
    const name = h('input', { class: 'field', maxlength: '60', value: profile.name || '', placeholder: t('displayName'), required: true });
    const username = h('input', { class: 'field', maxlength: '30', value: profile.username || '', placeholder: t('username'), autocapitalize: 'off', spellcheck: 'false' });
    const bio = h('textarea', { class: 'field area', maxlength: '300', placeholder: t('bio') });
    bio.value = profile.bio || '';
    const message = h('p', { class: 'muted', role: 'status' });
    const photoInput = h('input', { type: 'file', accept: 'image/*,.heic,.heif', hidden: true });
    const photoPreview = h('div', { class: 'profile-photo-preview' }, avatar(profile, 72));
    let selectedPhoto = null;
    let previewUrl = '';
    let selectionVersion = 0;
    const choosePhoto = h('button', { class: 'pill-btn', type: 'button', onclick: () => {
      try { openFilePicker(photoInput); } catch (error) { message.textContent = error.message || t('photoUnsupported'); }
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
        message.textContent = error?.message || t('photoUnsupported');
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
      if (handle && !/^[A-Za-z0-9._]{2,30}$/.test(handle)) { message.textContent = t('usernameRule'); return; }
      if (!auth.userId) { message.textContent = t('signInToContinue'); return; }
      if (submit.disabled) return;
      submit.disabled = true; choosePhoto.disabled = true; photoInput.disabled = true;
      message.textContent = selectedPhoto ? t('uploading') : t('loading');
      let uploadedPath = '';
      try {
        const sb = await supabase();
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
        const changes = { display_name: name.value.trim(), username: handle || null, bio: bio.value.trim() || null };
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
        message.textContent = error?.message || t('photoUploadFailed');
        submit.disabled = false; choosePhoto.disabled = false; photoInput.disabled = false;
      }
    } }, name, username, bio,
    h('div', { class: 'stack profile-photo-edit' },
      h('label', { class: 'muted' }, t('profilePhoto')),
      photoPreview,
      choosePhoto,
      photoInput),
    submit, message,
    h('button', { class: 'link center', type: 'button', onclick: () => { selectionVersion++; selectedPhoto = null; clearPreview(); this.#load(this.id); } }, t('cancel'))));
    if (initialPhoto) void selectPhoto(initialPhoto);
    else if (openPicker) {
      try { openFilePicker(photoInput); } catch (error) { message.textContent = error.message || t('photoUnsupported'); }
    }
  }

}

function tile(post, { open, menu }) {
  const kind = postKind(post);
  const url = typeof post?.media_url === 'string' ? post.media_url : '';
  const node = h('div', { class: `profile-tile ${kind}`, role: 'button', tabindex: '0', 'data-post': String(post?.id || ''), 'aria-label': post?.caption || t('post') });
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
    const img = h('img', { alt: post.caption || '', loading: 'lazy', decoding: 'async', draggable: 'false' });
    const preview = Array.isArray(post.media_preview_items) ? post.media_preview_items[0] || url : url;
    setImage(img, preview, 360, { quality: 65, onFail: () => { node.classList.add('missing'); img.remove(); node.prepend(h('span', { class: 'tile-missing', 'aria-hidden': 'true' }, '🖼')); } });
    node.append(img);
  } else {
    node.append(h('p', {}, (post.caption || '').slice(0, 140)));
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
