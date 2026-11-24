// Create photo, slideshow, video or text posts. All slideshow assistance runs locally on the device.
import { t } from '../core/i18n.js';
import { auth, supabase } from '../core/net.js';
import { identifyMediaFile, openFilePicker } from '../core/media-files.js';
import { createVideoPreview, optimizeImage, optimizeVideo, yieldToBrowser } from '../core/media-optimizer.js';
import { profiles } from '../data/profiles.js';
import { feed } from '../data/feed.js';
import { Sheet } from './sheet.js';
import { h, toast } from './dom.js';

const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;
const MAX_AUDIO = 25 * 1024 * 1024;
const MAX_PHOTOS = 8;

async function mapConcurrent(items, limit, run) {
  const results = new Array(items.length);
  let next = 0;
  let failure;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failure && next < items.length) {
      const index = next++;
      try { results[index] = await run(items[index], index); }
      catch (error) { failure ||= error; }
    }
  }));
  if (failure) throw failure;
  return results;
}

function publishError(error, phase) {
  const message = String(error?.message || error || '');
  const code = String(error?.code || '');
  if (/failed to fetch|networkerror|load failed|network request failed|timeout|timed out/i.test(message)) {
    return `${t('postNetworkFailed')} (${phase}): ${message || t('retry')}`;
  }
  if (code === 'PGRST204' || /schema cache|column .*mw_posts|could not find the .*column/i.test(message)) {
    return `${t('postSchemaFailed')} ${message}`;
  }
  if (code === '42501' || /row-level security|not allowed|permission denied/i.test(message)) {
    return `${t('postPermissionFailed')} (${phase}): ${message || t('retry')}`;
  }
  if (code === '23502' || code === '23514' || /not-null constraint|check constraint/i.test(message)) {
    return `${t('postFieldFailed')} ${message}`;
  }
  return `${t('postPublishFailed')} (${phase}): ${message || t('retry')}`;
}

export class ComposeSheet {
  constructor({ onPublished } = {}) {
    this.onPublished = onPublished;
    this.sheet = new Sheet({ title: t('newPost'), className: 'compose-sheet', onClose: () => { this.#releaseMedia(); this.#pickAudio(null); } });
    this.files = [];
    this.mediaSelection = 0;
    this.audioSelection = 0;
    this.mediaPending = false;
    this.audioPending = false;
    this.publishing = false;
    this.preview = h('div', { class: 'compose-preview' });
    this.mediaInput = h('input', { type: 'file', accept: 'image/*,video/*,.heic,.heif,.mov,.m4v,.3gp', multiple: true, hidden: true, onchange: () => { void this.#pickMedia([...(this.mediaInput.files || [])]); } });
    this.audioInput = h('input', { type: 'file', accept: 'audio/*,.m4a,.aac,.wav,.ogg,.opus,.mp3', hidden: true, onchange: () => { void this.#pickAudio(this.audioInput.files?.[0] || null); } });
    this.caption = h('textarea', { class: 'field area', maxlength: '2200', placeholder: t('captionPlaceholder') });
    this.style = h('select', { class: 'field', 'aria-label': t('slideshowStyle') },
      h('option', { value: 'fade' }, t('styleFade')),
      h('option', { value: 'zoom' }, t('styleZoom')),
      h('option', { value: 'cinema' }, t('styleCinema')),
      h('option', { value: 'page' }, t('stylePage')),
      h('option', { value: 'slide' }, t('styleSlide')));
    this.assist = h('button', { class: 'pill-btn', type: 'button', onclick: () => this.#autoStyle() }, t('autoStyle'));
    this.audioPreview = h('div', { class: 'compose-audio-preview' });
    this.scheduleToggle = h('input', { type: 'checkbox', class: 'lc-switch', role: 'switch', onchange: () => this.#paintSchedule() });
    this.scheduleDate = h('input', { class: 'field', type: 'datetime-local', hidden: true, 'aria-label': t('studioScheduleTime') });
    this.message = h('p', { class: 'muted', role: 'status' });
    this.submit = h('button', { class: 'pill-btn hot wide', type: 'submit' }, t('publish'));
    this.sheet.body.append(h('form', { class: 'stack', onsubmit: event => { event.preventDefault(); this.#publish(); } },
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => this.#openPicker(this.mediaInput) }, t('choosePhotosOrVideo')),
      this.mediaInput, this.preview,
      h('div', { class: 'compose-assist' }, this.assist, this.style),
      h('button', { class: 'pill-btn wide', type: 'button', onclick: () => this.#openPicker(this.audioInput) }, t('attachAudio')),
      this.audioInput, this.audioPreview,
      h('label', { class: 'lc-toggle nova-toggle' }, h('span', {}, t('studioSchedulePost'), h('small', { class: 'muted' }, t('studioScheduleHint'))), this.scheduleToggle),
      this.scheduleDate,
      this.caption, this.submit, this.message));
  }

  open() {
    this.message.textContent = '';
    this.scheduleToggle.checked = false;
    this.scheduleDate.value = '';
    const earliest = new Date(Date.now() + 5 * 60 * 1000);
    earliest.setSeconds(0, 0);
    const latest = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    this.scheduleDate.min = new Date(earliest.getTime() - earliest.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    this.scheduleDate.max = new Date(latest.getTime() - latest.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    this.#paintSchedule();
    this.sheet.open();
  }

  #paintSchedule() {
    this.scheduleDate.hidden = !this.scheduleToggle.checked;
    this.submit.textContent = this.scheduleToggle.checked ? t('studioSchedulePost') : t('publish');
  }

  #openPicker(input) {
    try { openFilePicker(input); }
    catch (error) { this.message.textContent = error?.message || t('mediaPickerUnavailable'); }
  }

  #releaseMedia(invalidate = true) {
    if (invalidate) {
      this.mediaSelection++;
      this.mediaPending = false;
    }
    for (const entry of this.files) URL.revokeObjectURL(entry.url);
    this.files = [];
  }

  async #pickMedia(files) {
    const selection = ++this.mediaSelection;
    this.#releaseMedia(false);
    this.mediaPending = false;
    if (!this.publishing && !this.audioPending) this.submit.disabled = false;
    this.mediaInput.value = '';
    this.preview.replaceChildren();
    if (!files.length) return;
    this.message.textContent = t('loading');
    this.mediaPending = true;
    this.submit.disabled = true;
    let entries;
    try {
      entries = await Promise.all(files.map(async file => ({ file, ...(await identifyMediaFile(file)) })));
    } catch (error) {
      if (selection === this.mediaSelection) this.message.textContent = error?.message || t('mediaType');
      return;
    } finally {
      if (selection === this.mediaSelection) {
        this.mediaPending = false;
        if (!this.publishing && !this.audioPending) this.submit.disabled = false;
      }
    }
    if (selection !== this.mediaSelection) return;
    const videos = entries.filter(entry => entry.kind === 'video');
    if (entries.some(entry => entry.kind === 'unknown' || entry.kind === 'audio')) { this.message.textContent = t('mediaType'); return; }
    if (videos.length && (files.length > 1 || videos.length > 1)) { this.message.textContent = t('oneVideoOnly'); return; }
    if (files.length > MAX_PHOTOS) { this.message.textContent = t('slideshowPhotoLimit'); return; }
    const video = videos.length === 1;
    for (const entry of entries) {
      if ((!video && entry.kind !== 'image') || (video && entry !== videos[0])) { this.message.textContent = t('mediaType'); return; }
      if (entry.file.size > (video ? MAX_VIDEO : MAX_IMAGE)) { this.message.textContent = video ? t('videoTooBig') : t('imageTooBig'); return; }
    }
    try {
      this.files = entries.map(entry => ({ ...entry, url: URL.createObjectURL(entry.file) }));
    } catch (error) {
      this.#releaseMedia(false);
      this.message.textContent = error?.message || t('mediaPickerUnavailable');
      return;
    }
    this.message.textContent = '';
    for (const [index, entry] of this.files.entries()) {
      const media = video
        ? h('video', { src: entry.url, controls: true, playsinline: true, muted: true, preload: 'metadata' })
        : h('img', { src: entry.url, alt: `${t('slide')} ${index + 1}` });
      this.preview.append(h('div', { class: 'compose-photo' }, media,
        h('span', { class: 'compose-photo-index' }, String(index + 1)),
        h('button', { class: 'link', type: 'button', 'aria-label': `${t('remove')} ${index + 1}`, onclick: () => this.#removePhoto(index) }, t('remove'))));
    }
    if (!video && files.length > 1) this.preview.prepend(h('small', { class: 'muted compose-count' }, `${files.length} ${t('photosInSlideshow')}`));
  }

  #removePhoto(index) {
    const [removed] = this.files.splice(index, 1);
    if (removed) URL.revokeObjectURL(removed.url);
    this.#pickMedia(this.files.map(entry => entry.file));
  }

  async #pickAudio(file) {
    const selection = ++this.audioSelection;
    this.audioPending = false;
    if (!this.publishing && !this.mediaPending) this.submit.disabled = false;
    if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
    this.audioFile = null;
    this.audioUrl = null;
    this.audioInput.value = '';
    this.audioPreview.replaceChildren();
    if (!file) return;
    this.audioPending = true;
    this.submit.disabled = true;
    let info;
    try { info = await identifyMediaFile(file); }
    catch (error) {
      if (selection === this.audioSelection) this.message.textContent = error?.message || t('audioFileOnly');
      return;
    } finally {
      if (selection === this.audioSelection) {
        this.audioPending = false;
        if (!this.publishing && !this.mediaPending) this.submit.disabled = false;
      }
    }
    if (selection !== this.audioSelection) return;
    if (info.kind !== 'audio') { this.message.textContent = t('audioFileOnly'); return; }
    if (file.size > MAX_AUDIO) { this.message.textContent = t('audioTooBig'); return; }
    this.audioFile = file;
    try { this.audioUrl = URL.createObjectURL(file); }
    catch (error) {
      this.audioFile = null;
      this.message.textContent = error?.message || t('mediaPickerUnavailable');
      return;
    }
    this.audioPreview.append(h('audio', { src: this.audioUrl, controls: true, preload: 'metadata' }),
      h('button', { class: 'link', type: 'button', onclick: () => this.#pickAudio(null) }, t('remove')));
    this.message.textContent = '';
  }

  async #autoStyle() {
    if (this.files.length < 2 || this.files.some(entry => entry.kind !== 'image')) {
      this.message.textContent = t('pickSlideshowFirst');
      return;
    }
    let portraitCount = 0;
    try {
      for (const { file } of this.files) {
        const bitmap = await createImageBitmap(file);
        if (bitmap.height > bitmap.width * 1.15) portraitCount++;
        bitmap.close();
      }
    } catch (error) {
      console.warn('[compose] slideshow style analysis unavailable', error);
    }
    this.style.value = this.files.length >= 5 || portraitCount >= Math.ceil(this.files.length / 2) ? 'slide' : 'page';
    this.message.textContent = t('autoStyleApplied');
  }

  async #upload(sb, file, storagePath = '') {
    const fileName = String(file?.name || 'media');
    const name = fileName.replace(/[^a-zA-Z0-9._-]/g, '-').slice(-100) || 'media';
    try {
      const info = await identifyMediaFile(file);
      if (info.kind === 'unknown' || !info.type) throw new Error(t('mediaType'));
      const path = storagePath || `milkyway/${auth.userId}/${Date.now()}-${crypto.randomUUID()}-${name}`;
      const uploaded = await sb.storage.from('portfolio').upload(path, file, {
        contentType: info.type,
        cacheControl: '3600',
        upsert: false,
      });
      if (uploaded.error) throw uploaded.error;
      const publicUrl = sb.storage.from('portfolio').getPublicUrl(path)?.data?.publicUrl;
      if (!publicUrl) throw new Error('Supabase Storage did not return a public URL.');
      return { url: publicUrl, path };
    } catch (error) {
      throw Object.assign(new Error(error?.message || String(error)), {
        cause: error,
        code: error?.code,
        statusCode: error?.statusCode,
        publishPhase: `uploading ${name}`,
      });
    }
  }

  async #publish() {
    if (this.publishing) return;
    if (this.mediaPending || this.audioPending) { this.message.textContent = t('loading'); return; }
    const caption = this.caption.value.trim();
    if (!caption && !this.files.length) { this.message.textContent = t('writeOrPick'); return; }
    if (!auth.signedIn()) { this.message.textContent = t('signInToContinue'); return; }
    let scheduledAt = null;
    if (this.scheduleToggle.checked) {
      const scheduledTime = Date.parse(this.scheduleDate.value);
      const earliest = Date.now() + 5 * 60 * 1000;
      const latest = Date.now() + 365 * 24 * 60 * 60 * 1000;
      if (!Number.isFinite(scheduledTime) || scheduledTime < earliest || scheduledTime > latest) {
        this.message.textContent = t('studioScheduleInvalid');
        return;
      }
      scheduledAt = new Date(scheduledTime).toISOString();
    }
    this.publishing = true;
    this.submit.disabled = true; this.message.textContent = t('uploading');
    let phase = 'connecting to Supabase';
    try {
      const sb = await supabase();
      const video = this.files[0]?.kind === 'video';
      phase = 'uploading post media';
      const mediaItems = [];
      const mediaPreviewItems = [];
      let media_url = null;
      if (video) {
        const selectedVideo = this.files[0].file;
        this.message.textContent = t('optimizingMedia');
        await yieldToBrowser();
        const videoFile = await optimizeVideo(selectedVideo, { onProgress: progress => {
          this.message.textContent = `${t('optimizingMedia')} ${progress}%`;
        } });
        this.message.textContent = t('uploading');
        const [uploaded, posterFile] = await Promise.all([
          this.#upload(sb, videoFile),
          createVideoPreview(videoFile),
        ]);
        media_url = uploaded.url;
        if (posterFile) {
          try { await this.#upload(sb, posterFile, `${uploaded.path}.poster.jpg`); }
          catch (error) { console.warn('[compose] video poster upload failed; the video will still publish', error); }
        }
      } else {
        const uploadedPhotos = await mapConcurrent(this.files, 2, async ({ file }, index) => {
          this.message.textContent = `${t('optimizingMedia')} ${index + 1}/${this.files.length}`;
          await yieldToBrowser();
          const optimized = await optimizeImage(file);
          const [uploaded, preview] = await Promise.all([
            this.#upload(sb, optimized.full),
            optimized.preview ? this.#upload(sb, optimized.preview).catch(error => {
              console.warn('[compose] photo preview upload failed; using the compressed photo in the feed', error);
              return null;
            }) : Promise.resolve(null),
          ]);
          return { uploaded, preview };
        });
        for (const { uploaded, preview } of uploadedPhotos) {
          mediaItems.push(uploaded.url);
          mediaPreviewItems.push(preview?.url || uploaded.url);
          media_url ||= uploaded.url;
        }
      }
      phase = 'uploading background audio';
      const audioUpload = this.audioFile ? await this.#upload(sb, this.audioFile) : null;
      const audio_url = audioUpload?.url || null;
      const media_type = video ? 'video' : media_url ? 'image' : null;
      const author_name = profiles.peek(auth.userId)?.name || auth.name;
      phase = 'saving post details';
      const { data: savedPost, error } = await sb.from('mw_posts').insert({
        author_id: auth.userId, author_name, caption: caption || null, media_url, media_type,
        media_items: mediaItems, media_preview_items: mediaPreviewItems, audio_url, slideshow_style: this.style.value,
        scheduled_at: scheduledAt,
      }).select('id,author_id,created_at').single();
      if (error) throw error;
      if (!savedPost?.id || savedPost.author_id !== auth.userId) {
        throw new Error('Supabase did not return the saved post.');
      }
      this.caption.value = ''; this.#releaseMedia(); this.#pickAudio(null);
      this.preview.replaceChildren(); this.message.textContent = '';
      this.sheet.close();
      toast(scheduledAt ? t('studioScheduledSuccess') : t('published'));
      this.scheduleToggle.checked = false;
      this.scheduleDate.value = '';
      this.#paintSchedule();
      for (const scope of ['foryou', 'following']) feed(scope).refresh().catch(() => {});
      this.onPublished?.();
    } catch (error) {
      const failedPhase = error?.publishPhase || phase;
      console.error('[compose] post publication failed', { phase: failedPhase, error });
      this.message.textContent = publishError(error, failedPhase);
    } finally {
      this.publishing = false;
      this.submit.disabled = false;
    }
  }
}
